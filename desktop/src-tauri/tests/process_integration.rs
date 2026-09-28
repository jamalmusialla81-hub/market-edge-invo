//! Real process tests: launch the actual execution-service and forward loop
//! through the same `Services` / `Supervisor` / `backup` code the app uses,
//! against throwaway app-data directories. Nothing is mocked.
//!
//! Two layouts:
//! - MARKET_EDGE_BUNDLE_DIR=<desktop/src-tauri/bundle>: the staged installed-app
//!   resources (frozen PyInstaller service + bundled Node runtime). Run by CI
//!   on every OS before packaging.
//! - otherwise the developer layout (MARKET_EDGE_PYTHON with nautilus_trader).
//! Opt-in: MARKET_EDGE_INTEGRATION=1 (needs network for the live scan).

use market_edge_desktop_lib::backup;
use market_edge_desktop_lib::config::{bundled_layout, dev_layout, find_repo_root, AppConfig, Layout, LayoutKind, UserConfig};
use market_edge_desktop_lib::logs::LogStore;
use market_edge_desktop_lib::process::{ProcState, Services};
use market_edge_desktop_lib::supervisor::{Supervisor, REASON_OFFLINE, REASON_RECOVERY};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const KEY: &str = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk";

fn enabled() -> bool {
    let on = std::env::var("MARKET_EDGE_INTEGRATION").ok().as_deref() == Some("1");
    if !on {
        eprintln!("skipped: set MARKET_EDGE_INTEGRATION=1 (and MARKET_EDGE_BUNDLE_DIR or MARKET_EDGE_PYTHON)");
    }
    on
}

fn repo() -> PathBuf {
    find_repo_root(&[PathBuf::from(env!("CARGO_MANIFEST_DIR"))]).unwrap()
}

fn layout() -> Layout {
    match std::env::var("MARKET_EDGE_BUNDLE_DIR").ok().filter(|s| !s.is_empty()) {
        Some(dir) => {
            let l = bundled_layout(Path::new(&dir)).expect("bundle present").expect("bundle complete");
            eprintln!("layout: BUNDLED {dir}");
            l
        }
        None => dev_layout(&repo()),
    }
}

fn config(data: &Path, port: u16) -> AppConfig {
    let mut cfg = AppConfig::new(layout(), data.to_path_buf());
    cfg.port = port;
    cfg.cycle_interval_ms = 600_000;
    std::fs::create_dir_all(&cfg.backups_dir).unwrap();
    cfg
}

fn req(cfg: &AppConfig, method: reqwest::Method, path: &str, body: Option<Value>) -> (u16, Value) {
    let mut r = reqwest::blocking::Client::builder().no_proxy().build().unwrap().request(method, format!("{}{}", cfg.base_url(), path)).header("X-API-Key", KEY);
    if let Some(b) = body {
        r = r.json(&b);
    }
    let r = r.send().unwrap();
    let status = r.status().as_u16();
    (status, r.json().unwrap_or(Value::Null))
}
fn get(cfg: &AppConfig, path: &str) -> Value {
    req(cfg, reqwest::Method::GET, path, None).1
}

