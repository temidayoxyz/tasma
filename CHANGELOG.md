# Changelog

All notable changes to Tasma are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## v0.2.0

The theming release. Light mode, a theme that follows your operating system, and a
compact mode you can actually navigate.

<p align="center">
  <img src="docs/overview-dark.png" alt="Overview in dark mode" width="49%">
  <img src="docs/processes-light.png" alt="The process workbench in light mode" width="49%">
</p>

### Added

- **Light theme.** Every surface colour is now a CSS custom property
  (`--surface-0` … `--surface-4`, `--card-top`, `--thead`, `--meter`,
  `--selected-bg`, `--overlay`), so light mode is one block of token overrides
  rather than a second stylesheet. Nothing else in the UI needed to change.
- **System-aware theme switching.** Tasma starts on whatever your OS is doing and
  follows it live, including while the app is open, until you choose for yourself.
- **Theme button** in the chrome, cycling `system → light → dark → system`. The
  choice persists to `localStorage`; a locked-down profile just gets the default.
  The tooltip states what the next press will do, so the button explains itself.
- **Compact view picker.** Compact mode hides the tab bar, so a four-square button
  now opens the six views as a menu, with icons and a checkmark on the active one.
- **Shared menu component.** The compact view picker and the process context menu
  are now the same component (`dist/menu.js`), so they open, dismiss and render
  identically and cannot drift apart.
- Three new frontend tests covering the cycle order, system deferral and tooltip.

### Fixed

- Charts now read their palette from the theme's custom properties instead of
  hardcoded hex, and repaint when the theme changes. A trace stays legible on
  either background.
- Idle grid dots in the CPU and memory traces were drawn at a fixed
  `globalAlpha` of `0.07`, which is invisible on a light background. They now use
  the theme's `--dot-faint` token, so an idle panel keeps its grid in both themes.
- Anchored menus measured themselves while still `hidden`, so `offsetWidth` was `0`
  and every anchored menu pinned to its button's right edge. The menu now unhides
  before it measures.
- The UI verification harness emitted `RIGHTDOWN` with `LEFTUP`, so no `contextmenu`
  event ever fired and right-click could not be tested. It now emits a matching
  right-down/right-up pair.
- The harness now re-parses the window bounds after each step, because compact mode
  resizes the window and coordinates captured earlier land on the wrong pixels.
- The harness pins the window to the work area and performs a warm-up click, so a
  coordinate measured from a screenshot is stable across runs and window activation
  no longer swallows the first real action.

### Changed

- The window background and `color-scheme` follow the resolved theme instead of
  being pinned to dark, which removes the dark flash before first paint.

### Downloads

| Platform | File |
| --- | --- |
| Windows x64 | `Tasma_0.2.0_x64-setup.exe` (NSIS, installs per-user) |
| Windows x64 | `Tasma_0.2.0_x64_en-US.msi` |
| Windows ARM64 | `Tasma_0.2.0_arm64-setup.exe` |
| macOS Apple Silicon | `Tasma_0.2.0_aarch64.dmg` |
| macOS Intel | `Tasma_0.2.0_x64.dmg` |
| Linux x64 | `Tasma_0.2.0_amd64.AppImage`, `Tasma_0.2.0_amd64.deb` |
| Linux ARM64 | `Tasma_0.2.0_aarch64.AppImage` |

Upgrading from 0.1.0: the NSIS installer replaces the old one in place. Your theme
choice is new in this release and defaults to following your system.

### Notes

- Process control, GPU telemetry and window handling are implemented for Windows.
  The sampler and the whole UI build and run on macOS and Linux; the mutating actions
  explain that they are Windows-only rather than failing silently.
- Unsigned builds: your OS may show a SmartScreen or Gatekeeper prompt on first run.

## v0.1.0

The first release. A working system monitor and process workbench.

### Added

- **Overview** — uptime, CPU with a 60-sample dot-matrix trace and the busiest
  process, GPU adapter and engine load, memory with a balance bar and donut, the
  boot volume, adapter throughput, and the top five apps by memory.
- **Process workbench** — every process, sortable by name, PID, CPU, memory, disk,
  GPU, threads or status, with a filter that searches the friendly name, the
  executable, the PID, the path and the user.
- **Process actions** — end task (closes windows politely before terminating),
  force terminate, suspend and resume, priority, efficiency mode, open file
  location, copy PID or path, and a detail drawer with the command line, working
  directory and live counters.
- **CPU & GPU, Memory, Network and Disk views** — per-processor bars, the CPU brand
  and load average, per-process GPU engine load, physical memory against pagefile,
  per-adapter throughput and every volume with live I/O.
- **Sampler** with its own history: a self-scheduling poll loop that never overlaps
  ticks and stops entirely when the window is hidden.
- **Virtualised process table**, so 800 processes scroll like 80.
- **Windows platform layer** — PDH counters, DXGI GPU engines, ToolHelp process
  extras, window enumeration, and priority and efficiency-mode control.
- **Non-Windows stubs**, so the sampler, the command surface and the whole UI build
  and run on macOS and Linux. Mutating actions explain themselves instead of
  failing silently.
- **Console probe** (`--probe`) that prints a live snapshot, for checking a
  platform integration without opening a window.
- **Compact widget mode** — a narrow always-on-top strip.
- Elevation prompt when an action needs administrator rights, adjustable refresh
  rate from 0.5s to paused, toasts, confirmation dialogs, and keyboard shortcuts
  (`Ctrl`+`1`–`6` for views, `Ctrl`+`F` to filter, `F5` to sample).

[0.2.0]: https://github.com/temidayoxyz/tasma/releases/tag/v0.2.0
[0.1.0]: https://github.com/temidayoxyz/tasma/releases/tag/v0.1.0
