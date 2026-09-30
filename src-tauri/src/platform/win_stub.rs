//! Fallbacks for non-Windows hosts. No-op actions keep the UI honest: it renders,
//! it samples what sysinfo can give it, and every mutating action explains itself.

use std::collections::HashMap;
use std::path::Path;

use super::ProcessExtras;

pub const SUPPORTED: bool = false;

pub fn elevated() -> bool {
    false
}

pub fn polish_window(_window: &tauri::WebviewWindow) {}

pub fn thread_counts() -> HashMap<u32, u32> {
    HashMap::new()
}

pub fn open_counters(_pid: u32) -> (Option<u32>, Option<&'static str>) {
    (None, None)
}

pub fn process_extras(_pid: u32) -> ProcessExtras {
    ProcessExtras::default()
}

pub fn file_description(_exe: &Path) -> Option<String> {
    None
}

pub fn suspend(_pid: u32) -> Result<(), String> {
    Err("process control is only implemented on Windows".into())
}

pub fn resume(_pid: u32) -> Result<(), String> {
    Err("process control is only implemented on Windows".into())
}

pub fn terminate(_pid: u32) -> Result<(), String> {
    Err("process control is only implemented on Windows".into())
}

pub fn set_priority(_pid: u32, _level: &str) -> Result<(), String> {
    Err("priority control is only implemented on Windows".into())
}

pub fn set_efficiency(_pid: u32, _enabled: bool) -> Result<(), String> {
    Err("efficiency mode is only implemented on Windows".into())
}

pub fn close_windows(_pid: u32) -> Result<usize, String> {
    Err("window enumeration is only implemented on Windows".into())
}

pub fn create_process(_command: &str) -> Result<u32, String> {
    Err("launching tasks is only implemented on Windows".into())
}

pub fn reveal(_path: &Path) -> Result<(), String> {
    Err("revealing files is only implemented on Windows".into())
}

pub fn relaunch_elevated() -> Result<(), String> {
    Err("elevation is only implemented on Windows".into())
}

pub fn priority_levels() -> &'static [&'static str] {
    &["Idle", "Below normal", "Normal", "Above normal", "High", "Realtime"]
}
