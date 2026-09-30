# Tasma

A fast, focused system monitor and task manager for Windows, built with Rust and
Tauri. The visual language is borrowed from [Wisp](https://wisp.so)-style menubar
tools: dot-matrix traces instead of area charts, one idea per card, and a colour
system that stays out of the way. The numbers underneath are real Windows
telemetry, read from the same places the Task Manager reads.

## What it does

**Overview** — uptime, CPU with a 60-sample trace and the busiest process, GPU
adapter and engine load, memory with a dot-matrix balance bar and a donut, the boot
volume, adapter throughput, and the top five apps by memory.

**Processes** — every process, sortable by name, PID, CPU, memory, disk, GPU,
threads or status, with a filter that searches the friendly name, the executable,
the PID, the path and the user. Actions: end task (polite, closes windows), force
terminate, suspend/resume, priority, efficiency mode, open file location, copy PID or
path, and a detail drawer with the command line, working directory and counters.

**CPU & GPU** — per-logical-processor bars, the CPU brand and clock, load average,
per-process GPU engine load, and leaderboards for both.

**Memory** — physical in use versus available versus pagefile, a history trace, and
the honest caveat that summing working sets double counts shared pages.

**Network** — per-adapter throughput, addresses, MAC, totals and packet counts.

**Disk** — every volume with a usage bar, live I/O traces, and the per-process I/O
leaderboard.

Plus a **compact widget** mode (the toolbar button, or `Ctrl` + the widget icon):
the window shrinks to a narrow always-on-top strip.

## Running it

```bash
cargo start --manifest-path src-tauri/Cargo.toml   # or: npm start
```

The first build takes a few minutes; after that it starts in about a second. There is
no JavaScript toolchain in the loop - the UI is plain ES modules that Tauri serves
straight from `dist/`.

> **The frontend is embedded into the binary at build time.** After editing anything in
> `dist/`, run `cargo build` (or `cargo run`) again - a reload is not enough. For quick
> UI iteration without a rebuild, open `dist/index.html` in a browser: it falls back to a
> built-in mock machine so every view, chart and action can be walked through.
>
> Views can be linked to: `dist/index.html#processes` opens straight onto that tab.

### Verifying it without trusting it

```bash
cargo test  --manifest-path src-tauri/Cargo.toml   # sampler maths + a live sample test
node tools/ui-selftest.mjs                         # formatting, sorting, filtering, contract
cargo run  --manifest-path src-tauri/Cargo.toml -- --probe          # one sample, human readable
cargo run  --manifest-path src-tauri/Cargo.toml -- --probe --json   # the exact payload the UI gets
cargo run  --manifest-path src-tauri/Cargo.toml -- --probe --actions  # suspend/priority/EcoQoS/terminate
powershell -ExecutionPolicy Bypass -File tools/screenshot.ps1        # render the window to a PNG
```

`--probe --actions` starts a throwaway `ping.exe`, then suspends, resumes,
re-prioritises, flips efficiency mode on and finally terminates it, checking after
each step that the effect showed up in a fresh sample. That is the only way to know
the Windows integration works on the machine you are sitting at.

`tools/screenshot.ps1` launches the app, captures its window and writes
`screenshot.png`. It is how the UI gets verified without a human in the loop: a GUI
you cannot look at is a GUI you are guessing about.

## Keyboard

| Key | Action |
| --- | --- |
| `Ctrl`+`1`…`6` | Switch views |
| `Ctrl`+`F` | Jump to the process filter |
| `Ctrl`+`R` | Take a sample now |
| `↑` / `↓` | Move through processes |
| `Enter` | Open the detail drawer |
| `Delete` | End task |
| `Esc` | Close the menu, drawer or dialog |

## Elevation

Tasma runs as a normal user by default. Actions against processes owned by other
users or sessions fail with `ERROR_ACCESS_DENIED`, exactly as they would in the Task
Manager. When that happens the toast offers **Relaunch as administrator**, which
restarts Tasma through UAC.

## How it is put together

```
src-tauri/
  src/
    lib.rs           Tauri builder, managed state, window setup
    metrics.rs       the sampler: one Snapshot per tick, all rate maths, unit tests
    model.rs         the wire format (serde, camelCase) - the contract with the UI
    commands.rs      the command surface; every action returns a report
    probe.rs         console self-test (--probe / --actions)
    platform/
      win.rs         Windows integration: process control, version resources, elevation
      win_gpu.rs     DXGI adapter enumeration + PDH "GPU Engine" counters
      win_stub.rs    honest no-ops so the crate still builds elsewhere
dist/                the UI: plain ES modules, no build step
  app.js             boot, tabs, chrome, polling loop
  views.js           the five data views (templates + mount + update)
  processes.js       the virtualised process table, actions, menu, drawer
  charts.js          dot-matrix traces and the donut
  table.js           filtering, sorting, virtual window, app grouping (pure)
  format.js          number and label formatting (pure)
tools/
  make-icons.ps1     regenerates the app icons from code
  ui-selftest.mjs    Node test harness for dist/*.js
```

One sampler, one snapshot per tick. Rates are only meaningful measured over a known
window, so the collector owns all sampling state and hands the UI a single immutable
`Snapshot`. Every command is `async` and does its work through `spawn_blocking`, so a
tens-of-milliseconds refresh never lands on the UI thread.

### Where the numbers come from

| Column | Source |
| --- | --- |
| CPU % (whole machine) | `GetProcessTimes` deltas over a known wall-clock window, via sysinfo's `accumulated_cpu_time` |
| CPU % (one core) | the same delta divided by one core instead of all of them |
| Memory | working set and committed private bytes per process, totals from the memory status API |
| Threads | one Toolhelp `TH32CS_SNAPTHREAD` sweep, tallied per owner pid |
| Handles, priority | `GetProcessHandleCount`, `GetPriorityClass` |
| Friendly names | `FileDescription` from the binary's version resource, cached per path |
| Disk I/O | per-process I/O counters; live rate from the delta |
| GPU | `GPU Engine(*)\Utilization Percentage` PDH counters, summed per pid and per engine |
| Adapters | DXGI (`IDXGIFactory1`), no WMI, no vendor SDK |
| Volume / adapter details | sysinfo's disk and network modules |
| Suspension, termination | `NtSuspendProcess` / `NtResumeProcess` / `TerminateProcess` |
| Efficiency mode | `SetProcessInformation` with `PROCESS_POWER_THROTTLING_STATE` (EcoQoS) |
| End task | `WM_CLOSE` to every visible top-level window owned by the pid, then nothing more |

### Honest gaps

These are the places where Tasma is honest about not being able to do what the Task
Manager does, rather than inventing a number:

* **Per-process network usage.** Windows exposes no public API; the Task Manager uses
  an internal driver (Network Data Usage Monitoring). Tasma shows adapter-level
  throughput, which is what the counters can actually support. A WFP callout driver
  would close this gap.
* **Startup impact and power usage.** Both come from Windows' internal diagnostics and
  energy-estimation subsystems, which are not documented interfaces.
* **CPU and GPU temperature.** Not available through any public API on Windows; those
  chips are absent from the design rather than faked.
* **Suspension state.** No public Windows API reports whether a process's threads are
  frozen - a process suspended with `NtSuspendProcess` still reports as running
  everywhere, sysinfo included. The sampler therefore remembers its own suspends and
  combines them with sysinfo's status, so the Status column tells the truth about
  anything Tasma has done and says nothing it cannot know.
* **Bit-identical numbers.** Sampled metrics differ between any two tools, including
  two Task Manager windows. Per-process CPU is a share of the machine, matching what
  the Task Manager shows.

## Design notes

The palette is four accents on near-black: green for healthy, violet for memory, amber
for warnings and storage, red reserved for destructive actions. Nothing else gets a
colour, so a coloured number always means something.

Charts are dot matrices rather than filled areas because a 90-sample trace stays
legible as a texture, does not smear when a spike arrives, and stays crisp at any
window size. Trace ceilings decay rather than snap, so a quiet link keeps its shape
without clipping the next burst.

The window is frameless with its own chrome, rounded corners requested from DWM on
Windows 11, and the whole layout collapses to a single narrow column in compact mode.
Every interactive element has a focus style, the process list is keyboard navigable,
and `prefers-reduced-motion` disables the live pulse and the entry animations.
