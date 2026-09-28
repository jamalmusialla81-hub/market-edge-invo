//! Where the app's programs live (installed resources) and where its state
//! lives (the OS app-data directory), plus the execution-mode gate.
//!
//! Installed app (the only layout a release build accepts when its bundle is
//! present): everything runs from the app's own resources, next to the
//! executable --
//!   Market Edge.app/Contents/Resources/   (macOS)
//!   <install dir>/                        (Windows)
//!     execution-service/market-edge-exec[.exe]   frozen Python service (PyInstaller)
//!     runtime/node[.exe]                         private Node.js runtime
//!     signal-bridge/signal-bridge/forward_loop.mjs  unmodified repo sources
//!     migrations/  config/
//! Nothing in there is ever written to. Mutable state (SQLite DB, config,
//! logs, backups) lives in the app-data directory:
//!   macOS   ~/Library/Application Support/Market Edge/
//!   Windows %APPDATA%\Market Edge\
//!   Linux   ~/.local/share/Market Edge/
//!
//! Developer layout (repo checkout + system Python/Node) is only used when no
//! bundle exists AND the build is a debug build or MARKET_EDGE_DEV=1. An
//! installed app never falls back to a repository.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 8765;
pub const DEFAULT_CYCLE_INTERVAL_MS: u64 = 300_000; // production's 5-minute scan cadence
pub const APP_DIR_NAME: &str = "Market Edge";
pub const DB_FILE: &str = "market_edge_paper.sqlite3";
/// Shadow-learning research database (execution-service `shadow/store.py`):
/// its own file next to the paper ledger, never mixed with it.
pub const SHADOW_DB_FILE: &str = "market_edge_shadow_research.sqlite3";
pub const LEGACY_IDENTIFIER_DIR: &str = "com.marketedge.desktop"; // desktop MVP (0.1.0 dev builds) data dir

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LayoutKind {
    Bundled,
    DevRepo,
}

#[derive(Debug, Clone, Serialize)]
pub struct Layout {
    pub kind: LayoutKind,
    pub resource_dir: Option<PathBuf>,
    pub repo_root: Option<PathBuf>,
    /// execution-service: program + args; run with the data dir (bundled) or
    /// execution-service/ (dev) as working directory.
    pub exec_program: PathBuf,
    pub exec_args: Vec<String>,
    pub exec_cwd: Option<PathBuf>,
    pub node: PathBuf,
    pub loop_script: PathBuf,
    pub loop_cwd: Option<PathBuf>,
    pub scanner_file: PathBuf,
    pub migrations_dir: Option<PathBuf>,
    pub build_info_file: Option<PathBuf>,
    pub defaults_file: Option<PathBuf>,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// `std::env::current_exe()` on Windows can return an extended-length
/// (`\\?\...`) verbatim path. That path is fine for our own file I/O, but
/// Node's CJS main-module resolution (`fs.realpathSync` inside
/// `resolveMainPath`) mishandles it and collapses it down to a bare drive
/// root, crashing the frozen forward loop with `EISDIR: lstat 'C:'` before
/// it runs a single cycle. Strip the prefix from every path built off the
/// exe location so nothing downstream (Node, Python, our own logs) ever
/// sees a verbatim path.
pub fn de_verbatim(p: PathBuf) -> PathBuf {
    if !cfg!(windows) {
        return p;
    }
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// The installed layout, if `resource_dir` holds one. Err when a bundle is
/// present but incomplete -- that is a broken install, not a reason to go
/// looking for a repository.
pub fn bundled_layout(resource_dir: &Path) -> Option<Result<Layout, String>> {
    let exec = resource_dir.join("execution-service").join(exe("market-edge-exec"));
    let node = resource_dir.join("runtime").join(exe("node"));
    let script = resource_dir.join("signal-bridge").join("signal-bridge").join("forward_loop.mjs");
    let markers = [&exec, &node, &script];
    let present: Vec<_> = markers.iter().filter(|p| p.exists()).collect();
    if present.is_empty() {
        return None;
    }
    if present.len() != markers.len() {
        let missing: Vec<String> = markers.iter().filter(|p| !p.exists()).map(|p| p.display().to_string()).collect();
        return Some(Err(format!("installed app is incomplete; missing {}", missing.join(", "))));
    }
    Some(Ok(Layout {
        kind: LayoutKind::Bundled,
        resource_dir: Some(resource_dir.to_path_buf()),
        repo_root: None,
        exec_program: exec,
        exec_args: vec![],
        exec_cwd: None,
        node,
        loop_script: script,
        loop_cwd: None,
        scanner_file: resource_dir.join("signal-bridge").join("backend").join("scan-core.mjs"),
        migrations_dir: Some(resource_dir.join("migrations")),
        build_info_file: Some(resource_dir.join("config").join("build_info.json")),
        defaults_file: Some(resource_dir.join("config").join("defaults.json")),
    }))
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
    let p = if cfg!(windows) {
        repo.join("execution-service").join(".venv").join("Scripts").join("python.exe")
    } else {
        repo.join("execution-service").join(".venv").join("bin").join("python")
    };
    p.is_file().then_some(p)
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty())
}

/// Developer layout: a repo checkout with system (or venv) Python and Node.
pub fn dev_layout(repo: &Path) -> Layout {
    let python = env("MARKET_EDGE_PYTHON")
        .map(PathBuf::from)
        .or_else(|| venv_python(repo))
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "python" } else { "python3" }));
    Layout {
        kind: LayoutKind::DevRepo,
        resource_dir: None,
        repo_root: Some(repo.to_path_buf()),
        exec_program: python,
        exec_args: vec!["run_server.py".into()],
        exec_cwd: Some(repo.join("execution-service")),
        node: PathBuf::from(env("MARKET_EDGE_NODE").unwrap_or_else(|| "node".into())),
        loop_script: repo.join("signal-bridge").join("forward_loop.mjs"),
        loop_cwd: Some(repo.to_path_buf()),
        scanner_file: repo.join("backend").join("scan-core.mjs"),
        migrations_dir: None,
        build_info_file: None,
        defaults_file: None,
    }
}

