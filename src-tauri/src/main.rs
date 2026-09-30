// Prevents an extra console window from appearing next to the GUI in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if tasma_lib::probe::requested() {
        std::process::exit(tasma_lib::probe::run());
    }
    tasma_lib::run();
}
