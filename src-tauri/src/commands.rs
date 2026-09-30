//! The Tauri command surface.
//!
//! Two rules hold for everything in here:
//!
//! 1. **Never block the UI thread.** Every command is `async` and the sampling work
//!    goes through `spawn_blocking`, because a sysinfo refresh over 400 processes is
//!    tens of milliseconds the webview must not spend waiting.
//! 2. **Never return a bare failure.** Actions come back as an `ActionReport` that
//!    says what happened and whether elevation is the missing piece, which is how the
//!    UI can offer "Relaunch as administrator" at exactly the right moment.

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::model::{ActionReport, ControlAction, ProcessDetail, Snapshot};
use crate::platform;
use crate::AppState;

const MAIN_WINDOW: &str = "main";
/// A narrow, always-on-top strip - the "at a glance" widget from the design.
const COMPACT_SIZE: (f64, f64) = (392.0, 760.0);
const FULL_SIZE: (f64, f64) = (1180.0, 820.0);

#[tauri::command]
pub async fn get_snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    let collector = Arc::clone(&state.collector);
    tauri::async_runtime::spawn_blocking(move || collector.sample())
        .await
        .map_err(|error| format!("sampling failed: {error}"))
}

#[tauri::command]
pub async fn get_process_detail(
    state: State<'_, AppState>,
    pid: u32,
) -> Result<Option<ProcessDetail>, String> {
    let collector = Arc::clone(&state.collector);
    tauri::async_runtime::spawn_blocking(move || collector.detail(pid))
        .await
        .map_err(|error| format!("reading process detail failed: {error}"))
}

#[tauri::command]
pub async fn end_task(state: State<'_, AppState>, pid: u32) -> Result<ActionReport, String> {
    if let Some(report) = refuse(pid) {
        return Ok(report);
    }
    let name = label(&state, pid);
    // The polite half of "End task": ask the windows to close, exactly like the Task
    // Manager does before it resorts to terminating anything.
    match platform::close_windows(pid) {
        Ok(0) => Ok(ActionReport::failed(
            format!("{name} has no visible window to close - use Force terminate instead."),
            false,
        )),
        Ok(count) => Ok(ActionReport::ok(format!(
            "Asked {name} to close ({count} window{}).",
            if count == 1 { "" } else { "s" }
        ))),
        Err(error) => Ok(ActionReport::failed(error, false)),
    }
}

#[tauri::command]
pub async fn kill_process(state: State<'_, AppState>, pid: u32) -> Result<ActionReport, String> {
    if let Some(report) = refuse(pid) {
        return Ok(report);
    }
    let name = label(&state, pid);
    Ok(outcome(
        state
            .collector
            .control(pid, ControlAction::Terminate)
            .map(|()| format!("{name} was terminated.")),
    ))
}

#[tauri::command]
pub async fn suspend_process(state: State<'_, AppState>, pid: u32) -> Result<ActionReport, String> {
    if let Some(report) = refuse(pid) {
        return Ok(report);
    }
    let name = label(&state, pid);
    Ok(outcome(
        state
            .collector
            .control(pid, ControlAction::Suspend)
            .map(|()| format!("{name} is suspended.")),
    ))
}

#[tauri::command]
pub async fn resume_process(state: State<'_, AppState>, pid: u32) -> Result<ActionReport, String> {
    if let Some(report) = refuse(pid) {
        return Ok(report);
    }
    let name = label(&state, pid);
    Ok(outcome(
        state
            .collector
            .control(pid, ControlAction::Resume)
            .map(|()| format!("{name} is running again.")),
    ))
}

#[tauri::command]
pub async fn set_priority(
    state: State<'_, AppState>,
    pid: u32,
    level: String,
) -> Result<ActionReport, String> {
    if let Some(report) = refuse(pid) {
        return Ok(report);
    }
    let name = label(&state, pid);
    Ok(outcome(
        platform::set_priority(pid, &level).map(|()| format!("{name} is now {level} priority.")),
    ))
}

