//! Console self-test.
//!
//! Tasma's numbers are only worth anything if they are real, and a GUI is a terrible
//! place to find that out. This exposes the whole sampling and control path over a
//! terminal:
//!
//! ```text
//! cargo run -- --probe                  # one sample, human readable
//! cargo run -- --probe --json           # the exact JSON the UI receives
//! cargo run -- --probe --loops 5 --interval 500
//! cargo run -- --probe --actions        # suspend/resume/priority/EcoQoS/terminate
//! ```
//!
//! `--actions` launches a throwaway `ping.exe`, runs every process-control path
//! against it and checks the results came back, so the Windows layer is verified end
//! to end instead of merely compiled.

use std::time::{Duration, Instant};

use crate::metrics::{display_name, Collector};
// ControlAction is only referenced by the Windows action self-test.
#[cfg(windows)]
use crate::model::ControlAction;
use crate::model::Snapshot;
use crate::platform;

pub fn requested() -> bool {
    std::env::args().any(|arg| arg == "--probe" || arg == "--selftest")
}

pub fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let json = args.iter().any(|arg| arg == "--json");
    let actions = args.iter().any(|arg| arg == "--actions");
    let loops = number(&args, "--loops").unwrap_or(1).max(1);
    let interval = number(&args, "--interval").unwrap_or(1000).max(100);

    println!("Tasma probe");
    println!("  platform support : {}", platform::SUPPORTED);
    println!("  elevated         : {}", platform::elevated());
    println!("  gpu counters     : {}", platform::gpu::AVAILABLE);
    println!("  samples          : {loops} every {interval} ms");

    let started = Instant::now();
    let collector = Collector::new();
    println!("  startup priming  : {:?}", started.elapsed());

    let mut last = Snapshot::default();
    for index in 0..loops {
        let began = Instant::now();
        last = collector.sample();
        println!(
            "  sample {}/{}       : {:>6.1} ms  ({} processes)",
            index + 1,
            loops,
            began.elapsed().as_secs_f64() * 1000.0,
            last.processes.len()
        );
        if index + 1 < loops {
            std::thread::sleep(Duration::from_millis(interval));
        }
    }

    if json {
        // The literal payload the webview receives.
        match serde_json::to_string_pretty(&last) {
            Ok(text) => println!("{text}"),
            Err(error) => {
                eprintln!("could not serialise the snapshot: {error}");
                return 1;
            }
        }
        return 0;
    }

    summarise(&last);

    if args.iter().any(|arg| arg == "--instances") {
        // Raw PDH instances next to the DXGI adapter list: the fastest way to see why
        // engine load is or is not being attributed to an adapter.
        let (adapters, instances) = collector.gpu_details();
        println!();
        println!("dxgi adapters (name, luid high, luid low)");
        for (name, luids) in &adapters {
            let rendered: Vec<String> = luids
                .iter()
                .map(|(high, low)| format!("{high:#010x}/{low:#010x}"))
                .collect();
            println!("  {name:<40} {}", rendered.join("  "));
        }
        println!();
        println!("pdh gpu engine instances ({})", instances.len());
        for name in &instances {
            println!("  {name}");
        }
    }

    let mut code = 0;
    if actions {
        code |= exercise_actions(&last);
    }
    code
}