fn wait_until(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

#[test]
fn starts_real_service_runs_and_stops_loop_and_shuts_down_cleanly() {
    if !enabled() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let cfg = config(tmp.path(), 18765);
    let logs = Arc::new(LogStore::new(Some(&tmp.path().join("logs"))));
    let services = Services::new(cfg.clone(), KEY.into(), logs.clone());

    // 1. start + health
    let status = services.start_execution_service().expect("execution-service starts");
    assert_eq!(status.state, ProcState::Running);
    if cfg.layout.kind == LayoutKind::Bundled {
        assert!(status.program.as_deref().unwrap().contains("market-edge-exec"), "{status:?}");
    }
    let sys = get(&cfg, "/system/status");
    assert_eq!(sys["paper_only"], true);
    assert_eq!(sys["nautilus"]["ok"], true, "{sys}");
    assert_eq!(sys["sqlite"]["quick_check"], "ok");
    assert_eq!(sys["version"], "0.1.0");
    let health = reqwest::blocking::Client::builder().no_proxy().build().unwrap().get(format!("{}/health", cfg.base_url())).send().unwrap().json::<Value>().unwrap();
    assert_eq!(health["version"], "0.1.0");
    assert!(health["schema_version"].as_u64().unwrap() >= 2, "{health}");
    if cfg.layout.kind == LayoutKind::Bundled {
        assert_eq!(health["build"]["frozen"], true, "{health}");
    }
    let wrong = reqwest::blocking::Client::builder().no_proxy().build().unwrap().get(format!("{}/paper/account", cfg.base_url())).header("X-API-Key", "wrong").send().unwrap();
    assert_eq!(wrong.status().as_u16(), 401);
    assert_eq!(get(&cfg, "/paper/account")["starting_equity"], 10000.0);

    // 2. a second controller with a different key must not adopt it
    let intruder = Services::new(cfg.clone(), "x".repeat(64), Arc::new(LogStore::new(None)));
    assert!(intruder.start_execution_service().unwrap_err().contains("rejects this app's API key"));
    let twin = Services::new(cfg.clone(), KEY.into(), Arc::new(LogStore::new(None)));
    assert_eq!(twin.start_execution_service().unwrap().state, ProcState::Adopted);
    twin.shutdown_all();
    assert_eq!(get(&cfg, "/health")["status"], "ok", "an adopted service is never stopped by the adopter");

    // 3. START PAPER runs one real cycle; STOP ends it after that cycle
    let st = services.start_loop().expect("loop starts");
    if cfg.layout.kind == LayoutKind::Bundled {
        assert!(st.program.as_deref().unwrap().contains("runtime"), "bundled node runtime: {st:?}");
    }
    assert!(wait_until(Duration::from_secs(300), || logs.loop_telemetry().cycles_seen > 0));
    let telemetry = logs.loop_telemetry();
    eprintln!("first real cycle outcome: {:?}, reconciled {:?}", telemetry.last_outcome, telemetry.last_reconciled);
    services.stop_loop(Duration::from_secs(240)).unwrap();
    assert!(wait_until(Duration::from_secs(250), || services.loop_status().pid.is_none()));
    let loop_status = services.loop_status();
    assert_eq!(loop_status.state, ProcState::Stopped, "{loop_status:?}");
    assert!(loop_status.last_exit.as_deref().unwrap_or("").ends_with(": 0"), "graceful exit: {loop_status:?}");
    assert!(services.take_loop_crash().is_none(), "a requested stop is not a crash");
    let sys = get(&cfg, "/system/status");
    assert!(sys["segments"].as_array().unwrap().last().unwrap()["ended_at_ms"].is_number(), "loop closed its runtime segment: {sys}");
    let signals = get(&cfg, "/paper/signals");
    if telemetry.last_outcome.as_deref() == Some("ERROR") {
        eprintln!("cycle failed closed (no market data reachable); signal assertions skipped");
    } else {
        assert!(!signals["signals"].as_array().unwrap().is_empty(), "the real cycle recorded a signal or NO_TRADE");
    }
    // separate rotating log files
    for f in ["desktop", "execution-service", "forward-loop", "reconciliation"] {
        assert!(tmp.path().join("logs").join(format!("{f}.log")).is_file(), "{f}.log");
    }

    // 4. app exit: graceful shutdown through /system/shutdown
    services.shutdown_all();
    assert_eq!(services.exec_status().state, ProcState::Stopped);
    assert!(services.take_exec_crash().is_none(), "a requested shutdown is not a crash");
    let lines = logs.since(0, usize::MAX);
    assert!(lines.iter().any(|l| l.message.contains("execution-service stopped")), "stopped gracefully, not killed");

    // 5. restart on the same DB: state persisted
    let again = Services::new(cfg.clone(), KEY.into(), Arc::new(LogStore::new(None)));
    again.start_execution_service().unwrap();
    assert_eq!(get(&cfg, "/paper/signals")["signals"].as_array().unwrap().len(), signals["signals"].as_array().unwrap().len());
    again.shutdown_all();
}

/// Minimal HTTP server answering every request with `body` (fresh "live" mids).
fn serve_mids(body: &'static str) -> (String, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/info", listener.local_addr().unwrap());
    let h = std::thread::spawn(move || {
        for stream in listener.incoming().take(20) {
            let Ok(mut s) = stream else { continue };
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    (url, h)
}

#[test]
fn supervisor_recovers_crashes_with_bounds_and_gates_on_market_data() {
    if !enabled() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let cfg = config(tmp.path(), 18766);
    let logs = Arc::new(LogStore::new(Some(&tmp.path().join("logs"))));
    let services = Arc::new(Services::new(cfg.clone(), KEY.into(), logs.clone()));
    let (mids_url, _server) = serve_mids(r#"{"BTC":"60000.5","ETH":"3000.1"}"#);
    let sup = Supervisor::with_options(services.clone(), logs.clone(), mids_url.clone(), Duration::from_millis(100));
    services.start_execution_service().unwrap();

    // --- market data offline: entries paused, no invented prices; only fresh data resumes
    sup.set_probe_url("http://127.0.0.1:9/info");
    sup.probe_market();
    assert_eq!(sup.market().online, Some(false));
    let st = get(&cfg, "/system/status");
    assert_eq!(st["entries_paused"], true);
    assert_eq!(st["entries_paused_reason"], REASON_OFFLINE);
    sup.set_probe_url(&mids_url);
    sup.probe_market();
    assert_eq!(sup.market().online, Some(true));
    assert_eq!(sup.market().markets, 2);
    assert_eq!(get(&cfg, "/system/status")["entries_paused"], false, "fresh prices lift the offline pause");
    // an operator pause is never lifted by the market gate
    req(&cfg, reqwest::Method::POST, "/control/pause", Some(json!({"reason": "DESKTOP_PAUSE"})));
    sup.set_probe_url("http://127.0.0.1:9/info");
    sup.probe_market();
    sup.set_probe_url(&mids_url);
    sup.probe_market();
    assert_eq!(get(&cfg, "/system/status")["entries_paused_reason"], "DESKTOP_PAUSE");
    req(&cfg, reqwest::Method::POST, "/control/resume", None);

    // --- crash: restarted, paused before anything else, reconciled, then resumed
    let first_pid = services.exec_pid().unwrap();
    assert!(services.kill_execution_service_for_test());
    assert!(wait_until(Duration::from_secs(10), || services.exec_status().state == ProcState::Failed));
    sup.tick(); // detects the crash and runs the bounded recovery synchronously
    let view = sup.view();
    assert!(view.last_exec_crash.is_some(), "{view:?}");
    assert_eq!(view.exec_restarts_in_window, 1);
    assert_eq!(services.exec_status().state, ProcState::Running);
    assert_ne!(services.exec_pid().unwrap(), first_pid);
    let st = get(&cfg, "/system/status");
    assert_eq!(st["entries_paused"], false, "clean reconciliation lifted the recovery pause: {st}");
    assert_eq!(st["last_reconcile"]["reconciled"], true);
    let audit: Vec<String> = st["control_audit"].as_array().unwrap().iter().map(|a| format!("{} {}", a["action"], a["payload"])).collect();
    assert!(audit.iter().any(|a| a.contains("PAUSE_NEW_ENTRIES") && a.contains(REASON_RECOVERY)), "paused before resuming: {audit:?}");
    let rec = std::fs::read_to_string(tmp.path().join("logs").join("reconciliation.log")).unwrap();
    assert!(rec.contains("post-restart reconciliation"), "{rec}");

    // an operator pause survives a crash recovery
    req(&cfg, reqwest::Method::POST, "/control/pause", Some(json!({"reason": "DESKTOP_PAUSE"})));
    services.kill_execution_service_for_test();
    assert!(wait_until(Duration::from_secs(10), || services.exec_status().state == ProcState::Failed));
    sup.tick();
    assert_eq!(get(&cfg, "/system/status")["entries_paused_reason"], "DESKTOP_PAUSE");

    // bounded: the next crash in the window is the 3rd restart, the one after is refused
    services.kill_execution_service_for_test();
    assert!(wait_until(Duration::from_secs(10), || services.exec_status().state == ProcState::Failed));
    sup.tick();
    assert_eq!(sup.view().exec_restarts_in_window, 3);
    services.kill_execution_service_for_test();
    assert!(wait_until(Duration::from_secs(10), || services.exec_status().state == ProcState::Failed));
    sup.tick();
    let view = sup.view();
    assert!(view.exec_gave_up.as_deref().unwrap_or("").contains("automatic restarts stopped"), "{view:?}");
    assert_eq!(services.exec_status().state, ProcState::Failed, "no infinite restart loop");
    sup.tick();
    assert_eq!(services.exec_status().state, ProcState::Failed);
    // the operator can restart explicitly
    sup.reset();
    services.start_execution_service().unwrap();
    services.shutdown_all();
}

#[test]
fn backup_export_validate_restore_and_legacy_migration() {
    if !enabled() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    // an existing user's pre-versioning database (desktop MVP)
    std::fs::copy(repo().join("execution-service/tests/fixtures/legacy_v0.sqlite3"), tmp.path().join("market_edge_paper.sqlite3")).unwrap();
    let cfg = config(tmp.path(), 18767);
    let logs = Arc::new(LogStore::new(None));
    let services = Services::new(cfg.clone(), KEY.into(), logs);
    services.start_execution_service().unwrap();
    let st = get(&cfg, "/system/status");
    assert_eq!(st["migration"]["from_version"], 0, "{st}");
    assert!(st["migration"]["backup_path"].as_str().unwrap().contains("pre-migration-v0"));
    let risk = get(&cfg, "/risk/config");
    assert_eq!(risk["starting_equity"], 25000.0, "legacy data preserved: {risk}");
    assert_eq!(risk["settings"]["max_risk_per_trade_pct"], 0.5);

    // shadow research evidence exists before the backup (one no-trade scan)
    let shadow_scan = |id: &str, ts: u64| json!({"scan": {"scan_id": id, "decision_ts": ts, "generator_version": "g", "feature_version": "f",
        "execution": {"decision": "NO_SIGNAL"}}, "observations": [{"kind": "MARKET_STATE", "asset": "BTC", "production_state": "NO_TRADE",
        "decision": {"market": {"price": 100.0, "data_age_ms": 1000}}}]});
    let (code, body) = req(&cfg, reqwest::Method::POST, "/shadow/scan", Some(shadow_scan("scan-backup-1", 1_790_000_000_000)));
    assert_eq!(code, 200, "{body}");
    let shadow_obs = || get(&cfg, "/shadow/summary?since_ms=0")["observations"].as_u64().unwrap();
    assert_eq!(shadow_obs(), 1);

    // export while running (online snapshot)
    let dest = tmp.path().join("exports").join("b.mebackup");
    let user = UserConfig::default();
    let manifest = backup::export(&cfg, &user, &dest, "0.1.0", "test").unwrap();
    assert!(!manifest.secrets_included);
    assert!(!manifest.cloud_backup, "backups are local files only");
    assert!(manifest.schema_version >= 2);
    assert!(manifest.shadow_included, "shadow research database is in the backup");
    assert_eq!(manifest.shadow_counts["shadow_observations"], 1, "{:?}", manifest.shadow_counts);
    let names = backup::entries(&dest).unwrap();
    assert_eq!(names.len(), 4, "{names:?}");
    assert!(names.iter().any(|n| n == backup::SHADOW_ENTRY), "{names:?}");
    let bytes = std::fs::read(&dest).unwrap();
    assert!(!bytes.windows(KEY.len()).any(|w| w == KEY.as_bytes()), "the service API key never enters a backup");

    // change state (paper + shadow), then restore the backup
    req(&cfg, reqwest::Method::PUT, "/risk/config", Some(json!({"max_risk_per_trade_pct": 1.5})));
    assert_eq!(get(&cfg, "/risk/config")["settings"]["max_risk_per_trade_pct"], 1.5);
    req(&cfg, reqwest::Method::POST, "/shadow/scan", Some(shadow_scan("scan-backup-2", 1_790_000_300_000)));
    assert_eq!(shadow_obs(), 2);
    let inspection = backup::inspect(&cfg, &dest).unwrap();
    assert_eq!(inspection.validation["ok"], true);
    assert_eq!(inspection.shadow_validation["ok"], true, "{}", inspection.shadow_validation);
    services.stop_execution_service();
    let outcome = backup::restore(&cfg, &inspection).unwrap();
    assert!(outcome.previous_db.expect("previous DB kept").is_file());
    assert!(outcome.shadow_restored);
    assert!(outcome.previous_shadow_db.expect("previous shadow DB kept").is_file());
    services.start_execution_service().unwrap();
    let risk = get(&cfg, "/risk/config");
    assert_eq!(risk["settings"]["max_risk_per_trade_pct"], 0.5, "restored settings: {risk}");
    assert_eq!(risk["starting_equity"], 25000.0);
    assert_eq!(shadow_obs(), 1, "shadow observations restored to the backup's state");

    // corrupted / foreign files are rejected before anything is touched
    let mut corrupt = bytes.clone();
    let n = corrupt.len();
    for b in &mut corrupt[n / 2..n / 2 + 64] {
        *b ^= 0xff;
    }
    let bad = tmp.path().join("corrupt.mebackup");
    std::fs::write(&bad, &corrupt).unwrap();
    assert!(backup::inspect(&cfg, &bad).is_err());
    let junk = tmp.path().join("junk.mebackup");
    std::fs::write(&junk, b"hello").unwrap();
    assert!(backup::inspect(&cfg, &junk).unwrap_err().contains("not a Market Edge backup"));
    assert_eq!(get(&cfg, "/risk/config")["settings"]["max_risk_per_trade_pct"], 0.5);
    services.shutdown_all();
}
