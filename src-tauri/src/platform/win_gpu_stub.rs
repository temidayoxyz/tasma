//! GPU stub for non-Windows hosts.

use std::collections::HashMap;

use crate::model::GpuInfo;

pub const AVAILABLE: bool = false;

#[derive(Debug, Default)]
pub struct GpuSampler {
    adapters: Vec<GpuInfo>,
    per_process: HashMap<u32, f32>,
}

impl GpuSampler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn sample(&mut self) -> Vec<GpuInfo> {
        self.adapters.clone()
    }

    pub fn per_process(&self) -> &HashMap<u32, f32> {
        &self.per_process
    }

    pub fn engines(&self) -> Option<(String, f32)> {
        None
    }

    /// Adapter name paired with its LUIDs, used to attribute a process's engine
    /// counters to the right adapter. Nothing to attribute on other platforms.
    pub fn adapter_luids(&self) -> Vec<(String, Vec<(i32, u32)>)> {
        Vec::new()
    }

    /// Friendly names of the GPU engine instances, in counter order. Empty here.
    pub fn instance_names(&mut self) -> Vec<String> {
        Vec::new()
    }
}