fn summarise(snapshot: &Snapshot) {
    let host = &snapshot.host;
    println!();
    println!("host      {} - {} {}", host.name, host.os, host.kernel);
    println!(
        "cpu       {} logical, {} physical, {:.1}% busy, {:.2} GHz",
        host.logical_cores,
        host.physical_cores.map_or("?".to_string(), |cores| cores.to_string()),
        snapshot.cpu.usage,
        snapshot.cpu.frequency_mhz as f64 / 1000.0
    );
    println!("          {}", snapshot.cpu.brand);
    if let Some(top) = &snapshot.cpu.top_process {
        println!("          busiest process: {top}");
    }
    println!(
        "memory    {:.1} GB used of {:.1} GB ({:.1}%), {:.1} GB available, {:.1} GB pagefile",
        to_gb(snapshot.memory.used),
        to_gb(snapshot.memory.total),
        snapshot.memory.used_pct,
        to_gb(snapshot.memory.available),
        to_gb(snapshot.memory.used_swap)
    );
    for disk in &snapshot.disks {
        println!(
            "disk      {:<12} {:<8} {:>7.1}/{:<7.1} GB {:>3.0}%   r {}/s  w {}/s{}",
            disk.mount_point,
            disk.kind,
            to_gb(disk.used),
            to_gb(disk.total),
            disk.used_pct,
            rate(disk.read_bps),
            rate(disk.write_bps),
            if disk.system { "  [system]" } else { "" }
        );
    }
    for network in snapshot
        .networks
        .iter()
        .filter(|net| net.total_received + net.total_transmitted > 0)
    {
        println!(
            "network   {:<30} down {}/s  up {}/s  ({})",
            network.name,
            rate(network.received_bps),
            rate(network.transmitted_bps),
            network.ipv4.first().cloned().unwrap_or_else(|| network.mac.clone())
        );
    }
    for gpu in &snapshot.gpus {
        println!(
            "gpu       {} ({}, {:.1} GB vram){}",
            gpu.name,
            gpu.vendor,
            to_gb(gpu.vram),
            match (gpu.usage, &gpu.usage_engine) {
                (Some(usage), Some(engine)) => format!("  {usage:.1}% on {engine}"),
                // Counters are readable, nothing was busy in this interval.
                (Some(usage), None) => format!("  {usage:.1}% (idle)"),
                (None, _) => "  utilisation counters unavailable".to_string(),
            }
        );
    }

    let counts = &snapshot.counts;
    println!(
        "processes {} ({} apps), {} threads, {} handles, {} suspended",
        counts.processes, counts.apps, counts.threads, counts.handles, counts.suspended
    );

    let mut top: Vec<_> = snapshot.processes.iter().collect();
    top.sort_by(|left, right| right.cpu.total_cmp(&left.cpu));
    println!();
    println!(
        "  {:<34} {:>6} {:>10} {:>8} {:>8} {:>13}",
        "app", "cpu%", "memory", "threads", "handles", "priority"
    );
    for process in top.iter().take(12) {
        println!(
            "  {:<34} {:>6.2} {:>10} {:>8} {:>8} {:>13}",
            truncate(display_name(process), 34),
            process.cpu,
            bytes(process.memory),
            process.threads.map_or("-".to_string(), |value| value.to_string()),
            process.handles.map_or("-".to_string(), |value| value.to_string()),
            process.priority.as_deref().unwrap_or("-")
        );
    }

    let with_gpu: Vec<_> = snapshot
        .processes
        .iter()
        .filter(|process| process.gpu.is_some_and(|value| value > 0.0))
        .collect();
    if !with_gpu.is_empty() {
        println!();
        println!("  GPU engine counters are live for {} processes, e.g.", with_gpu.len());
        for process in with_gpu.iter().take(5) {
            println!(
                "  {:<34} {:>6.1}% gpu",
                truncate(display_name(process), 34),
                process.gpu.unwrap_or(0.0)
            );
        }
    }

    integrity(snapshot);
}

/// Counts the columns that only exist because Tasma talks to Windows directly.
fn integrity(snapshot: &Snapshot) -> u32 {
    println!();
    println!("windows-only columns");
    let count = |predicate: fn(&crate::model::ProcessInfo) -> bool| {
        snapshot.processes.iter().filter(|process| predicate(process)).count()
    };

    let mut failures = 0;
    failures += expect(
        "friendly names",
        count(|process| process.description.is_some()),
        "FileDescription from the version resource",
    );
    failures += expect(
        "thread counts",
        count(|process| process.threads.is_some()),
        "Toolhelp thread sweep",
    );
    failures += expect(
        "handle counts",
        count(|process| process.handles.is_some()),
        "GetProcessHandleCount",
    );
    failures +=
        expect("priorities", count(|process| process.priority.is_some()), "GetPriorityClass");
    failures +=
        expect("executable paths", count(|process| process.exe.is_some()), "sysinfo exe");
    failures += expect(
        "sessions",
        count(|process| process.session.is_some()),
        "session ids",
    );
    failures += expect("volumes", snapshot.disks.len(), "disks enumerated");
    failures += expect("adapters", snapshot.networks.len(), "network interfaces enumerated");
    failures
}

fn expect(label: &str, count: usize, detail: &str) -> u32 {
    let mark = if count > 0 { "ok" } else { "EMPTY" };
    println!("  {label:<18} {count:>5}  {mark:<6} {detail}");
    u32::from(count == 0)
}

