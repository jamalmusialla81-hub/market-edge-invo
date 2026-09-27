//! Where the existing Market Edge stack lives on this machine, and the
//! execution-mode gate.
//!
//! The app does not bundle or rewrite the trading stack: it runs the repo's
//! own execution-service (Python) and forward loop (Node) from a checkout.
//! Resolution order for the checkout: MARKET_EDGE_HOME, then walking up from
//! the current directory and from the executable's directory until a folder
//! with execution-service/run_server.py and signal-bridge/forward_loop.mjs
//! is found.

use serde::Serialize;
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 8765;
pub const DEFAULT_CYCLE_INTERVAL_MS: u64 = 300_000; // production's 5-minute scan cadence

#[derive(Debug, Clone, Serialize)]
pub struct AppConfig {
    pub repo_root: Option<PathBuf>,
    pub python: String,
    pub node: String,
    pub port: u16,
    pub db_path: PathBuf,
    pub data_dir: PathBuf,
    pub cycle_interval_ms: u64,
    pub hummingbot_mode: String,
}

pub fn is_repo_root(dir: &Path) -> bool {
    dir.join("execution-service").join("run_server.py").is_file() && dir.join("signal-bridge").join("forward_loop.mjs").is_file()
}

pub fn find_repo_root(starts: &[PathBuf]) -> Option<PathBuf> {
    for start in starts {
        let mut dir = Some(start.as_path());
        while let Some(d) = dir {
            if is_repo_root(d) {
                return Some(d.to_path_buf());
            }
            dir = d.parent();
        }
    }
    None
}

fn venv_python(repo: &Path) -> Option<PathBuf> {
    let candidates = if cfg!(windows) {
        vec![repo.join("execution-service").join(".venv").join("Scripts").join("python.exe")]
    } else {
        vec![repo.join("execution-service").join(".venv").join("bin").join("python")]
    };
    candidates.into_iter().find(|p| p.is_file())
}

impl AppConfig {
    pub fn resolve(data_dir: PathBuf) -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let mut starts = Vec::new();
        if let Some(home) = env("MARKET_EDGE_HOME") {
            starts.push(PathBuf::from(home));
        }
        if let Ok(cwd) = std::env::current_dir() {
            starts.push(cwd);
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                starts.push(parent.to_path_buf());
            }
        }
        let repo_root = find_repo_root(&starts);
        let python = env("MARKET_EDGE_PYTHON")
            .or_else(|| repo_root.as_deref().and_then(venv_python).map(|p| p.to_string_lossy().into_owned()))
            .unwrap_or_else(|| if cfg!(windows) { "python".into() } else { "python3".into() });
        AppConfig {
            repo_root,
            python,
            node: env("MARKET_EDGE_NODE").unwrap_or_else(|| "node".into()),
            port: env("MARKET_EDGE_EXEC_PORT").and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT),
            db_path: env("MARKET_EDGE_DB_PATH").map(PathBuf::from).unwrap_or_else(|| data_dir.join("market_edge_paper.sqlite3")),
            cycle_interval_ms: env("MARKET_EDGE_CYCLE_INTERVAL_MS").and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_CYCLE_INTERVAL_MS),
            // Hummingbot stays off unless explicitly enabled; there is no
            // fallback from "real" to mock (see hummingbot/factory.py).
            hummingbot_mode: env("HUMMINGBOT_MODE").unwrap_or_else(|| "disabled".into()),
            data_dir,
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

// ---------------------------------------------------------------------------
// Execution modes. LIVE is not a runtime setting: this constant is false and
// there is no code path that submits to a real-money venue. Changing it would
// still hit set_mode()'s explicit refusal below.
// ---------------------------------------------------------------------------
pub const LIVE_TRADING_ENABLED: bool = false;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ExecutionMode {
    Backtest,
    Paper,
    Testnet,
    Live,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModeAvailability {
    pub mode: ExecutionMode,
    pub enabled: bool,
    pub reason: Option<String>,
}

pub fn mode_availability() -> Vec<ModeAvailability> {
    vec![
        ModeAvailability {
            mode: ExecutionMode::Backtest,
            enabled: false,
            reason: Some("Not wired into the desktop MVP; the real Nautilus BacktestEngine runs in CI (diagnostics/real_backtest_scenarios.py).".into()),
        },
        ModeAvailability { mode: ExecutionMode::Paper, enabled: true, reason: None },
        ModeAvailability {
            mode: ExecutionMode::Testnet,
            enabled: false,
            reason: Some("No testnet backend is wired into execution-service yet. Testnet keys can be stored in the OS keychain now.".into()),
        },
        ModeAvailability { mode: ExecutionMode::Live, enabled: false, reason: Some("LIVE is disabled in this build. No real-money execution path exists.".into()) },
    ]
}

pub fn set_mode(requested: ExecutionMode) -> Result<ExecutionMode, String> {
    // Refused unconditionally -- deliberately not gated on LIVE_TRADING_ENABLED.
    if requested == ExecutionMode::Live {
        return Err("LIVE_DISABLED: real-money execution is not available in this build".into());
    }
    match mode_availability().into_iter().find(|m| m.mode == requested) {
        Some(m) if m.enabled => Ok(requested),
        Some(m) => Err(format!("{:?} unavailable: {}", requested, m.reason.unwrap_or_default()).to_uppercase()),
        None => Err("UNKNOWN_MODE".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_can_never_be_selected() {
        assert!(!LIVE_TRADING_ENABLED);
        assert!(set_mode(ExecutionMode::Live).unwrap_err().starts_with("LIVE_DISABLED"));
        assert!(!mode_availability().iter().find(|m| m.mode == ExecutionMode::Live).unwrap().enabled);
        let parsed: ExecutionMode = serde_json::from_str("\"LIVE\"").unwrap();
        assert!(set_mode(parsed).is_err());
    }

    #[test]
    fn paper_is_the_only_enabled_mode_for_now() {
        assert_eq!(set_mode(ExecutionMode::Paper).unwrap(), ExecutionMode::Paper);
        assert!(set_mode(ExecutionMode::Testnet).is_err());
        assert!(set_mode(ExecutionMode::Backtest).is_err());
    }

    #[test]
    fn finds_the_repo_root_by_walking_up() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("execution-service")).unwrap();
        std::fs::create_dir_all(root.join("signal-bridge")).unwrap();
        std::fs::write(root.join("execution-service/run_server.py"), "").unwrap();
        std::fs::write(root.join("signal-bridge/forward_loop.mjs"), "").unwrap();
        let deep = root.join("desktop/src-tauri/target/debug");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(find_repo_root(&[deep]).unwrap(), root.to_path_buf());
        assert!(find_repo_root(&[tempfile::tempdir().unwrap().path().to_path_buf()]).is_none());
    }

    #[test]
    fn this_checkout_is_detected() {
        let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = find_repo_root(&[here]).expect("desktop/ lives inside the market-edge repo");
        assert!(is_repo_root(&root));
    }
}