/// Bundle first, always. The repository is only considered when there is no
/// bundle and `allow_dev` (debug build or MARKET_EDGE_DEV=1).
pub fn resolve_layout(resource_dir: Option<&Path>, allow_dev: bool) -> Result<Layout, String> {
    if let Some(found) = resource_dir.and_then(bundled_layout) {
        return found;
    }
    if !allow_dev {
        return Err(format!(
            "bundled services not found in {} -- reinstall Market Edge",
            resource_dir.map(|p| p.display().to_string()).unwrap_or_else(|| "(no resource directory)".into())
        ));
    }
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
    find_repo_root(&starts).map(|r| dev_layout(&r)).ok_or_else(|| "developer build: Market Edge repository not found (set MARKET_EDGE_HOME)".into())
}

pub fn dev_allowed() -> bool {
    cfg!(debug_assertions) || env("MARKET_EDGE_DEV").as_deref() == Some("1")
}

/// OS app-data directory ("Market Edge"); MARKET_EDGE_DATA_DIR overrides it
/// (tests, portable use).
pub fn data_dir() -> PathBuf {
    if let Some(d) = env("MARKET_EDGE_DATA_DIR") {
        return PathBuf::from(d);
    }
    dirs::data_dir().unwrap_or_else(std::env::temp_dir).join(APP_DIR_NAME)
}

// ---------------------------------------------------------------------------
// user settings (non-secret) kept in <data dir>/config.json
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UserConfig {
    #[serde(default = "one")]
    pub schema: u32,
    /// Start the forward paper loop when the app starts. Set by START PAPER,
    /// cleared by STOP PAPER, so the app comes back the way it was left.
    #[serde(default = "yes")]
    pub auto_start_paper: bool,
    #[serde(default)]
    pub first_run_at: Option<String>,
    #[serde(default)]
    pub last_app_version: Option<String>,
    #[serde(default)]
    pub versions_seen: Vec<String>,
}
fn one() -> u32 {
    1
}
fn yes() -> bool {
    true
}

