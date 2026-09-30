//! The sampler.
//!
//! One `Collector` owns every piece of sampling state and produces a whole
//! `Snapshot` per tick, because rates are only meaningful when they come from the
//! same interval. Two decisions worth knowing about:
//!
//! * **Per-process CPU is computed here, not read from `Process::cpu_usage`.**
//!   `Process::accumulated_cpu_time` deltas over a known wall-clock window make the
//!   units unambiguous (percent of the whole machine, exactly how the Task Manager
//!   reports it) and make the arithmetic unit-testable.
//! * **Friendly names and handle counts are cached.** Reading a binary's version
//!   resource is not something to do for 400 processes every second.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sysinfo::{
    Disks, Networks, Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System, UpdateKind,
    Users,
};

use crate::model::*;
use crate::platform::{self, gpu};

/// Gives sysinfo a window to measure CPU against before the UI ever asks, so the
/// first snapshot is real instead of a row of zeros.
const PRIME_WINDOW: Duration = Duration::from_millis(150);

pub struct Collector {
    inner: Mutex<Inner>,
}

struct Inner {
    sys: System,
    nets: Networks,
    disks: Disks,
    users: Users,
    gpu: gpu::GpuSampler,
    /// pid -> accumulated CPU milliseconds at the previous tick.
    cpu_ms: HashMap<u32, u64>,
    last_wall_ms: u64,
    /// exe path (lowercased) -> FileDescription, computed once per unique binary.
    descriptions: HashMap<String, Option<String>>,
    /// Binaries seen but not yet read. Resolving a description is file I/O, so it is
    /// spread over several ticks instead of stalling the first one.
    pending: VecDeque<String>,
    /// Pids Tasma has suspended.
    ///
    /// Windows exposes no status field for thread suspension - a process frozen with
    /// `NtSuspendProcess` still reports as running everywhere, including in sysinfo -
    /// so the sampler remembers its own suspends rather than inventing a number.
    suspended: HashSet<u32>,
    ticks: u64,
    last: Snapshot,
}

/// One process exactly as sysinfo handed it over. Collected first, decorated second:
/// that keeps the (many) borrows in this file obvious instead of clever.
struct RawProcess {
    pid: u32,
    ppid: Option<u32>,
    name: String,
    exe: Option<String>,
    user: String,
    session: Option<u32>,
    cpu_ms: u64,
    memory: u64,
    virtual_memory: u64,
    read_bytes: u64,
    write_bytes: u64,
    status: ProcessStatus,
    start_time: u64,
    run_time: u64,
}

/// One GPU adapter paired with the LUIDs of its engine instances. Named so the
/// sampler's signatures stay readable.
pub type AdapterLuids = Vec<(String, Vec<(i32, u32)>)>;

impl Collector {
    pub fn new() -> Self {
        let mut inner = Inner {
            sys: System::new(),
            nets: Networks::new_with_refreshed_list(),
            disks: Disks::new_with_refreshed_list(),
            users: Users::new_with_refreshed_list(),
            gpu: gpu::GpuSampler::new(),
            cpu_ms: HashMap::new(),
            last_wall_ms: 0,
            descriptions: HashMap::new(),
            pending: VecDeque::new(),
            suspended: HashSet::new(),
            ticks: 0,
            last: Snapshot::default(),
        };
        // Two samples so the first thing the UI renders is already meaningful.
        inner.sample();
        std::thread::sleep(PRIME_WINDOW);
        inner.sample();
        Self { inner: Mutex::new(inner) }
    }
}

/// `Collector::new` is the only constructor, so this is exactly equivalent and keeps
/// clippy's new-without-default lint satisfied.
impl Default for Collector {
    fn default() -> Self {
        Self::new()
    }
}

impl Collector {
    /// Takes a fresh sample. Serialised: overlapping ticks would corrupt the deltas.
    pub fn sample(&self) -> Snapshot {
        match self.inner.lock() {
            Ok(mut inner) => inner.sample(),
            Err(poisoned) => poisoned.into_inner().sample(),
        }
    }

