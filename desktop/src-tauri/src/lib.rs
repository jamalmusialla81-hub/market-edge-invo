//! Market Edge desktop controller.
//!
//! Desktop UI (React) -> Tauri IPC commands (this file) -> execution-service
//! HTTP API on 127.0.0.1 with an X-API-Key held only here -> Nautilus
//! portfolio / paper ledger / SQLite. The webview never sees the API key,
//! never opens the database, and can only call the commands registered below.
//! Canonical trading state stays in the execution-service's SQLite file; every
//! command reads it fresh.

pub mod config;
pub mod logs;
pub mod process;
pub mod secrets;

use config::{AppConfig, ExecutionMode};
use logs::{Level, LogStore};
use process::{ProcState, Services};
use secrets::{ApiKeySource, SecretBackend};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

pub struct AppState {
    pub services: Arc<Services>,
    pub logs: Arc<LogStore>,
    client: reqwest::Client,
    key_source: ApiKeySource,
    secrets: Arc<dyn SecretBackend>,
    mode: Mutex<ExecutionMode>,
    startup_error: Arc<Mutex<Option<String>>>,
    node_version: Mutex<Option<Result<String, String>>>,
    market_probe: Mutex<Option<(Instant, Value)>>,
}

type CmdResult<T> = Result<T, String>;

impl AppState {
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> CmdResult<Value> {
        let url = format!("{}{}", self.services.cfg.base_url(), path);
        let mut req = self.client.request(method, url).header("X-API-Key", self.services.api_key());
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await.map_err(|e| format!("execution-service unreachable: {e}"))?;
        let status = resp.status();
        let value: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let detail = value.get("detail").cloned().unwrap_or(value);
            return Err(format!("HTTP {}: {}", status.as_u16(), detail));
        }
        Ok(value)
    }
    async fn get(&self, path: &str) -> CmdResult<Value> {
        self.call(reqwest::Method::GET, path, None).await
    }
    async fn post(&self, path: &str, body: Value) -> CmdResult<Value> {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }
}

