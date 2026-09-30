//! Platform integration.
//!
//! Windows gets the real thing. Other targets get stubs so the sampler, the command
//! surface and the UI all still build - Tasma is a Windows tool, but nobody should
//! have to fight the compiler to read the code.

#[cfg(windows)]
pub(crate) mod win_gpu;
#[cfg(not(windows))]
pub(crate) mod win_gpu_stub;

#[cfg(windows)]
pub mod win;
#[cfg(not(windows))]
mod win_stub;

#[cfg(windows)]
pub use win::*;
#[cfg(not(windows))]
pub use win_stub::*;

#[cfg(windows)]
pub(crate) use win_gpu as gpu;
#[cfg(not(windows))]
pub(crate) use win_gpu_stub as gpu;

/// Per-process numbers that sysinfo does not expose on Windows. Every field is
/// optional because access to another user's process can be denied.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessExtras {
    pub threads: Option<u32>,
    pub handles: Option<u32>,
    pub priority: Option<&'static str>,
}
