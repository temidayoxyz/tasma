//! Tasma - a Wisp-inspired system monitor and task manager.
//!
//! The crate is split into a sampler (`metrics`), a Windows integration layer
//! (`platform`), the Tauri command surface (`commands`) and a console self-test
//! (`probe`) so all of it can be exercised without a window.

pub mod commands;
pub mod metrics;
pub mod model;
pub mod platform;
pub mod probe;

use std::sync::Arc;

use tauri::Manager;

use metrics::Collector;

/// Shared application state. The collector owns all sampling state, including the
/// per-process CPU time deltas, so every command must go through this one instance.
pub struct AppState {
    pub collector: Arc<Collector>,
}

pub fn run() {
    let collector = Arc::new(Collector::new());

    tauri::Builder::default()
        .manage(AppState {
            collector: Arc::clone(&collector),
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::get_process_detail,
            commands::end_task,
            commands::kill_process,
            commands::suspend_process,
            commands::resume_process,
            commands::set_priority,
            commands::set_efficiency_mode,
            commands::run_task,
            commands::reveal_process,
            commands::set_compact,
            commands::relaunch_elevated,
            commands::app_info,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                platform::polish_window(&window);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tasma");
}