    pub fn last(&self) -> Snapshot {
        match self.inner.lock() {
            Ok(inner) => inner.last.clone(),
            Err(poisoned) => poisoned.into_inner().last.clone(),
        }
    }

    pub fn ticks(&self) -> u64 {
        match self.inner.lock() {
            Ok(inner) => inner.ticks,
            Err(poisoned) => poisoned.into_inner().ticks,
        }
    }

    /// Process control that keeps the sampler's picture in step with the machine.
    ///
    /// The platform call is the only thing that can actually change a process; this
    /// wrapper also records what Tasma suspended, which is the only way the status
    /// column can tell the truth on Windows.
    pub fn control(&self, pid: u32, action: ControlAction) -> Result<(), String> {
        let result = match action {
            ControlAction::Suspend => platform::suspend(pid),
            ControlAction::Resume => platform::resume(pid),
            ControlAction::Terminate => platform::terminate(pid),
        };
        if result.is_ok() {
            if let Ok(mut inner) = self.inner.lock() {
                match action {
                    ControlAction::Suspend => inner.suspended.insert(pid),
                    // A terminated process is gone; nothing left to resume.
                    ControlAction::Resume | ControlAction::Terminate => inner.suspended.remove(&pid),
                };
            }
        }
        result
    }

    /// GPU introspection for the probe: each adapter with its LUIDs, plus the raw
    /// performance-counter instance names. Shares the running sampler rather than
    /// opening a second PDH query.
    pub fn gpu_details(&self) -> (AdapterLuids, Vec<String>) {
        let Ok(mut inner) = self.inner.lock() else {
            return (Vec::new(), Vec::new());
        };
        (inner.gpu.adapter_luids(), inner.gpu.instance_names())
    }

    /// Everything the detail drawer shows for one process.
    pub fn detail(&self, pid: u32) -> Option<ProcessDetail> {
        let inner = self.inner.lock().ok()?;
        let process = inner.sys.process(Pid::from_u32(pid))?;
        let exe = process.exe().map(|path| path.display().to_string());
        let description = process
            .exe()
            .and_then(|path| inner.descriptions.get(&path_key(path)).cloned().flatten());
        Some(ProcessDetail {
            pid,
            cmd: process.cmd().iter().map(|part| part.to_string_lossy().to_string()).collect(),
            cwd: process.cwd().map(|path| path.display().to_string()),
            description,
            exe,
            root: process.root().map(|path| path.display().to_string()),
            user: process
                .user_id()
                .and_then(|uid| inner.users.get_user_by_id(uid))
                .map(|user| user.name().to_string())
                .unwrap_or_else(|| "\u{2014}".into()),
            environment_count: process.environ().len(),
            open_files: process.open_files().unwrap_or(0),
        })
    }
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_ascii_lowercase()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_millis() as u64).unwrap_or(0)
}

fn per_second(bytes: u64, interval_ms: u64) -> f64 {
    if interval_ms == 0 {
        return 0.0;
    }
    bytes as f64 * 1000.0 / interval_ms as f64
}