#[tauri::command]
pub async fn set_efficiency_mode(
    state: State<'_, AppState>,
    pid: u32,
    enabled: bool,
) -> Result<ActionReport, String> {
    if let Some(report) = refuse(pid) {
        return Ok(report);
    }
    let name = label(&state, pid);
    Ok(outcome(platform::set_efficiency(pid, enabled).map(|()| {
        if enabled {
            format!("{name} is now in efficiency mode.")
        } else {
            format!("Efficiency mode is off for {name}.")
        }
    })))
}

#[tauri::command]
pub async fn run_task(command: String) -> Result<ActionReport, String> {
    Ok(outcome(platform::create_process(&command).map(|pid| format!("Started PID {pid}."))))
}

#[tauri::command]
pub async fn reveal_process(state: State<'_, AppState>, pid: u32) -> Result<ActionReport, String> {
    let exe = state
        .collector
        .last()
        .processes
        .iter()
        .find(|process| process.pid == pid)
        .and_then(|process| process.exe.clone());
    let Some(exe) = exe else {
        return Ok(ActionReport::failed("Tasma does not know where that process lives.", false));
    };
    Ok(outcome(platform::reveal(std::path::Path::new(&exe)).map(|()| format!("Opened {exe}"))))
}

/// Switches between the full dashboard and the narrow always-on-top widget.
#[tauri::command]
pub async fn set_compact(app: AppHandle, on: bool) -> Result<ActionReport, String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return Ok(ActionReport::failed("The main window has gone missing.", false));
    };
    let (width, height) = if on { COMPACT_SIZE } else { FULL_SIZE };
    if let Err(error) = window.set_size(tauri::LogicalSize::new(width, height)) {
        return Ok(ActionReport::failed(format!("could not resize the window: {error}"), false));
    }
    if let Err(error) = window.set_always_on_top(on) {
        return Ok(ActionReport::failed(format!("could not pin the window: {error}"), false));
    }
    Ok(ActionReport::ok(if on { "Compact widget on." } else { "Full dashboard on." }))
}

/// Restarts Tasma through UAC, then steps aside.
#[tauri::command]
pub async fn relaunch_elevated(app: AppHandle) -> Result<ActionReport, String> {
    match platform::relaunch_elevated() {
        Ok(()) => {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                app.exit(0);
            });
            Ok(ActionReport::ok("Tasma is restarting with administrator rights."))
        }
        Err(error) => Ok(ActionReport::failed(error, false)),
    }
}

#[tauri::command]
pub async fn app_info() -> Result<crate::model::AppInfo, String> {
    Ok(crate::model::AppInfo {
        name: "Tasma".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        tauri: tauri::VERSION.into(),
        rustc: env!("TASMA_RUSTC").into(),
        profile: if cfg!(debug_assertions) { "debug" } else { "release" }.into(),
    })
}

/// Pids Tasma will not touch: the two pseudo-processes Windows owns, and itself.
fn refuse(pid: u32) -> Option<ActionReport> {
    match pid {
        0 | 4 => Some(ActionReport::failed(
            "That is a Windows kernel process and even the Task Manager cannot end it.",
            false,
        )),
        pid if pid == std::process::id() => {
            Some(ActionReport::failed("Tasma will not act on itself.", false))
        }
        _ => None,
    }
}

/// The friendliest name we have for a pid, from the most recent snapshot.
fn label(state: &State<'_, AppState>, pid: u32) -> String {
    state
        .collector
        .last()
        .processes
        .iter()
        .find(|process| process.pid == pid)
        .map(|process| {
            format!("{} (PID {pid})", process.description.as_deref().unwrap_or(&process.name))
        })
        .unwrap_or_else(|| format!("PID {pid}"))
}

/// Turns a platform result into a report, and spots the one failure a user can fix.
fn outcome(result: Result<String, String>) -> ActionReport {
    match result {
        Ok(message) => ActionReport::ok(message),
        Err(message) => {
            let needs_elevation = message.contains("access denied") && !platform::elevated();
            ActionReport::failed(message, needs_elevation)
        }
    }
}
