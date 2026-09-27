//! Real process-management test: launches the repo's actual execution-service
//! (Python) and forward paper loop (Node) through the same `Services` code the
//! app uses, against a throwaway SQLite file. Nothing is mocked.
//!
//! Opt-in because it needs the Python environment (nautilus_trader, fastapi)
//! and network access for the live scan: set MARKET_EDGE_PYTHON to that
//! interpreter and MARKET_EDGE_INTEGRATION=1.

use market_edge_desktop_lib::config::{find_repo_root, AppConfig};
use market_edge_desktop_lib::logs::LogStore;
use market_edge_desktop_lib::process::{ProcState, Services};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn enabled() -> bool {
    std::env::var("MARKET_EDGE_INTEGRATION").ok().as_deref() == Some("1")
}

fn config(tmp: &std::path::Path, port: u16) -> AppConfig {
    let repo = find_repo_root(&[std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))]).unwrap();
    AppConfig {
        repo_root: Some(repo),
        python: std::env::var("MARKET_EDGE_PYTHON").unwrap_or_else(|_| "python3".into()),
        node: std::env::var("MARKET_EDGE_NODE").unwrap_or_else(|_| "node".into()),
        port,
        db_path: tmp.join("it.sqlite3"),
        data_dir: tmp.to_path_buf(),
        cycle_interval_ms: 600_000,
        hummingbot_mode: "disabled".into(),
    }
}

fn get(cfg: &AppConfig, key: &str, path: &str) -> (u16, serde_json::Value) {
    let r = reqwest::blocking::Client::new().get(format!("{}{}", cfg.base_url(), path)).header("X-API-Key", key).send().unwrap();
    let status = r.status().as_u16();
    (status, r.json().unwrap_or(serde_json::Value::Null))
}

#[test]
fn starts_real_service_runs_and_stops_loop_and_shuts_down_cleanly() {
    if !enabled() {
        eprintln!("skipped: set MARKET_EDGE_INTEGRATION=1 and MARKET_EDGE_PYTHON");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let cfg = config(tmp.path(), 18765);
    let logs = Arc::new(LogStore::new(Some(&tmp.path().join("desktop.log"))));
    let services = Services::new(cfg.clone(), "k".repeat(64), logs.clone());

    // 1. start + health
    let status = services.start_execution_service().expect("execution-service starts");
    assert_eq!(status.state, ProcState::Running);
    let (code, sys) = get(&cfg, &"k".repeat(64), "/system/status");
    assert_eq!(code, 200);
    assert_eq!(sys["paper_only"], true);
    assert_eq!(sys["nautilus"]["ok"], true, "{sys}");
    assert_eq!(sys["sqlite"]["quick_check"], "ok");
    assert_eq!(get(&cfg, "wrong-key", "/paper/account").0, 401);
    let (_, account) = get(&cfg, &"k".repeat(64), "/paper/account");
    assert_eq!(account["starting_equity"], 10000.0);

    // 2. a second controller with a different key must not adopt it
    let intruder = Services::new(cfg.clone(), "x".repeat(64), Arc::new(LogStore::new(None)));
    assert!(intruder.start_execution_service().unwrap_err().contains("rejects this app's API key"));
    // ...while one with the same key adopts it (and will not stop it)
    let twin = Services::new(cfg.clone(), "k".repeat(64), Arc::new(LogStore::new(None)));
    assert_eq!(twin.start_execution_service().unwrap().state, ProcState::Adopted);
    twin.shutdown_all();
    assert_eq!(get(&cfg, &"k".repeat(64), "/health").0, 200, "an adopted service is never stopped by the adopter");

    // 3. START PAPER runs one real cycle; STOP ends it after that cycle
    services.start_loop().expect("loop starts");
    let deadline = Instant::now() + Duration::from_secs(300);
    while logs.loop_telemetry().cycles_seen == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(500));
    }
    let telemetry = logs.loop_telemetry();
    assert!(telemetry.cycles_seen >= 1, "loop completed a real cycle: {telemetry:?}");
    eprintln!("first real cycle outcome: {:?}, reconciled {:?}", telemetry.last_outcome, telemetry.last_reconciled);
    services.stop_loop(Duration::from_secs(240)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(250);
    while services.loop_status().pid.is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
    }
    let loop_status = services.loop_status();
    assert_eq!(loop_status.state, ProcState::Stopped, "{loop_status:?}");
    assert!(loop_status.last_exit.as_deref().unwrap_or("").ends_with(": 0"), "graceful exit: {loop_status:?}");
    let (_, sys) = get(&cfg, &"k".repeat(64), "/system/status");
    let segments = sys["segments"].as_array().unwrap();
    assert!(segments.last().unwrap()["ended_at_ms"].is_number(), "loop closed its runtime segment: {sys}");
    let (_, signals) = get(&cfg, &"k".repeat(64), "/paper/signals");
    if telemetry.last_outcome.as_deref() == Some("ERROR") {
        // No exchange access (e.g. a sandbox without outbound market data):
        // the cycle fails closed and records nothing, which is correct.
        eprintln!("cycle failed closed (no market data reachable); signal assertions skipped");
    } else {
        assert!(!signals["signals"].as_array().unwrap().is_empty(), "the real cycle recorded a signal or NO_TRADE");
    }

    // 4. app exit: graceful shutdown through /system/shutdown
    services.shutdown_all();
    assert_eq!(services.exec_status().state, ProcState::Stopped);
    assert!(reqwest::blocking::Client::new().get(format!("{}/health", cfg.base_url())).timeout(Duration::from_secs(2)).send().is_err());
    let lines = logs.since(0, usize::MAX);
    assert!(lines.iter().any(|l| l.message.contains("execution-service stopped")), "stopped gracefully, not killed");

    // 5. restart on the same DB: state persisted
    let again = Services::new(cfg.clone(), "k".repeat(64), Arc::new(LogStore::new(None)));
    again.start_execution_service().unwrap();
    let (_, signals_after) = get(&cfg, &"k".repeat(64), "/paper/signals");
    assert_eq!(signals_after["signals"].as_array().unwrap().len(), signals["signals"].as_array().unwrap().len());
    again.shutdown_all();
}
