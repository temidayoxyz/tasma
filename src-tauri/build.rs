fn main() {
    // Recorded so the About line in the UI can tell people exactly what built the
    // binary they are running.
    let rustc = std::process::Command::new(option_env!("RUSTC").unwrap_or("rustc"))
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| "rustc (unknown)".to_string());
    println!("cargo:rustc-env=TASMA_RUSTC={rustc}");
    println!("cargo:rerun-if-changed=build.rs");

    tauri_build::build()
}

