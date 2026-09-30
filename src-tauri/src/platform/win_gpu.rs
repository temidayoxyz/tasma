//! GPU telemetry.
//!
//! Two independent sources, because neither one alone answers "what is the GPU
//! doing":
//!
//! * **DXGI** gives the adapter identity - name, vendor, dedicated and shared
//!   memory - which is what the card should say even on a machine where nothing is
//!   using the GPU.
//! * **PDH `GPU Engine` counters** give live utilisation per process, which is the
//!   same source the Task Manager reads. Instances look like
//!   `pid_1234_luid_0x00000000_0x0000BEEF_phys_0_eng_0_engtype_3D`, so utilisation
//!   is summed per pid and per engine.
//!
//! Everything degrades to `None` rather than guessing when a driver does not publish
//! those counters.

use std::collections::HashMap;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
    PDH_MORE_DATA,
};

use crate::model::GpuInfo;

pub const AVAILABLE: bool = true;

/// The wildcard counter the Task Manager reads for its GPU column.
const GPU_ENGINE_COUNTER: &str = "\\GPU Engine(*)\\Utilization Percentage";

/// `DXGI_ADAPTER_FLAG_SOFTWARE` from dxgi.h - WARP-style adapters that emulate
/// rather than own a GPU. Spelled out here so this module does not depend on which
/// `windows` submodule the generated bindings put it in.
const DXGI_ADAPTER_FLAG_SOFTWARE: u32 = 0x2;

pub struct GpuSampler {
    adapters: Vec<GpuInfo>,
    /// Every LUID DXGI reported for each adapter, in adapter order. Hybrid graphics
    /// enumerate one physical GPU once per output, and only some of those LUIDs ever
    /// show up in the performance counters, so an adapter is credited whenever any of
    /// its LUIDs reports load.
    luids: Vec<Vec<(i32, u32)>>,
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
    counter_ready: bool,
    per_process: HashMap<u32, f32>,
    /// Engine utilisation per adapter LUID, keyed by LUID then engine name.
    engines_by_adapter: HashMap<(i32, u32), HashMap<String, f32>>,
    primed: bool,
}

// The raw PDH handles inside are process-wide and are only ever touched while the
// collector's mutex is held, so moving the sampler between threads (which the
// sampler's `spawn_blocking` bridge does) cannot race with itself.
unsafe impl Send for GpuSampler {}

impl GpuSampler {
    pub fn new() -> Self {
        let enumerated = enumerate_adapters();
        let mut adapters = Vec::with_capacity(enumerated.len());
        let mut luids = Vec::with_capacity(enumerated.len());
        for (info, adapter_luids) in enumerated {
            adapters.push(info);
            luids.push(adapter_luids);
        }
        // Raw PDH handles: built explicitly instead of relying on a derived Default.
        let mut query = PDH_HQUERY(std::ptr::null_mut());
        let mut counter = PDH_HCOUNTER(std::ptr::null_mut());
        let mut counter_ready = false;

        unsafe {
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) == 0 {
                let path: Vec<u16> =
                    GPU_ENGINE_COUNTER.encode_utf16().chain(std::iter::once(0)).collect();
                if PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut counter) == 0 {
                    // GPU Engine counters need one collection before they have rates.
                    let _ = PdhCollectQueryData(query);
                    counter_ready = true;
                }
            }
        }

        Self {
            adapters,
            luids,
            query,
            counter,
            counter_ready,
            per_process: HashMap::new(),
            engines_by_adapter: HashMap::new(),
            primed: false,
        }
    }
}