impl Inner {
    /// One complete observation, which also becomes the cached "last" snapshot.
    fn sample(&mut self) -> Snapshot {
        let wall_ms = now_ms();
        let interval_ms = if self.last_wall_ms == 0 {
            PRIME_WINDOW.as_millis() as u64
        } else {
            wall_ms.saturating_sub(self.last_wall_ms).max(1)
        };

        self.sys.refresh_memory();
        self.sys.refresh_cpu_all();
        // Only the columns Tasma actually renders are refreshed; asking sysinfo for
        // command lines or environments for 400 processes every second is wasted work.
        let kind = ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_disk_usage()
            .with_user(UpdateKind::OnlyIfNotSet)
            .with_exe(UpdateKind::OnlyIfNotSet);
        self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        self.nets.refresh(true);
        for disk in self.disks.list_mut() {
            disk.refresh();
        }

        let logical = self.sys.cpus().len().max(1);
        let raws = self.collect_processes();
        let threads = platform::thread_counts();
        let gpu_adapters = self.gpu.sample();
        let gpu_by_pid = self.gpu.per_process().clone();

        let mut processes = Vec::with_capacity(raws.len());
        for raw in raws {
            // Percentages come from CPU-time deltas over a known wall-clock window,
            // which is the only way to keep the units honest across processes that
            // started or stopped inside it.
            let previous = self.cpu_ms.insert(raw.pid, raw.cpu_ms);
            let delta = previous.map_or(0, |previous| raw.cpu_ms.saturating_sub(previous));
            let description = self.cached_description(raw.exe.as_deref());
            let (handles, priority) = platform::open_counters(raw.pid);

            processes.push(ProcessInfo {
                pid: raw.pid,
                ppid: raw.ppid,
                name: raw.name,
                description,
                exe: raw.exe,
                user: raw.user,
                session: raw.session,
                cpu: cpu_share(delta, interval_ms, logical),
                cpu_per_core: cpu_per_core(delta, interval_ms),
                memory: raw.memory,
                virtual_memory: raw.virtual_memory,
                read_bps: per_second(raw.read_bytes, interval_ms),
                write_bps: per_second(raw.write_bytes, interval_ms),
                threads: threads.get(&raw.pid).copied(),
                handles,
                priority: priority.map(str::to_string),
                status: if self.suspended.contains(&raw.pid) {
                    "Suspended".to_string()
                } else {
                    status_label(raw.status).to_string()
                },
                start_time: raw.start_time,
                run_time_secs: raw.run_time,
                gpu: gpu_by_pid.get(&raw.pid).map(|value| value.clamp(0.0, 100.0)),
            });
        }
        processes.sort_by(|left, right| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then(left.pid.cmp(&right.pid))
        });

        // Exit accounting: a pid that is gone must not keep a stale CPU time around,
        // otherwise a recycled pid would inherit a nonsense delta.
        let live: HashSet<u32> = processes.iter().map(|process| process.pid).collect();
        self.cpu_ms.retain(|pid, _| live.contains(pid));
        // A pid that has exited cannot still be suspended, and pids do get recycled.
        self.suspended.retain(|pid| live.contains(pid));

        // Reading version resources is file I/O; a handful per tick keeps the refresh
        // fast while the friendly names fill in over the first few seconds.
        self.resolve_descriptions();

        let snapshot = Snapshot {
            ts: wall_ms,
            interval_ms,
            host: self.host(),
            cpu: self.cpu(&processes),
            memory: self.memory(),
            disks: self.disks(interval_ms),
            networks: self.networks(interval_ms),
            gpus: gpu_adapters,
            counts: count_processes(&processes),
            processes,
        };