impl Default for UserConfig {
    fn default() -> Self {
        UserConfig { schema: 1, auto_start_paper: true, first_run_at: None, last_app_version: None, versions_seen: vec![] }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FirstRun {
    pub first_run: bool,
    pub upgraded_from: Option<String>,
    pub imported_legacy_db: Option<PathBuf>,
    pub created: Vec<String>,
}

pub fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

pub fn load_user_config(data_dir: &Path) -> Option<UserConfig> {
    std::fs::read_to_string(config_path(data_dir)).ok().and_then(|s| serde_json::from_str(&s).ok())
}

/// Atomic write (temp file + rename) so a crash never leaves half a config.
pub fn save_user_config(data_dir: &Path, cfg: &UserConfig) -> std::io::Result<()> {
    let tmp = data_dir.join("config.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(cfg).unwrap_or_default())?;
    std::fs::rename(tmp, config_path(data_dir))
}

/// First launch (or first launch of a new version): create the app-data
/// layout and config. Never touches an existing database; the
/// execution-service creates/migrates it (with a backup) on start.
pub fn init_data_dir(data_dir: &Path, defaults: Option<&Path>, app_version: &str, legacy_dir: Option<&Path>) -> std::io::Result<(UserConfig, FirstRun)> {
    let mut created = Vec::new();
    for d in [data_dir.to_path_buf(), data_dir.join("logs"), data_dir.join("backups")] {
        if !d.is_dir() {
            std::fs::create_dir_all(&d)?;
            created.push(d.display().to_string());
        }
    }
    // The desktop MVP kept its DB under the bundle identifier. Copy (never
    // move) it once, so a user of that build keeps their paper account.
    let mut imported = None;
    let db = data_dir.join(DB_FILE);
    if !db.exists() {
        if let Some(old) = legacy_dir.map(|d| d.join(DB_FILE)).filter(|p| p.is_file()) {
            std::fs::copy(&old, &db)?;
            imported = Some(old);
        }
    }
    let existing = load_user_config(data_dir);
    let first_run = existing.is_none();
    let mut cfg = existing.unwrap_or_else(|| {
        let mut c = UserConfig::default();
        if let Some(v) = defaults.and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
            if let Some(b) = v.get("auto_start_paper").and_then(|b| b.as_bool()) {
                c.auto_start_paper = b;
            }
        }
        c.first_run_at = Some(crate::logs::iso_now());
        created.push(config_path(data_dir).display().to_string());
        c
    });
    let upgraded_from = cfg.last_app_version.clone().filter(|v| v != app_version);
    cfg.last_app_version = Some(app_version.to_string());
    if !cfg.versions_seen.iter().any(|v| v == app_version) {
        cfg.versions_seen.push(app_version.to_string());
    }
    save_user_config(data_dir, &cfg)?;
    Ok((cfg, FirstRun { first_run, upgraded_from, imported_legacy_db: imported, created }))
}

#[derive(Debug, Clone, Serialize)]
pub struct AppConfig {
    pub layout: Layout,
    pub port: u16,
    pub db_path: PathBuf,
    pub shadow_db_path: PathBuf,
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub cycle_interval_ms: u64,
    pub hummingbot_mode: String,
}

impl AppConfig {
    pub fn new(layout: Layout, data_dir: PathBuf) -> Self {
        AppConfig {
            layout,
            port: env("MARKET_EDGE_EXEC_PORT").and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT),
            db_path: data_dir.join(DB_FILE),
            shadow_db_path: data_dir.join(SHADOW_DB_FILE),
            logs_dir: data_dir.join("logs"),
            backups_dir: data_dir.join("backups"),
            cycle_interval_ms: env("MARKET_EDGE_CYCLE_INTERVAL_MS").and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_CYCLE_INTERVAL_MS),
            // Hummingbot stays off in the desktop app; there is no fallback
            // from "real" to mock (see hummingbot/factory.py).
            hummingbot_mode: "disabled".into(),
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
            reason: Some("Not wired into the desktop app; the real Nautilus BacktestEngine ships in the bundle (nautilus-selftest) and runs in CI.".into()),
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
    fn de_verbatim_strips_the_windows_extended_length_prefix() {
        if cfg!(windows) {
            assert_eq!(de_verbatim(PathBuf::from(r"\\?\C:\Users\x\Market Edge")), PathBuf::from(r"C:\Users\x\Market Edge"));
            assert_eq!(de_verbatim(PathBuf::from(r"\\?\UNC\server\share\x")), PathBuf::from(r"\\server\share\x"));
        }
        // a plain path is unchanged everywhere, including off Windows where the prefix is a no-op
        assert_eq!(de_verbatim(PathBuf::from("plain/path")), PathBuf::from("plain/path"));
    }

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

    fn fake_bundle(dir: &Path) {
        for (d, f) in [("execution-service", exe("market-edge-exec")), ("runtime", exe("node")), ("signal-bridge/signal-bridge", "forward_loop.mjs".into())] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
            std::fs::write(dir.join(d).join(f), "").unwrap();
        }
    }

    #[test]
    fn bundle_wins_and_points_only_inside_the_resources() {
        let res = tempfile::tempdir().unwrap();
        fake_bundle(res.path());
        // even with dev allowed and a repo reachable from cwd, the bundle is used
        let layout = resolve_layout(Some(res.path()), true).unwrap();
        assert_eq!(layout.kind, LayoutKind::Bundled);
        assert!(layout.repo_root.is_none());
        for p in [&layout.exec_program, &layout.node, &layout.loop_script, &layout.scanner_file] {
            assert!(p.starts_with(res.path()), "{} escapes the bundle", p.display());
        }
        assert!(layout.exec_args.is_empty() && layout.exec_cwd.is_none() && layout.loop_cwd.is_none());
    }

    #[test]
    fn release_without_bundle_never_falls_back_to_a_repo() {
        let empty = tempfile::tempdir().unwrap();
        // cwd (the test runs inside the repo) would be found if fallback existed
        let err = resolve_layout(Some(empty.path()), false).unwrap_err();
        assert!(err.contains("bundled services not found"), "{err}");
        assert!(resolve_layout(None, false).is_err());
    }

    #[test]
    fn incomplete_bundle_is_an_error_not_a_fallback() {
        let res = tempfile::tempdir().unwrap();
        fake_bundle(res.path());
        std::fs::remove_file(res.path().join("runtime").join(exe("node"))).unwrap();
        let err = resolve_layout(Some(res.path()), true).unwrap_err();
        assert!(err.contains("incomplete") && err.contains("node"), "{err}");
    }

    #[test]
    fn dev_layout_is_found_from_this_checkout_in_debug_builds() {
        let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = find_repo_root(&[here]).expect("desktop/ lives inside the market-edge repo");
        assert!(is_repo_root(&root));
        assert_eq!(dev_layout(&root).kind, LayoutKind::DevRepo);
    }

    #[test]
    fn first_run_creates_layout_and_later_runs_keep_state() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("Market Edge");
        let defaults = tmp.path().join("defaults.json");
        std::fs::write(&defaults, r#"{"auto_start_paper": false}"#).unwrap();
        let (cfg, fr) = init_data_dir(&data, Some(&defaults), "0.1.0", None).unwrap();
        assert!(fr.first_run && fr.upgraded_from.is_none());
        assert!(data.join("logs").is_dir() && data.join("backups").is_dir() && config_path(&data).is_file());
        assert!(!cfg.auto_start_paper && cfg.first_run_at.is_some());
        // user changes a setting; the DB exists; an app update (new version) runs init again
        let mut c = cfg.clone();
        c.auto_start_paper = true;
        save_user_config(&data, &c).unwrap();
        std::fs::write(data.join(DB_FILE), b"db-bytes").unwrap();
        let (cfg2, fr2) = init_data_dir(&data, Some(&defaults), "0.2.0", None).unwrap();
        assert!(!fr2.first_run);
        assert_eq!(fr2.upgraded_from.as_deref(), Some("0.1.0"));
        assert!(cfg2.auto_start_paper, "user setting survives an update");
        assert_eq!(cfg2.first_run_at, cfg.first_run_at);
        assert_eq!(cfg2.versions_seen, vec!["0.1.0", "0.2.0"]);
        assert_eq!(std::fs::read(data.join(DB_FILE)).unwrap(), b"db-bytes", "init never touches the database");
    }

    #[test]
    fn legacy_database_is_copied_not_moved_and_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join(LEGACY_IDENTIFIER_DIR);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join(DB_FILE), b"old").unwrap();
        let data = tmp.path().join("Market Edge");
        let (_, fr) = init_data_dir(&data, None, "0.1.0", Some(&legacy)).unwrap();
        assert!(fr.imported_legacy_db.is_some());
        assert_eq!(std::fs::read(data.join(DB_FILE)).unwrap(), b"old");
        assert!(legacy.join(DB_FILE).is_file());
        std::fs::write(data.join(DB_FILE), b"new").unwrap();
        let (_, fr) = init_data_dir(&data, None, "0.1.0", Some(&legacy)).unwrap();
        assert!(fr.imported_legacy_db.is_none());
        assert_eq!(std::fs::read(data.join(DB_FILE)).unwrap(), b"new");
    }
}
