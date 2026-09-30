//! The wire format between the Rust sampler and the Tasma UI.
//!
//! Everything is camelCase for the frontend and every number is already in the unit
//! the UI prints (bytes, bytes/second, whole percent, milliseconds) so the UI never
//! has to guess what a value means.

use serde::{Deserialize, Serialize};

/// One complete observation of the machine.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Unix milliseconds when the sample was taken.
    pub ts: u64,
    /// Milliseconds since the previous sample; the window every rate is measured over.
    pub interval_ms: u64,
    pub host: HostInfo,
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub disks: Vec<DiskInfo>,
    pub networks: Vec<NetworkInfo>,
    pub gpus: Vec<GpuInfo>,
    pub processes: Vec<ProcessInfo>,
    pub counts: Counts,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub name: String,
    /// Marketing name, e.g. "Windows 11 Pro".
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub uptime_secs: u64,
    /// Unix seconds of the last boot.
    pub boot_time: u64,
    pub elevated: bool,
    /// Whether the process list includes processes owned by other users / sessions.
    pub sees_all_users: bool,
    pub logical_cores: usize,
    pub physical_cores: Option<usize>,
    pub total_memory: u64,
    /// Tasma's own pid, so the UI can mark (and refuse to kill) itself.
    pub self_pid: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub brand: String,
    pub vendor: String,
    pub logical: usize,
    pub physical: Option<usize>,
    /// Whole-machine utilisation, 0-100.
    pub usage: f32,
    /// Per logical processor utilisation, 0-100 each.
    pub per_core: Vec<f32>,
    pub frequency_mhz: u64,
    /// Unix load average, when the platform reports one.
    pub load_avg: Option<[f64; 3]>,
    /// Busiest process this window, for the "why is it hot" note.
    pub top_process: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub free: u64,
    pub total_swap: u64,
    pub used_swap: u64,
    /// 0-100, matches the Task Manager "In use" figure closely enough to be useful.
    pub used_pct: f32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub name: String,
    pub mount_point: String,
    /// "SSD" / "HDD" / "Unknown", straight from the storage stack.
    pub kind: String,
    pub file_system: String,
    pub total: u64,
    pub available: u64,
    pub used: u64,
    pub used_pct: f32,
    pub removable: bool,
    /// Bytes/second since the previous sample.
    pub read_bps: f64,
    pub write_bps: f64,
    /// True for the volume Windows boots from.
    pub system: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub name: String,
    pub mac: String,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
    pub received_bps: f64,
    pub transmitted_bps: f64,
    pub total_received: u64,
    pub total_transmitted: u64,
    pub packets_in: u64,
    pub packets_out: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub name: String,
    /// Friendly name from the binary's version resource, when available.
    pub description: Option<String>,
    pub exe: Option<String>,
    pub user: String,
    pub session: Option<u32>,
    /// Percent of the whole machine over the last interval, 0-100.
    pub cpu: f32,
    /// Percent of a single logical core over the last interval; can exceed 100.
    pub cpu_per_core: f32,
    /// Working set in bytes.
    pub memory: u64,
    /// Committed private bytes.
    pub virtual_memory: u64,
    pub read_bps: f64,
    pub write_bps: f64,
    pub threads: Option<u32>,
    pub handles: Option<u32>,
    pub priority: Option<String>,
    pub status: String,
    /// Unix seconds the process started.
    pub start_time: u64,
    pub run_time_secs: u64,
    /// GPU engine utilisation, 0-100, when PDH reports it.
    pub gpu: Option<f32>,
}

/// A single process, expanded - only fetched when the user opens the detail drawer.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetail {
    pub pid: u32,
    pub cmd: Vec<String>,
    pub cwd: Option<String>,
    pub exe: Option<String>,
    pub description: Option<String>,
    pub root: Option<String>,
    pub user: String,
    pub environment_count: usize,
    pub open_files: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub processes: usize,
    /// Distinct friendly names - the closest thing Windows has to "apps".
    pub apps: usize,
    pub threads: u64,
    pub handles: u64,
    pub suspended: usize,
}

/// What every mutating command hands back so the UI can tell the user what happened
/// instead of silently failing (access denied is the common case on Windows).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionReport {
    pub ok: bool,
    pub message: String,
    /// Set when the action would probably work from an elevated Tasma.
    pub needs_elevation: bool,
}

/// A control operation the sampler keeps track of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlAction {
    Suspend,
    Resume,
    Terminate,
}

impl ActionReport {
    pub fn ok(message: impl Into<String>) -> Self {
        Self { ok: true, message: message.into(), needs_elevation: false }
    }

    pub fn failed(message: impl Into<String>, needs_elevation: bool) -> Self {
        Self { ok: false, message: message.into(), needs_elevation }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub tauri: String,
    pub rustc: String,
    pub profile: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    /// Dedicated video memory in bytes (0 for shared-memory adapters).
    pub vram: u64,
    pub shared: u64,
    pub vendor: String,
    pub software: bool,
    /// Busiest engine utilisation, 0-100, when the GPU Engine counters are readable.
    pub usage: Option<f32>,
    /// Which engine that number came from, e.g. "3D".
    pub usage_engine: Option<String>,
}