        self.last_wall_ms = wall_ms;
        self.ticks += 1;
        self.last = snapshot.clone();
        snapshot
    }

    /// Snapshot of every process, before any rate maths is applied.
    fn collect_processes(&self) -> Vec<RawProcess> {
        self.sys
            .processes()
            .values()
            .map(|process| {
                let usage = process.disk_usage();
                RawProcess {
                    pid: process.pid().as_u32(),
                    ppid: process.parent().map(|parent| parent.as_u32()),
                    name: process.name().to_string_lossy().to_string(),
                    exe: process.exe().map(|path| path.display().to_string()),
                    user: process
                        .user_id()
                        .and_then(|uid| self.users.get_user_by_id(uid))
                        .map(|user| user.name().to_string())
                        .unwrap_or_else(|| "\u{2014}".into()),
                    session: process.session_id().map(|session| session.as_u32()),
                    cpu_ms: process.accumulated_cpu_time(),
                    memory: process.memory(),
                    virtual_memory: process.virtual_memory(),
                    read_bytes: usage.read_bytes,
                    write_bytes: usage.written_bytes,
                    status: process.status(),
                    start_time: process.start_time(),
                    run_time: process.run_time(),
                }
            })
            .collect()
    }

    /// Friendly name lookup. A cache hit is instant; a miss queues the binary and
    /// answers with None for now, so a new process never blocks a tick on disk I/O.
    fn cached_description(&mut self, exe: Option<&str>) -> Option<String> {
        let exe = exe?;
        let key = exe.to_ascii_lowercase();
        if let Some(cached) = self.descriptions.get(&key) {
            return cached.clone();
        }
        if !self.pending.contains(&key) {
            self.pending.push_back(key);
        }
        None
    }

    /// Binaries read per tick. At 24 per second a machine with 400 distinct binaries
    /// shows all its friendly names within about twenty seconds of launch.
    const DESCRIPTION_BUDGET: usize = 24;

    fn resolve_descriptions(&mut self) {
        for _ in 0..Self::DESCRIPTION_BUDGET {
            let Some(key) = self.pending.pop_front() else {
                return;
            };
            // Paths were lowercased to make a stable cache key; Windows paths are
            // case-insensitive, so the file still opens.
            let description = platform::file_description(&PathBuf::from(&key));
            self.descriptions.insert(key, description);
        }
    }

    fn host(&self) -> HostInfo {
        HostInfo {
            name: System::host_name().unwrap_or_else(|| "unknown".into()),
            os: System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_string()),
            kernel: System::kernel_version().unwrap_or_default(),
            arch: std::env::consts::ARCH.to_string(),
            uptime_secs: System::uptime(),
            boot_time: System::boot_time(),
            elevated: platform::elevated(),
            sees_all_users: platform::elevated(),
            logical_cores: self.sys.cpus().len(),
            physical_cores: System::physical_core_count(),
            total_memory: self.sys.total_memory(),
            self_pid: std::process::id(),
        }
    }

    fn cpu(&self, processes: &[ProcessInfo]) -> CpuInfo {
        let cpus = self.sys.cpus();
        let load = System::load_average();
        CpuInfo {
            brand: cpus.first().map(|cpu| cpu.brand().trim().to_string()).unwrap_or_default(),
            vendor: cpus.first().map(|cpu| cpu.vendor_id().to_string()).unwrap_or_default(),
            logical: cpus.len(),
            physical: System::physical_core_count(),
            usage: self.sys.global_cpu_usage(),
            per_core: cpus.iter().map(|cpu| cpu.cpu_usage()).collect(),
            frequency_mhz: cpus.iter().map(|cpu| cpu.frequency()).max().unwrap_or(0),
            // Task Manager reports load average on Windows too, so mirror it.
            load_avg: Some([load.one, load.five, load.fifteen]),
            top_process: processes
                .iter()
                .filter(|process| process.cpu > 0.0)
                .max_by(|left, right| left.cpu.total_cmp(&right.cpu))
                .map(|process| display_name(process).to_string()),
        }
    }

    fn memory(&self) -> MemoryInfo {
        let total = self.sys.total_memory();
        let used = self.sys.used_memory();
        MemoryInfo {
            total,
            used,
            available: self.sys.available_memory(),
            free: self.sys.free_memory(),
            total_swap: self.sys.total_swap(),
            used_swap: self.sys.used_swap(),
            used_pct: percent(used, total),
        }
    }

    fn disks(&self, interval_ms: u64) -> Vec<DiskInfo> {
        let system_drive =
            std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()).to_ascii_lowercase();
        let mut list: Vec<DiskInfo> = self
            .disks
            .list()
            .iter()
            .map(|disk| {
                let total = disk.total_space();
                let available = disk.available_space();
                let usage = disk.usage();
                let mount = disk.mount_point().display().to_string();
                DiskInfo {
                    name: disk.name().to_string_lossy().to_string(),
                    kind: match disk.kind() {
                        sysinfo::DiskKind::HDD => "HDD",
                        sysinfo::DiskKind::SSD => "SSD",
                        _ => "Unknown",
                    }
                    .to_string(),
                    file_system: disk.file_system().to_string_lossy().to_string(),
                    total,
                    available,
                    used: total.saturating_sub(available),
                    used_pct: percent(total.saturating_sub(available), total),
                    removable: disk.is_removable(),
                    read_bps: per_second(usage.read_bytes, interval_ms),
                    write_bps: per_second(usage.written_bytes, interval_ms),
                    system: mount.to_ascii_lowercase().starts_with(&system_drive),
                    mount_point: mount,
                }
            })
            .collect();
        // The boot volume first: it is the one people actually care about.
        list.sort_by(|left, right| right.system.cmp(&left.system).then(left.mount_point.cmp(&right.mount_point)));
        list
    }

    fn networks(&self, interval_ms: u64) -> Vec<NetworkInfo> {
        let mut list: Vec<NetworkInfo> = self
            .nets
            .list()
            .iter()
            .map(|(name, data)| {
                let mut ipv4 = Vec::new();
                let mut ipv6 = Vec::new();
                for network in data.ip_networks() {
                    let text = format!("{}/{}", network.addr, network.prefix);
                    if network.addr.is_ipv4() {
                        ipv4.push(text);
                    } else {
                        ipv6.push(text);
                    }
                }
                NetworkInfo {
                    name: name.clone(),
                    mac: data.mac_address().to_string(),
                    ipv4,
                    ipv6,
                    received_bps: per_second(data.received(), interval_ms),
                    transmitted_bps: per_second(data.transmitted(), interval_ms),
                    total_received: data.total_received(),
                    total_transmitted: data.total_transmitted(),
                    packets_in: data.packets_received(),
                    packets_out: data.packets_transmitted(),
                }
            })
            .collect();
        // Busiest adapter first, and adapters that have never moved a byte last.
        list.sort_by(|left, right| {
            let left_traffic = left.received_bps + left.transmitted_bps;
            let right_traffic = right.received_bps + right.transmitted_bps;
            right_traffic.total_cmp(&left_traffic)
        });
        list
    }
}

