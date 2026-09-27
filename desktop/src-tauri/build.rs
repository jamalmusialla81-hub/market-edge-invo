fn main() {
    // Version metadata shown in About, logs and /health (see lib.rs BUILD_*).
    let sha = std::env::var("GITHUB_SHA").ok().filter(|s| !s.is_empty()).or_else(|| {
        std::process::Command::new("git").args(["rev-parse", "HEAD"]).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    });
    println!("cargo:rustc-env=MARKET_EDGE_GIT_SHA={}", sha.unwrap_or_else(|| "unknown".into()));
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    println!("cargo:rustc-env=MARKET_EDGE_BUILD_EPOCH={secs}");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    tauri_build::build()
}