impl GpuSampler {
    /// Refreshes utilisation and hands back the adapter list with usage filled in.
    pub fn sample(&mut self) -> Vec<GpuInfo> {
        self.per_process.clear();
        // Every known LUID gets an (empty) bucket so "idle" stays distinguishable from
        // "this driver does not publish counters".
        for adapter_luids in &self.luids {
            for luid in adapter_luids {
                self.engines_by_adapter.insert(*luid, HashMap::new());
            }
        }

        if self.counter_ready {
            unsafe {
                if PdhCollectQueryData(self.query) == 0 {
                    // A wildcard instance list only reports rates once there is a
                    // previous collection to difference against.
                    if !self.primed {
                        self.primed = true;
                    } else if let Some(items) = self.collect_items() {
                        self.absorb(&items);
                    }
                }
            }
        }

        let mut adapters = self.adapters.clone();
        if self.counter_ready {
            for (index, adapter) in adapters.iter_mut().enumerate() {
                // Merge the engines of every LUID this adapter owns, so the phantom
                // LUIDs hybrid graphics creates do not dilute or hide the real one.
                let mut merged: HashMap<String, f32> = HashMap::new();
                for luid in &self.luids[index] {
                    let Some(engines) = self.engines_by_adapter.get(luid) else {
                        continue;
                    };
                    for (engine, value) in engines {
                        *merged.entry(engine.clone()).or_insert(0.0) += *value;
                    }
                }

                match busiest(&merged) {
                    Some((engine, value)) => {
                        adapter.usage = Some(value.clamp(0.0, 100.0));
                        adapter.usage_engine = Some(engine);
                    }
                    None => {
                        // Counters exist and nothing was busy this interval.
                        adapter.usage = Some(0.0);
                        adapter.usage_engine = None;
                    }
                }
            }
        }
        adapters
    }

    /// GPU utilisation per pid, summed across every engine.
    pub fn per_process(&self) -> &HashMap<u32, f32> {
        &self.per_process
    }

    /// Adapter names paired with every LUID DXGI reported for them. Used by the probe
    /// when diagnosing why engine load is or is not attributed to an adapter.
    pub fn adapter_luids(&self) -> Vec<(String, Vec<(i32, u32)>)> {
        self.adapters
            .iter()
            .zip(self.luids.iter())
            .map(|(adapter, luids)| (adapter.name.clone(), luids.clone()))
            .collect()
    }

    /// Raw wildcard instance names, so a mis-parsed instance string is obvious rather
    /// than mysterious. `--probe --instances` prints these.
    pub fn instance_names(&mut self) -> Vec<String> {
        if !self.counter_ready {
            return Vec::new();
        }
        unsafe {
            let _ = PdhCollectQueryData(self.query);
        }
        // collect_items is unsafe because it reads into a PDH-owned buffer.
        unsafe { self.collect_items() }
            .map(|items| items.into_iter().map(|(_, name)| name).collect())
            .unwrap_or_default()
    }
}

/// The busiest engine on one adapter: the closest single number to "how loaded is
/// this GPU", with the engine name explaining what it is busy with.
fn busiest(engines: &HashMap<String, f32>) -> Option<(String, f32)> {
    engines
        .iter()
        .filter(|(name, _)| name.as_str() != "None")
        .max_by(|left, right| left.1.total_cmp(right.1))
        .map(|(name, usage)| (name.clone(), *usage))
}


impl GpuSampler {
    /// Reads the wildcard instance array. PDH requires the size first, then the
    /// buffer: the classic two-call dance.
    unsafe fn collect_items(&self) -> Option<Vec<(FmtItem, String)>> {
        let mut size = 0u32;
        let mut count = 0u32;
        let probe =
            PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
        if probe != PDH_MORE_DATA || size == 0 || count == 0 {
            return None;
        }

        // u64 backing store so the item array starts 8-byte aligned, as PDH expects.
        let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
        let items = buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        if PdhGetFormattedCounterArrayW(
            self.counter,
            PDH_FMT_DOUBLE,
            &mut size,
            &mut count,
            Some(items),
        ) != 0
        {
            return None;
        }

        // Copy out only what we need so the buffer's lifetime stays local.
        let slice = std::slice::from_raw_parts(items, count as usize);
        Some(
            slice
                .iter()
                .map(|item| {
                    let status = item.FmtValue.CStatus;
                    let value = item.FmtValue.Anonymous.doubleValue;
                    (FmtItem { status, value }, pwstr_to_string(item.szName))
                })
                .collect(),
        )
    }

    fn absorb(&mut self, items: &[(FmtItem, String)]) {
        for (item, name) in items {
            // PDH_CSTATUS_VALID_DATA is the only status that carries a real number.
            if item.status != 0 || !item.value.is_finite() || item.value <= 0.0 {
                continue;
            }
            let value = item.value as f32;
            if let Some(pid) = instance_pid(name) {
                *self.per_process.entry(pid).or_insert(0.0) += value;
            }
            if let (Some(luid), Some(engine)) = (instance_luid(name), instance_engine(name)) {
                *self
                    .engines_by_adapter
                    .entry(luid)
                    .or_default()
                    .entry(engine)
                    .or_insert(0.0) += value;
            }
        }
    }
}

