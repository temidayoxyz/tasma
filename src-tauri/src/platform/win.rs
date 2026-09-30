//! Windows integration: the parts of Tasma that talk to the OS directly.
//!
//! Everything here is deliberately defensive. Process control on Windows fails for
//! perfectly ordinary reasons (protected process, another user's session, no
//! elevation, an app that simply refuses to close), so every function returns a
//! `Result` carrying a message the UI can show instead of panicking or lying.

use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::core::{w, BOOL, PCSTR, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, WPARAM};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Threading::{
    CreateProcessW, GetCurrentProcess, GetPriorityClass, GetProcessHandleCount, OpenProcess,
    OpenProcessToken, SetPriorityClass, SetProcessInformation, TerminateProcess,
    ProcessPowerThrottling, CREATE_NEW_CONSOLE, IDLE_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS,
    NORMAL_PRIORITY_CLASS, ABOVE_NORMAL_PRIORITY_CLASS, HIGH_PRIORITY_CLASS,
    REALTIME_PRIORITY_CLASS, PROCESS_ACCESS_RIGHTS, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION,
    PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
    PROCESS_POWER_THROTTLING_STATE, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_INFORMATION, PROCESS_SUSPEND_RESUME, PROCESS_TERMINATE, STARTUPINFOW,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, SW_SHOWNORMAL, WM_CLOSE,
};

use super::ProcessExtras;

/// True on Windows; the UI reads it to explain missing features elsewhere.
pub const SUPPORTED: bool = true;

/// Priority classes as the Task Manager names them, paired with the raw
/// `GetPriorityClass` values so the two directions can never drift apart.
const PRIORITY_NAMES: [(u32, &str); 6] = [
    (0x40, "Idle"),
    (0x4000, "Below normal"),
    (0x20, "Normal"),
    (0x8000, "Above normal"),
    (0x80, "High"),
    (0x100, "Realtime"),
];

pub fn priority_levels() -> &'static [&'static str] {
    &["Idle", "Below normal", "Normal", "Above normal", "High", "Realtime"]
}

pub fn priority_name(class: u32) -> &'static str {
    PRIORITY_NAMES
        .iter()
        .find(|(value, _)| *value == class)
        .map(|(_, name)| *name)
        .unwrap_or("Unknown")
}

fn priority_flag(level: &str) -> Option<PROCESS_CREATION_FLAGS> {
    let class = match level.to_ascii_lowercase().as_str() {
        "idle" => IDLE_PRIORITY_CLASS,
        "below normal" | "belownormal" => BELOW_NORMAL_PRIORITY_CLASS,
        "normal" => NORMAL_PRIORITY_CLASS,
        "above normal" | "abovenormal" => ABOVE_NORMAL_PRIORITY_CLASS,
        "high" => HIGH_PRIORITY_CLASS,
        "realtime" => REALTIME_PRIORITY_CLASS,
        _ => return None,
    };
    Some(class)
}