fn percent(part: u64, whole: u64) -> f32 {
    if whole == 0 {
        0.0
    } else {
        (part as f64 * 100.0 / whole as f64) as f32
    }
}

/// What the Task Manager calls the app: the friendly name when the binary has one,
/// otherwise the executable name.
pub fn display_name(process: &ProcessInfo) -> &str {
    process.description.as_deref().unwrap_or(&process.name)
}

/// sysinfo reports CPU time in milliseconds; a share of the whole machine keeps the
/// comparison against the Task Manager meaningful (and never exceeds 100%).
pub(crate) fn cpu_share(delta_cpu_ms: u64, interval_ms: u64, logical_cores: usize) -> f32 {
    if interval_ms == 0 || logical_cores == 0 {
        return 0.0;
    }
    let capacity = interval_ms as f64 * logical_cores as f64;
    ((delta_cpu_ms as f64 * 100.0 / capacity) as f32).clamp(0.0, 100.0)
}

/// The same delta as a share of one logical core: what Process Explorer shows and
/// the number that can exceed 100% on a busy multithreaded process.
pub(crate) fn cpu_per_core(delta_cpu_ms: u64, interval_ms: u64) -> f32 {
    if interval_ms == 0 {
        return 0.0;
    }
    (delta_cpu_ms as f64 * 100.0 / interval_ms as f64) as f32
}

fn status_label(status: ProcessStatus) -> &'static str {
    match status {
        ProcessStatus::Idle => "Idle",
        ProcessStatus::Run => "Running",
        ProcessStatus::Sleep => "Waiting",
        ProcessStatus::Stop => "Suspended",
        ProcessStatus::Zombie => "Zombie",
        ProcessStatus::Dead => "Ended",
        _ => "Unknown",
    }
}