/// Flattened PDH counter value: copying the status and the double keeps the raw union
/// out of the rest of the module.
struct FmtItem {
    status: u32,
    value: f64,
}

/**
 * Enumerates real adapters through DXGI - no WMI, no vendor SDK.
 *
 * Returns each adapter with every LUID DXGI reported for it. Hybrid graphics list one
 * physical GPU once per output, so identical descriptors are collapsed while their
 * LUIDs are merged onto the surviving row; otherwise a laptop with an integrated and a
 * discrete GPU would show four rows instead of two.
 */
fn enumerate_adapters() -> Vec<(GpuInfo, Vec<(i32, u32)>)> {
    let mut adapters: Vec<(GpuInfo, Vec<(i32, u32)>)> = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return adapters;
        };
        let mut index = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(index) {
            index += 1;
            let Ok(description) = adapter.GetDesc1() else {
                continue;
            };
            let name = String::from_utf16_lossy(&description.Description);
            let name = name.trim_end_matches('\0').trim().to_string();
            // The Microsoft Basic Render Driver is not a GPU anyone owns, and WARP
            // reports itself through the software flag.
            if name.is_empty()
                || name.contains("Microsoft Basic Render")
                || description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE != 0
            {
                continue;
            }
            let luid = (description.AdapterLuid.HighPart, description.AdapterLuid.LowPart);
            let vram = description.DedicatedVideoMemory as u64;
            let shared = description.SharedSystemMemory as u64;
            let duplicate = adapters.iter_mut().find(|(known, _)| {
                known.name == name && known.vram == vram && known.shared == shared
            });

            match duplicate {
                Some((_, known_luids)) => {
                    if !known_luids.contains(&luid) {
                        known_luids.push(luid);
                    }
                }
                None => adapters.push((
                    GpuInfo {
                        name,
                        vram,
                        shared,
                        vendor: vendor_name(description.VendorId).to_string(),
                        software: false,
                        usage: None,
                        usage_engine: None,
                    },
                    vec![luid],
                )),
            }
        }
    }
    adapters
}

fn vendor_name(vendor_id: u32) -> &'static str {
    match vendor_id {
        0x10DE => "NVIDIA",
        0x1002 | 0x1022 => "AMD",
        0x8086 => "Intel",
        0x1414 => "Microsoft",
        0x1AE0 => "Google",
        0x106B => "Apple",
        _ => "Unknown",
    }
}

/// `pid_1234_luid_0x00000000_0x0000BEEF_phys_0_eng_0_engtype_3D` -> 1234
fn instance_pid(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("pid_")?;
    let end = rest.find('_')?;
    rest[..end].parse().ok()
}

/// `pid_1234_luid_0x00000000_0x0000BEEF_...` -> (high, low) parts of the adapter LUID
fn instance_luid(name: &str) -> Option<(i32, u32)> {
    const KEY: &str = "luid_";
    let start = name.find(KEY)? + KEY.len();
    let (high, low) = name[start..].split_once('_')?;
    Some((
        i32::from_str_radix(high.trim_start_matches("0x"), 16).ok()?,
        u32::from_str_radix(low.trim_start_matches("0x"), 16).ok()?,
    ))
}

/// `..._engtype_3D` -> "3D"
fn instance_engine(name: &str) -> Option<String> {
    const KEY: &str = "engtype_";
    let start = name.find(KEY)? + KEY.len();
    let engine = name[start..].split('_').next().unwrap_or_default();
    if engine.is_empty() {
        None
    } else {
        Some(engine.to_string())
    }
}

/// NUL-terminated UTF-16 out of a raw PDH pointer.
fn pwstr_to_string(value: PWSTR) -> String {
    if value.0.is_null() {
        return String::new();
    }
    unsafe {
        let mut length = 0usize;
        while *value.0.add(length) != 0 {
            length += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(value.0 as *const u16, length))
    }
}

impl Drop for GpuSampler {
    fn drop(&mut self) {
        if self.counter_ready {
            unsafe {
                let _ = PdhCloseQuery(self.query);
            }
        }
    }
}