/// Opens a process handle, or explains why Windows refused.
fn open(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> Result<HANDLE, String> {
    unsafe {
        OpenProcess(access, false, pid).map_err(|error| {
            // ERROR_ACCESS_DENIED is the common failure and the only one the user
            // can actually do something about.
            if error.code().0 as u32 == 0x8007_0005 {
                format!("access denied for PID {pid} - try running Tasma as administrator")
            } else {
                format!("could not open PID {pid}: {error}")
            }
        })
    }
}

/// Threads per process from one Toolhelp sweep. sysinfo has no thread counts on
/// Windows, but the Task Manager has had that column forever.
pub fn thread_counts() -> HashMap<u32, u32> {
    let mut counts: HashMap<u32, u32> = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) else {
            return counts;
        };
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        if Thread32First(snapshot, &mut entry).is_ok() {
            loop {
                *counts.entry(entry.th32OwnerProcessID).or_insert(0) += 1;
                entry.dwSize = size_of::<THREADENTRY32>() as u32;
                if Thread32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    counts
}

/// Handle count + priority class for one process, from a single `OpenProcess`.
pub fn open_counters(pid: u32) -> (Option<u32>, Option<&'static str>) {
    let Ok(handle) = open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_QUERY_INFORMATION) else {
        return (None, None);
    };
    unsafe {
        let mut handles = 0u32;
        let handle_count = GetProcessHandleCount(handle, &mut handles).is_ok().then_some(handles);
        let class = GetPriorityClass(handle);
        let _ = CloseHandle(handle);
        (handle_count, (class != 0).then(|| priority_name(class)))
    }
}

/// Convenience wrapper used by the probe: everything for one pid in one call.
pub fn process_extras(pid: u32) -> ProcessExtras {
    let (handles, priority) = open_counters(pid);
    ProcessExtras { threads: None, handles, priority }
}

/// The `FileDescription` from a binary's version resource - what the Task Manager
/// shows as "Google Chrome" instead of "chrome.exe". Returns None when the binary
/// has no version block (plenty of Windows binaries do not).
pub fn file_description(exe: &Path) -> Option<String> {
    let wide: Vec<u16> = exe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut block = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(wide.as_ptr()), None, size, block.as_mut_ptr() as *mut c_void)
            .ok()?;

        let mut buffer: *mut c_void = std::ptr::null_mut();
        let mut length = 0u32;

        // Language/codepage pairs live in the translation table; fall back to the
        // common US-English block when the binary does not publish one.
        let mut lang = 0x0409u16;
        let mut codepage = 0x04b0u16;
        if VerQueryValueW(
            block.as_ptr() as *const c_void,
            w!("\\VarFileInfo\\Translation"),
            &mut buffer,
            &mut length,
        )
        .as_bool()
            && length >= 4
        {
            let pair = std::slice::from_raw_parts(buffer as *const u16, 2);
            lang = pair[0];
            codepage = pair[1];
        }

        let key = format!("\\StringFileInfo\\{lang:04x}{codepage:04x}\\FileDescription");
        let key: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
        if VerQueryValueW(
            block.as_ptr() as *const c_void,
            PCWSTR(key.as_ptr()),
            &mut buffer,
            &mut length,
        )
        .as_bool()
            && length > 0
        {
            let raw = std::slice::from_raw_parts(buffer as *const u16, length as usize);
            let text = String::from_utf16_lossy(raw);
            let text = text.trim_end_matches('\0').trim();
            if !text.is_empty() && text != exe.file_name().unwrap_or_default().to_string_lossy() {
                return Some(text.to_string());
            }
        }
    }
    None
}

struct CloseRequest {
    pid: u32,
    sent: usize,
}

unsafe extern "system" fn close_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = &mut *(lparam.0 as *mut CloseRequest);
    let mut owner = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut owner));
    if owner == state.pid
        && IsWindowVisible(hwnd).as_bool()
        && PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).is_ok()
    {
        state.sent += 1;
    }
    // Keep enumerating.
    BOOL(1)
}

/// Asks every visible top-level window owned by `pid` to close - the polite half of
/// the Task Manager's "End task". Returns how many windows accepted the request.
pub fn close_windows(pid: u32) -> Result<usize, String> {
    let mut state = CloseRequest { pid, sent: 0 };
    unsafe {
        EnumWindows(Some(close_windows_callback), LPARAM(&mut state as *mut CloseRequest as isize))
            .map_err(|error| format!("could not enumerate windows: {error}"))?;
    }
    Ok(state.sent)
}

/// Opens Explorer with the process binary selected.
pub fn reveal(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("{} no longer exists", path.display()));
    }
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not start Explorer: {error}"))
}

// --- process control -------------------------------------------------------

/// `NtSuspendProcess` / `NtResumeProcess` are the only reliable way to freeze an
/// arbitrary process; kernel32 has no documented equivalent. They live in ntdll,
/// have been stable for two decades, and are loaded at runtime so a missing export
/// degrades instead of preventing Tasma from starting.
type NtProcessControl = unsafe extern "system" fn(HANDLE) -> i32;

fn nt_process_control(name: &[u8]) -> Option<NtProcessControl> {
    unsafe {
        let ntdll = GetModuleHandleW(w!("ntdll.dll")).ok()?;
        let address = GetProcAddress(ntdll, PCSTR(name.as_ptr()))?;
        // SAFETY: the address comes from ntdll, which is a loaded, trusted module, and
        // the symbol is one of the Nt*Process entry points that take a HANDLE and
        // return a status code, matching NtProcessControl exactly.
        Some(std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            NtProcessControl,
        >(address))
    }
}