fn count_processes(processes: &[ProcessInfo]) -> Counts {
    let mut apps: HashSet<String> = HashSet::new();
    let mut threads = 0u64;
    let mut handles = 0u64;
    let mut suspended = 0usize;

    for process in processes {
        apps.insert(display_name(process).to_ascii_lowercase());
        threads += u64::from(process.threads.unwrap_or(0));
        handles += u64::from(process.handles.unwrap_or(0));
        if process.status == "Suspended" {
            suspended += 1;
        }
    }

    Counts { processes: processes.len(), apps: apps.len(), threads, handles, suspended }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake(pid: u32, name: &str, description: Option<&str>) -> ProcessInfo {
        ProcessInfo {
            pid,
            name: name.to_string(),
            description: description.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn cpu_share_is_a_share_of_the_whole_machine() {
        // 500 ms of CPU time in a 1 s window on an 8-core box: a sixteenth of the box.
        assert!((cpu_share(500, 1000, 8) - 6.25).abs() < 0.001);
        assert!((cpu_share(8000, 1000, 8) - 100.0).abs() < 0.001);
        // Never over 100%, whatever the accounting says.
        assert_eq!(cpu_share(9000, 1000, 8), 100.0);
    }

    #[test]
    fn per_core_share_can_exceed_one_core() {
        assert!((cpu_per_core(500, 1000) - 50.0).abs() < 0.001);
        assert!((cpu_per_core(2500, 1000) - 250.0).abs() < 0.001);
    }

    #[test]
    fn zero_intervals_never_divide_by_zero() {
        assert_eq!(cpu_share(10, 0, 4), 0.0);
        assert_eq!(cpu_per_core(10, 0), 0.0);
        assert_eq!(per_second(4096, 0), 0.0);
        assert_eq!(percent(5, 0), 0.0);
    }

    #[test]
    fn rates_are_normalised_to_seconds() {
        assert!((per_second(2048, 1000) - 2048.0).abs() < 0.001);
        assert!((per_second(1024, 500) - 2048.0).abs() < 0.001);
    }

    #[test]
    fn statuses_read_like_the_task_manager() {
        assert_eq!(status_label(ProcessStatus::Run), "Running");
        assert_eq!(status_label(ProcessStatus::Stop), "Suspended");
        assert_eq!(status_label(ProcessStatus::Sleep), "Waiting");
    }

    #[test]
    fn apps_are_grouped_by_friendly_name() {
        let processes = vec![
            fake(1, "chrome.exe", Some("Google Chrome")),
            fake(2, "chrome.exe", Some("Google Chrome")),
            fake(3, "tasma.exe", None),
        ];
        let counts = count_processes(&processes);
        assert_eq!(counts.processes, 3);
        // Two apps, not three processes.
        assert_eq!(counts.apps, 2);
    }

    #[test]
    fn display_name_prefers_the_version_resource() {
        assert_eq!(display_name(&fake(1, "chrome.exe", Some("Google Chrome"))), "Google Chrome");
        assert_eq!(display_name(&fake(2, "weird.exe", None)), "weird.exe");
    }

    /// The real thing: a live sample on whatever machine runs the tests, so the
    /// sysinfo integration is verified rather than merely compiled.
    #[test]
    fn a_live_sample_looks_like_a_computer() {
        let collector = Collector::new();
        std::thread::sleep(Duration::from_millis(250));
        let snapshot = collector.sample();

        assert!(snapshot.host.logical_cores >= 1);
        assert!(snapshot.memory.total > 0);
        assert!(snapshot.memory.used <= snapshot.memory.total);
        assert!(!snapshot.processes.is_empty());
        assert!((0.0..=100.0).contains(&snapshot.cpu.usage));
        assert!(!snapshot.cpu.per_core.is_empty());
        // Our own process must be listed, and it owns threads.
        assert!(snapshot.processes.iter().any(|process| process.pid == std::process::id()));
        // Thread counts come from the Windows platform layer; the stub on other
        // targets reports none, so only assert them where they are actually collected.
        if platform::SUPPORTED {
            assert!(snapshot.counts.threads > 0);
        }

        for process in &snapshot.processes {
            assert!(
                (0.0..=100.0).contains(&process.cpu),
                "{} reported {}%",
                process.name,
                process.cpu
            );
            if let Some(gpu) = process.gpu {
                assert!((0.0..=100.0).contains(&gpu));
            }
        }
    }

    #[test]
    fn the_snapshot_is_serialisable_for_the_ui() {
        let collector = Collector::new();
        let snapshot = collector.sample();
        let json = serde_json::to_string(&snapshot).expect("snapshot should serialise");
        assert!(json.contains("\"intervalMs\""));
        assert!(json.contains("\"processes\""));
        assert!(json.len() > 1000);
    }
}