// ---------------------------------------------------------------------------
// read-only views (proxied; no trading state is held in the app)
// ---------------------------------------------------------------------------
#[tauri::command]
async fn get_account(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    state.get("/paper/account").await
}
#[tauri::command]
async fn get_positions(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    state.get("/paper/positions").await
}
#[tauri::command]
async fn get_trades(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    state.get("/paper/trades").await
}
#[tauri::command]
async fn get_signals(state: tauri::State<'_, AppState>, limit: Option<u32>) -> CmdResult<Value> {
    state.get(&format!("/paper/signals?limit={}", limit.unwrap_or(500).clamp(1, 5000))).await
}
#[tauri::command]
async fn get_performance(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    state.get("/paper/performance").await
}
#[tauri::command]
async fn get_risk_config(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    state.get("/risk/config").await
}
#[tauri::command]
async fn get_risk_usage(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    state.get("/risk/usage").await
}
#[tauri::command]
async fn update_risk_config(state: tauri::State<'_, AppState>, update: Value) -> CmdResult<Value> {
    if !update.is_object() {
        return Err("update must be an object".into());
    }
    let result = state.call(reqwest::Method::PUT, "/risk/config", Some(update.clone())).await;
    match &result {
        Ok(_) => state.logs.app(Level::Risk, format!("risk settings updated: {update}")),
        Err(e) => state.logs.app(Level::Warn, format!("risk settings rejected by backend: {e}")),
    }
    result
}
#[tauri::command]
fn get_logs(state: tauri::State<'_, AppState>, after_seq: Option<u64>, limit: Option<usize>) -> Vec<logs::LogEntry> {
    state.logs.since(after_seq.unwrap_or(0), limit.unwrap_or(1000).min(5000))
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------
#[tauri::command]
async fn start_paper(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    if *state.mode.lock().unwrap() != ExecutionMode::Paper {
        return Err("START PAPER is only available in PAPER mode".into());
    }
    let services = state.services.clone();
    let status = tauri::async_runtime::spawn_blocking(move || services.start_loop()).await.map_err(|e| e.to_string())??;
    Ok(json!(status))
}
#[tauri::command]
async fn stop_paper(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let services = state.services.clone();
    let status = tauri::async_runtime::spawn_blocking(move || services.stop_loop(process::LOOP_STOP_GRACE)).await.map_err(|e| e.to_string())??;
    Ok(json!(status))
}
#[tauri::command]
async fn reconcile_now(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let result = state.post("/reconcile", json!({})).await?;
    let ok = result.get("reconciled").and_then(Value::as_bool) == Some(true);
    state.logs.app(if ok { Level::Info } else { Level::Error }, format!("RECONCILE NOW: {result}"));
    Ok(result)
}
#[tauri::command]
async fn pause_entries(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let r = state.post("/control/pause", json!({"reason": "DESKTOP_PAUSE"})).await?;
    state.logs.app(Level::Risk, "PAUSE NEW ENTRIES: new trades blocked, exits continue");
    Ok(r)
}
#[tauri::command]
async fn resume_entries(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let r = state.post("/control/resume", json!({})).await?;
    state.logs.app(Level::Risk, "RESUME: new entries allowed (a kill switch, if engaged, stays engaged)");
    Ok(r)
}
#[tauri::command]
async fn kill_switch(state: tauri::State<'_, AppState>, confirm: String) -> CmdResult<Value> {
    if confirm != "KILL" {
        return Err("kill switch requires confirmation".into());
    }
    let r = state.post("/kill", json!({"reason": "MANUAL_KILL_SWITCH_DESKTOP"})).await?;
    state.logs.app(Level::Risk, "KILL SWITCH ENGAGED from desktop: no new intents; reduce-only exits still process");
    Ok(r)
}
#[tauri::command]
async fn clear_halt(state: tauri::State<'_, AppState>, confirm: String) -> CmdResult<Value> {
    if confirm != "CLEAR_HALT" {
        return Err("clearing a halt requires confirmation".into());
    }
    let r = state.post("/control/clear-halt", json!({"confirm": "CLEAR_HALT"})).await;
    match &r {
        Ok(_) => state.logs.app(Level::Risk, "halt cleared after clean reconciliation"),
        Err(e) => state.logs.app(Level::Error, format!("halt NOT cleared: {e}")),
    }
    r
}
#[tauri::command]
async fn restart_services(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let services = state.services.clone();
    let result = tauri::async_runtime::spawn_blocking(move || services.start_execution_service()).await.map_err(|e| e.to_string())?;
    *state.startup_error.lock().unwrap() = result.as_ref().err().cloned();
    Ok(json!(result?))
}

// ---------------------------------------------------------------------------
// modes, secrets, app info
// ---------------------------------------------------------------------------
#[tauri::command]
fn set_mode(state: tauri::State<'_, AppState>, mode: ExecutionMode) -> CmdResult<ExecutionMode> {
    let result = config::set_mode(mode);
    match &result {
        Ok(m) => *state.mode.lock().unwrap() = *m,
        Err(e) => state.logs.app(Level::Warn, format!("mode change refused: {e}")),
    }
    result
}
#[tauri::command]
fn secrets_status(state: tauri::State<'_, AppState>) -> Value {
    json!({"store": state.secrets.describe(), "secrets": secrets::operator_secret_status(state.secrets.as_ref()),
           "service_api_key": state.key_source})
}
#[tauri::command]
fn set_secret(state: tauri::State<'_, AppState>, name: String, value: String) -> CmdResult<Value> {
    secrets::set_operator_secret(state.secrets.as_ref(), &name, &value).map_err(|e| e.to_string())?;
    state.logs.app(Level::Info, format!("secret '{name}' stored in {}", state.secrets.describe()));
    Ok(secrets_status(state))
}
#[tauri::command]
fn delete_secret(state: tauri::State<'_, AppState>, name: String) -> CmdResult<Value> {
    secrets::delete_operator_secret(state.secrets.as_ref(), &name).map_err(|e| e.to_string())?;
    state.logs.app(Level::Info, format!("secret '{name}' removed"));
    Ok(secrets_status(state))
}
#[tauri::command]
fn app_info(state: tauri::State<'_, AppState>) -> Value {
    let cfg = &state.services.cfg;
    json!({
        "mode": *state.mode.lock().unwrap(),
        "modes": config::mode_availability(),
        "live_trading_enabled": config::LIVE_TRADING_ENABLED,
        "version": env!("CARGO_PKG_VERSION"),
        "config": {"repo_root": cfg.repo_root, "python": cfg.python, "node": cfg.node, "port": cfg.port,
                   "db_path": cfg.db_path, "cycle_interval_ms": cfg.cycle_interval_ms, "hummingbot_mode": cfg.hummingbot_mode},
    })
}

#[derive(Serialize)]
struct Component {
    name: &'static str,
    status: &'static str, // OK | WARN | DOWN | DISABLED | STARTING
    detail: String,
}

fn node_version(node: &str) -> Result<String, String> {
    let mut cmd = std::process::Command::new(node);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("'{node}' not runnable: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn probe_market_data(state: &AppState) -> Value {
    if let Some((at, v)) = state.market_probe.lock().unwrap().as_ref() {
        if at.elapsed() < Duration::from_secs(60) {
            return v.clone();
        }
    }
    let started = Instant::now();
    let result = state
        .client
        .post("https://api.hyperliquid.xyz/info")
        .json(&json!({"type": "allMids"}))
        .send()
        .await;
    let value = match result {
        Ok(r) if r.status().is_success() => {
            let mids: Value = r.json().await.unwrap_or(Value::Null);
            let n = mids.as_object().map(|m| m.len()).unwrap_or(0);
            json!({"ok": n > 0, "detail": format!("Hyperliquid allMids: {n} markets, {} ms", started.elapsed().as_millis())})
        }
        Ok(r) => json!({"ok": false, "detail": format!("Hyperliquid allMids HTTP {}", r.status().as_u16())}),
        Err(e) => json!({"ok": false, "detail": format!("Hyperliquid unreachable: {e}")}),
    };
    *state.market_probe.lock().unwrap() = Some((Instant::now(), value.clone()));
    value
}

#[tauri::command]
async fn system_health(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let exec = state.services.exec_status();
    let forward = state.services.loop_status();
    let telemetry = state.logs.loop_telemetry();
    let status = state.get("/system/status").await;
    let startup_error = state.startup_error.lock().unwrap().clone();
    let mut components = Vec::new();

    let cfg = &state.services.cfg;
    let scanner_file = cfg.repo_root.as_ref().map(|r| r.join("backend").join("scan-core.mjs"));
    let node = {
        let mut cached = state.node_version.lock().unwrap();
        cached.get_or_insert_with(|| node_version(&cfg.node)).clone()
    };
    components.push(match (&scanner_file, &node) {
        (Some(f), Ok(v)) if f.is_file() => Component {
            name: "Market Edge scanner",
            status: "OK",
            detail: format!(
                "backend/scan-core.mjs via node {v}; forward loop {:?}{}",
                forward.state,
                telemetry.last_outcome.as_ref().map(|o| format!(", last cycle {o}")).unwrap_or_default()
            ),
        },
        (_, Err(e)) => Component { name: "Market Edge scanner", status: "DOWN", detail: e.clone() },
        _ => Component { name: "Market Edge scanner", status: "DOWN", detail: "backend/scan-core.mjs not found (set MARKET_EDGE_HOME)".into() },
    });

    components.push(match (&status, exec.state) {
        (Ok(_), s) => Component { name: "execution-service", status: "OK", detail: format!("{:?} on {} (paper only)", s, cfg.base_url()) },
        (Err(_), ProcState::Starting) => Component { name: "execution-service", status: "STARTING", detail: "waiting for /health".into() },
        (Err(e), _) => Component { name: "execution-service", status: "DOWN", detail: startup_error.clone().unwrap_or_else(|| e.clone()) },
    });

    let s = status.as_ref().ok();
    let pick = |k: &str| s.and_then(|v| v.get(k)).cloned().unwrap_or(Value::Null);
    let nautilus = pick("nautilus");
    components.push(if nautilus.get("ok").and_then(Value::as_bool) == Some(true) {
        Component {
            name: "Nautilus",
            status: "OK",
            detail: format!("nautilus_trader {} -- {}", nautilus["version"].as_str().unwrap_or("?"), nautilus["role"].as_str().unwrap_or("")),
        }
    } else {
        Component { name: "Nautilus", status: "DOWN", detail: nautilus.get("error").map(|e| e.to_string()).unwrap_or_else(|| "unknown (service down)".into()) }
    });
    let hb = pick("hummingbot");
    let hb_mode = hb.get("mode").and_then(Value::as_str).unwrap_or(&cfg.hummingbot_mode).to_string();
    components.push(if hb_mode == "disabled" {
        Component { name: "Hummingbot", status: "DISABLED", detail: "not enabled (HUMMINGBOT_MODE=disabled); paper fills route to NAUTILUS_NATIVE".into() }
    } else if hb.get("ok").and_then(Value::as_bool) == Some(true) {
        Component { name: "Hummingbot", status: if hb_mode == "mock" { "WARN" } else { "OK" }, detail: format!("mode {hb_mode}") }
    } else {
        Component { name: "Hummingbot", status: "DOWN", detail: format!("mode {hb_mode}, not reachable") }
    });
    let sqlite = pick("sqlite");
    components.push(if sqlite.get("ok").and_then(Value::as_bool) == Some(true) {
        Component {
            name: "SQLite",
            status: "OK",
            detail: format!("quick_check ok, {} ({} KB)", sqlite["path"].as_str().unwrap_or("?"), sqlite["size_bytes"].as_u64().unwrap_or(0) / 1024),
        }
    } else {
        Component { name: "SQLite", status: "DOWN", detail: sqlite.to_string() }
    });
    let probe = probe_market_data(&state).await;
    let recent_md_error = telemetry.last_market_data_error_at_ms.map(|t| logs::now_ms().saturating_sub(t) < 15 * 60_000).unwrap_or(false);
    components.push(Component {
        name: "Market data",
        status: if probe["ok"].as_bool() != Some(true) { "DOWN" } else if recent_md_error { "WARN" } else { "OK" },
        detail: if recent_md_error {
            format!("{}; loop reported: {}", probe["detail"].as_str().unwrap_or(""), telemetry.last_market_data_error.clone().unwrap_or_default())
        } else {
            probe["detail"].as_str().unwrap_or("").to_string()
        },
    });
    let halted = pick("halted");
    let last_rec = pick("last_reconcile");
    components.push(if !halted.is_null() {
        Component { name: "Reconciliation", status: "DOWN", detail: format!("HALTED: {}", halted.as_str().unwrap_or("?")) }
    } else if last_rec.is_null() {
        Component { name: "Reconciliation", status: "WARN", detail: "not run yet this session".into() }
    } else if last_rec["reconciled"].as_bool() == Some(true) {
        Component { name: "Reconciliation", status: "OK", detail: "last check reconciled".into() }
    } else {
        Component { name: "Reconciliation", status: "DOWN", detail: format!("last check FAILED: {last_rec}") }
    });

    Ok(json!({
        "components": components,
        "execution_service": exec,
        "forward_loop": forward,
        "loop": telemetry,
        "status": s,
        "startup_error": startup_error,
        "mode": *state.mode.lock().unwrap(),
    }))
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("market-edge-desktop"));
            let _ = std::fs::create_dir_all(&data_dir);
            let logs = Arc::new(LogStore::new(Some(&data_dir.join("logs").join("desktop.log"))));
            let cfg = AppConfig::resolve(data_dir);
            let secrets: Arc<dyn SecretBackend> = Arc::new(secrets::OsKeyring::new(secrets::SERVICE));
            let (api_key, key_source) = secrets::service_api_key(secrets.as_ref());
            if let Some(w) = &key_source.warning {
                logs.app(Level::Warn, format!("OS credential store unavailable; service key kept in memory only: {w}"));
            }
            logs.app(Level::Info, format!("Market Edge desktop starting in PAPER mode; repo {:?}", cfg.repo_root));
            let services = Arc::new(Services::new(cfg, api_key, logs.clone()));
            let startup_error = Arc::new(Mutex::new(None));
            {
                let services = services.clone();
                let startup_error = startup_error.clone();
                let logs = logs.clone();
                std::thread::spawn(move || {
                    if let Err(e) = services.start_execution_service() {
                        logs.app(Level::Error, format!("execution-service startup failed: {e}"));
                        *startup_error.lock().unwrap() = Some(e);
                    }
                });
            }
            let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build()?;
            app.manage(AppState {
                services,
                logs,
                client,
                key_source,
                secrets,
                mode: Mutex::new(ExecutionMode::Paper),
                startup_error,
                node_version: Mutex::new(None),
                market_probe: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            system_health,
            get_account,
            get_positions,
            get_trades,
            get_signals,
            get_performance,
            get_risk_config,
            get_risk_usage,
            update_risk_config,
            get_logs,
            start_paper,
            stop_paper,
            reconcile_now,
            pause_entries,
            resume_entries,
            kill_switch,
            clear_halt,
            restart_services,
            set_mode,
            secrets_status,
            set_secret,
            delete_secret,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Market Edge desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Stop new work, let persisted state stand, stop what we started.
                if let Some(state) = app.try_state::<AppState>() {
                    let services = state.services.clone();
                    let _ = std::thread::spawn(move || services.shutdown_all()).join();
                }
            }
        });
}