fn nt_call(name: &[u8], pid: u32, action: &str) -> Result<(), String> {
    let function = nt_process_control(name)
        .ok_or_else(|| format!("ntdll is missing the {action} entry point"))?;
    let handle = open(pid, PROCESS_SUSPEND_RESUME)?;
    let status = unsafe { function(handle) };
    unsafe {
        let _ = CloseHandle(handle);
    }
    if status >= 0 {
        Ok(())
    } else {
        Err(format!("{action} failed with NTSTATUS 0x{:08X}", status as u32))
    }
}

pub fn suspend(pid: u32) -> Result<(), String> {
    nt_call(b"NtSuspendProcess\0", pid, "suspend")
}

pub fn resume(pid: u32) -> Result<(), String> {
    nt_call(b"NtResumeProcess\0", pid, "resume")
}

pub fn terminate(pid: u32) -> Result<(), String> {
    let handle = open(pid, PROCESS_TERMINATE)?;
    let result = unsafe { TerminateProcess(handle, 1) };
    unsafe {
        let _ = CloseHandle(handle);
    }
    result.map_err(|error| format!("could not terminate PID {pid}: {error}"))
}

pub fn set_priority(pid: u32, level: &str) -> Result<(), String> {
    let class = priority_flag(level).ok_or_else(|| format!("unknown priority '{level}'"))?;
    let handle = open(pid, PROCESS_SET_INFORMATION)?;
    let result = unsafe { SetPriorityClass(handle, class) };
    unsafe {
        let _ = CloseHandle(handle);
    }
    result.map_err(|error| format!("could not set the priority of PID {pid}: {error}"))
}

/// EcoQoS - what the Task Manager calls "Efficiency mode".
pub fn set_efficiency(pid: u32, enabled: bool) -> Result<(), String> {
    let handle = open(pid, PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION)?;
    let state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        StateMask: if enabled { PROCESS_POWER_THROTTLING_EXECUTION_SPEED } else { 0 },
    };
    let result = unsafe {
        SetProcessInformation(
            handle,
            ProcessPowerThrottling,
            &state as *const _ as *const c_void,
            size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        )
    };
    unsafe {
        let _ = CloseHandle(handle);
    }
    result.map_err(|error| format!("could not change efficiency mode for PID {pid}: {error}"))
}

/// "Run new task": starts a command line in its own console, like the Task Manager.
pub fn create_process(command: &str) -> Result<u32, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("nothing to run".into());
    }
    let mut line: Vec<u16> = trimmed.encode_utf16().chain(std::iter::once(0)).collect();
    let startup = STARTUPINFOW { cb: size_of::<STARTUPINFOW>() as u32, ..Default::default() };
    let mut info = PROCESS_INFORMATION::default();
    unsafe {
        CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(line.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_NEW_CONSOLE,
            None,
            PCWSTR::null(),
            &startup,
            &mut info,
        )
        .map_err(|error| format!("could not start '{trimmed}': {error}"))?;
        let pid = info.dwProcessId;
        let _ = CloseHandle(info.hProcess);
        let _ = CloseHandle(info.hThread);
        Ok(pid)
    }
}

pub fn elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut c_void),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

/// Restarts Tasma through the UAC prompt so process control reaches every session.
pub fn relaunch_elevated() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| format!("could not locate Tasma: {error}"))?;
    let exe: Vec<u16> = exe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let verb: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let result = ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(exe.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        // ShellExecute reports failure as a pseudo-HINSTANCE with a value <= 32.
        if result.0 as isize <= 32 {
            return Err("elevation was cancelled or refused by Windows".into());
        }
    }
    Ok(())
}

// --- window chrome ---------------------------------------------------------

// Declared by hand rather than pulled out of the windows crate: tauri re-exports its
// own HWND type, and going through an `isize` here keeps this file independent of
// whichever windows-crate version tauri happens to pin.
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const c_void, size: u32) -> i32;
}

/// Gives the frameless window Windows 11 rounded corners and a dark caption, which
/// is what stops it looking like a bolted-on rectangle next to the panels.
pub fn polish_window(window: &tauri::WebviewWindow) {
    const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: i32 = 2;

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as isize;
    let dark = 1i32;
    unsafe {
        // Both calls are harmless no-ops on Windows 10.
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &dark as *const i32 as *const c_void,
            4,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &DWMWCP_ROUND as *const i32 as *const c_void,
            4,
        );
    }
}