/// Drives every process-control path against a throwaway child and checks that the
/// effect actually landed. This is the only way to know that suspend, priority and
/// EcoQoS work on the machine in front of you.
#[cfg(windows)]
fn exercise_actions(_snapshot: &Snapshot) -> i32 {
    use std::os::windows::process::CommandExt;
    /// CREATE_NO_WINDOW: the probe is not allowed to flash a console at anyone.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    println!();
    println!("process control");

    let victim = std::process::Command::new("ping.exe")
        .args(["-n", "120", "127.0.0.1"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();

    let Ok(child) = victim else {
        eprintln!("  could not start a test process");
        return 1;
    };
    let pid = child.id();
    println!("  test subject      ping.exe as PID {pid}");

    let collector = Collector::new();
    std::thread::sleep(Duration::from_millis(400));
    let _ = collector.sample();

    let status_of = |pid: u32| {
        collector.sample().processes.iter().find(|p| p.pid == pid).map(|p| p.status.clone())
    };
    let priority_of = |pid: u32| {
        collector
            .sample()
            .processes
            .iter()
            .find(|p| p.pid == pid)
            .and_then(|p| p.priority.clone())
    };
    let alive = |pid: u32| collector.sample().processes.iter().any(|p| p.pid == pid);

    let mut failures = 0;
    failures += check(
        "suspend",
        collector.control(pid, ControlAction::Suspend),
        || {
            std::thread::sleep(Duration::from_millis(500));
            status_of(pid).as_deref() == Some("Suspended")
        },
    );
    failures += check("resume", collector.control(pid, ControlAction::Resume), || {
        std::thread::sleep(Duration::from_millis(500));
        matches!(status_of(pid).as_deref(), Some(status) if status != "Suspended")
    });
    failures += check("priority", platform::set_priority(pid, "Below normal"), || {
        std::thread::sleep(Duration::from_millis(300));
        priority_of(pid).as_deref() == Some("Below normal")
    });
    // EcoQoS has no readable state, so a successful call is the whole signal.
    failures += check("efficiency mode", platform::set_efficiency(pid, true), || true);

    match platform::create_process("cmd.exe /c echo tasma-probe") {
        Ok(started) if started > 0 => println!("  {:<18} ok     started PID {started}", "run new task"),
        Ok(_) => {
            println!("  {:<18} FAILED  no pid returned", "run new task");
            failures += 1;
        }
        Err(error) => {
            println!("  {:<18} FAILED  {error}", "run new task");
            failures += 1;
        }
    }

    failures += check("terminate", collector.control(pid, ControlAction::Terminate), || {
        std::thread::sleep(Duration::from_millis(500));
        !alive(pid)
    });

    println!();
    if failures == 0 {
        println!("process control: all checks passed");
        0
    } else {
        println!("process control: {failures} check(s) failed");
        1
    }
}

#[cfg(not(windows))]
fn exercise_actions(_snapshot: &Snapshot) -> i32 {
    eprintln!("process control is only implemented on Windows");
    1
}

/// Only the Windows action self-test calls this; on other targets the stub above
/// reports that process control is unavailable.
#[cfg_attr(not(windows), allow(dead_code))]
fn check(name: &str, result: Result<(), String>, verify: impl FnOnce() -> bool) -> u32 {
    match result {
        Err(error) => {
            println!("  {name:<18} FAILED  {error}");
            1
        }
        Ok(()) => {
            if verify() {
                println!("  {name:<18} ok");
                0
            } else {
                println!("  {name:<18} call accepted but the snapshot has not caught up");
                1
            }
        }
    }
}

fn number(args: &[String], flag: &str) -> Option<u64> {
    let inline = format!("{flag}=");
    for (index, arg) in args.iter().enumerate() {
        if let Some(value) = arg.strip_prefix(&inline) {
            return value.parse().ok();
        }
        if arg == flag {
            return args.get(index + 1).and_then(|value| value.parse().ok());
        }
    }
    None
}

fn to_gb(value: u64) -> f64 {
    value as f64 / 1024.0 / 1024.0 / 1024.0
}

fn bytes(value: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut size = value as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{value} B")
    } else {
        format!("{size:.1} {}", UNITS[unit])
    }
}

fn rate(per_second: f64) -> String {
    if per_second <= 0.0 {
        return "0 B".into();
    }
    bytes(per_second.round() as u64)
}

fn truncate(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_string();
    }
    let mut out: String = text.chars().take(width.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_accept_both_spellings() {
        let args: Vec<String> =
            ["--probe", "--loops", "5", "--interval=250"].iter().map(|v| v.to_string()).collect();
        assert_eq!(number(&args, "--loops"), Some(5));
        assert_eq!(number(&args, "--interval"), Some(250));
        assert_eq!(number(&args, "--missing"), None);
    }

    #[test]
    fn byte_sizes_read_like_a_monitor() {
        assert_eq!(bytes(512), "512 B");
        assert_eq!(bytes(2048), "2.0 KB");
        assert_eq!(bytes(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(bytes(3 * 1024 * 1024 * 1024), "3.0 GB");
        assert_eq!(rate(0.0), "0 B");
    }

    #[test]
    fn long_names_are_trimmed_once_and_neatly() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("a much longer name", 8).chars().count(), 8);
        assert_eq!(truncate("a much longer name", 8), "a much …");
    }
}


