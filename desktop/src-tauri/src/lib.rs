//! Market Edge desktop controller.
//!
//! Desktop UI (React) -> Tauri IPC commands (this file) -> execution-service
//! HTTP API on 127.0.0.1 with an X-API-Key held only here -> Nautilus
//! portfolio / paper ledger / SQLite. The webview never sees the API key,
//! never opens the database, and can only call the commands registered below.
//! Canonical trading state stays in the execution-service's SQLite file (in
//! the OS app-data directory); every command reads it fresh.

pub mod backup;
pub mod config;
pub mod logs;
pub mod process;
pub mod secrets;
pub mod supervisor;

use config::{AppConfig, ExecutionMode, LayoutKind, UserConfig};
use logs::{Level, LogStore};
use process::{ProcState, Services};
use secrets::{ApiKeySource, SecretBackend};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use supervisor::Supervisor;
use tauri::Manager;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GIT_SHA: &str = env!("MARKET_EDGE_GIT_SHA");
pub const BUILD_EPOCH: &str = env!("MARKET_EDGE_BUILD_EPOCH");

pub fn build_timestamp() -> String {
    logs::iso_from_ms(BUILD_EPOCH.parse::<u64>().unwrap_or(0) * 1000)
}

#[derive(Debug, Clone, Serialize)]
pub struct Startup {
    /// INITIALIZING | STARTING_SERVICE | STARTING_LOOP | READY | ERROR
    pub phase: &'static str,
    pub message: String,
    pub first_run: Option<config::FirstRun>,
}

/// Everything the controller needs, available once setup succeeded.
pub struct Runtime {
    pub services: Arc<Services>,
    pub supervisor: Arc<Supervisor>,
    key_source: ApiKeySource,
    pending_restore: Mutex<Option<backup::Inspection>>,
}

pub struct AppState {
    pub logs: Arc<LogStore>,
    rt: Option<Runtime>,
    /// why the controller could not start (broken install); shown in the UI
    fatal: Option<String>,
    client: reqwest::Client,
    secrets: Arc<dyn SecretBackend>,
    mode: Mutex<ExecutionMode>,
    startup: Arc<Mutex<Startup>>,
    user: Arc<Mutex<UserConfig>>,
    data_dir: PathBuf,
    build_info: Value,
    node_version: Mutex<Option<String>>,
}

type CmdResult<T> = Result<T, String>;

impl AppState {
    fn rt(&self) -> CmdResult<&Runtime> {
        self.rt.as_ref().ok_or_else(|| self.fatal.clone().unwrap_or_else(|| "controller not initialised".into()))
    }
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> CmdResult<Value> {
        self.call_with_timeout(method, path, body, None).await
    }
    async fn call_with_timeout(&self, method: reqwest::Method, path: &str, body: Option<Value>, timeout: Option<Duration>) -> CmdResult<Value> {
        let rt = self.rt()?;
        let url = format!("{}{}", rt.services.cfg.base_url(), path);
        let mut req = self.client.request(method, url).header("X-API-Key", rt.services.api_key());
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
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
    fn set_auto_start(&self, on: bool) {
        let mut user = self.user.lock().unwrap();
        if user.auto_start_paper != on {
            user.auto_start_paper = on;
            if let Err(e) = config::save_user_config(&self.data_dir, &user) {
                self.logs.app(Level::Warn, format!("could not save config.json: {e}"));
            }
        }
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
/// `path?k=v&...` with each value percent-encoded (trade ids come from signal ids).
fn with_query(path: &str, params: &[(&str, &str)]) -> String {
    let url = reqwest::Url::parse_with_params(&format!("http://service{path}"), params).expect("static path");
    format!("{}?{}", url.path(), url.query().unwrap_or(""))
}
#[tauri::command]
async fn get_trade_detail(state: tauri::State<'_, AppState>, trade_id: String) -> CmdResult<Value> {
    state.get(&with_query("/paper/trade", &[("trade_id", &trade_id)])).await
}
#[tauri::command]
async fn get_trade_candles(state: tauri::State<'_, AppState>, trade_id: String, interval: String) -> CmdResult<Value> {
    state.get(&with_query("/paper/trade/candles", &[("trade_id", &trade_id), ("interval", &interval)])).await
}
#[tauri::command]
async fn get_signals(state: tauri::State<'_, AppState>, limit: Option<u32>) -> CmdResult<Value> {
    state.get(&format!("/paper/signals?limit={}", limit.unwrap_or(500).clamp(1, 5000))).await
}
// Shadow learning (research only): read-only views of the execution-service's
// separate shadow research store. Filter values come from the webview, so only
// known keys with [A-Z_] values (and a bounded limit) are forwarded.
fn shadow_token_ok(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.chars().all(|c| c.is_ascii_uppercase() || c == '_')
}
#[tauri::command]
async fn get_shadow_summary(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    state.get("/shadow/summary").await
}
#[tauri::command]
async fn get_shadow_observations(state: tauri::State<'_, AppState>, filter: Option<Value>) -> CmdResult<Value> {
    let filter = filter.unwrap_or(Value::Null);
    let limit = filter.get("limit").and_then(Value::as_u64).unwrap_or(200).clamp(1, 1000);
    let mut path = format!("/shadow/observations?limit={limit}");
    for key in ["kind", "execution_status", "classification"] {
        if let Some(v) = filter.get(key).and_then(Value::as_str) {
            if !shadow_token_ok(v) {
                return Err(format!("invalid shadow filter {key}"));
            }
            path.push_str(&format!("&{key}={v}"));
        }
    }
    state.get(&path).await
}
#[tauri::command]
async fn get_shadow_observation(state: tauri::State<'_, AppState>, id: String) -> CmdResult<Value> {
    if id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid observation id".into());
    }
    state.get(&format!("/shadow/observations/{id}")).await
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
/// Tail of one of the log files in <app data>/logs.
#[tauri::command]
fn get_logs(state: tauri::State<'_, AppState>, file: Option<String>, limit: Option<usize>) -> CmdResult<Value> {
    let file = file.unwrap_or_else(|| "desktop".into());
    if !logs::LOG_FILES.contains(&file.as_str()) {
        return Err(format!("unknown log file '{file}'"));
    }
    let path = state.data_dir.join("logs").join(format!("{file}.log"));
    let entries = logs::tail_file(&path, limit.unwrap_or(1000).min(5000));
    Ok(json!({"file": file, "path": path, "entries": entries}))
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------
#[tauri::command]
async fn start_paper(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    if *state.mode.lock().unwrap() != ExecutionMode::Paper {
        return Err("START PAPER is only available in PAPER mode".into());
    }
    let sup = state.rt()?.supervisor.clone();
    let status = tauri::async_runtime::spawn_blocking(move || sup.start_loop()).await.map_err(|e| e.to_string())??;
    state.set_auto_start(true);
    Ok(json!(status))
}
#[tauri::command]
async fn stop_paper(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let sup = state.rt()?.supervisor.clone();
    let status = tauri::async_runtime::spawn_blocking(move || sup.stop_loop(process::LOOP_STOP_GRACE)).await.map_err(|e| e.to_string())??;
    state.set_auto_start(false);
    Ok(json!(status))
}
#[tauri::command]
async fn reconcile_now(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let result = state.post("/reconcile", json!({})).await?;
    let ok = result.get("reconciled").and_then(Value::as_bool) == Some(true);
    state.logs.app_event(if ok { Level::Info } else { Level::Error }, "reconcile", format!("RECONCILE NOW: reconciled={ok} {result}"));
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
    if let Some(rt) = state.rt.as_ref() {
        let m = rt.supervisor.market();
        if m.online == Some(false) {
            return Err("MARKET DATA OFFLINE: fresh market data is required before entries can resume".into());
        }
    }
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
        Ok(v) => state.logs.app_event(Level::Risk, "reconcile", format!("halt cleared after clean reconciliation: {}", v.get("reconcile").cloned().unwrap_or(Value::Null))),
        Err(e) => state.logs.app_event(Level::Error, "reconcile", format!("halt NOT cleared: {e}")),
    }
    r
}
#[tauri::command]
async fn restart_services(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let rt = state.rt()?;
    rt.supervisor.reset();
    let services = rt.services.clone();
    let sup = rt.supervisor.clone();
    let startup = state.startup.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let r = services.start_execution_service();
        if r.is_ok() {
            let _ = sup.reconcile("manual restart reconciliation");
        }
        r
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut s = startup.lock().unwrap();
    match &result {
        Ok(_) => {
            s.phase = "READY";
            s.message = "execution-service restarted".into();
        }
        Err(e) => {
            s.phase = "ERROR";
            s.message = e.clone();
        }
    }
    Ok(json!(result?))
}

// ---------------------------------------------------------------------------
// backup / restore
// ---------------------------------------------------------------------------
fn pick_save_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_title("Export Market Edge backup")
        .set_file_name(backup::default_export_name())
        .add_filter("Market Edge backup", &[backup::EXTENSION])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
}
fn pick_open_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_title("Import Market Edge backup")
        .add_filter("Market Edge backup", &[backup::EXTENSION, "zip"])
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
}

fn pick_export_folder(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file().set_title("Choose a folder for the research export").blocking_pick_folder().and_then(|p| p.into_path().ok())
}

#[tauri::command]
async fn get_research_export_info(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    state.get("/research/export").await
}

/// Read-only research export (CSV/Parquet) into a new folder the service
/// creates under the chosen directory. Not a backup: nothing can be restored
/// from it, and the service opens both databases read-only.
#[tauri::command]
async fn export_research(app: tauri::AppHandle, state: tauri::State<'_, AppState>, format: String) -> CmdResult<Value> {
    if format != "csv" && format != "parquet" {
        return Err("invalid export format".into());
    }
    state.rt()?;
    let handle = app.clone();
    let Some(dir) = tauri::async_runtime::spawn_blocking(move || pick_export_folder(&handle)).await.map_err(|e| e.to_string())? else {
        return Ok(json!({"cancelled": true}));
    };
    // A large research database takes longer than the default 10s request timeout.
    let manifest = state.call_with_timeout(reqwest::Method::POST, "/research/export", Some(json!({"out_dir": dir, "format": format})),
        Some(Duration::from_secs(600))).await?;
    state.logs.app(Level::Info, format!("EXPORT RESEARCH: {} ({format}, read-only, local folder only)",
        manifest.get("folder").and_then(Value::as_str).unwrap_or("?")));
    Ok(manifest)
}

#[tauri::command]
async fn export_backup(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let rt = state.rt()?;
    let handle = app.clone();
    let Some(dest) = tauri::async_runtime::spawn_blocking(move || pick_save_path(&handle)).await.map_err(|e| e.to_string())? else {
        return Ok(json!({"cancelled": true}));
    };
    let cfg = rt.services.cfg.clone();
    let user = state.user.lock().unwrap().clone();
    let dest2 = dest.clone();
    let manifest = tauri::async_runtime::spawn_blocking(move || backup::export(&cfg, &user, &dest2, APP_VERSION, GIT_SHA)).await.map_err(|e| e.to_string())??;
    state.logs.app(Level::Info, format!("EXPORT BACKUP: {} (schema v{}, {} trades, shadow {}, no secrets, local file only)", dest.display(), manifest.schema_version, manifest.counts["paper_trades"],
        if manifest.shadow_included { format!("{} observations", manifest.shadow_counts["shadow_observations"]) } else { "not present".into() }));
    Ok(json!({"path": dest, "manifest": manifest}))
}

#[tauri::command]
async fn inspect_backup(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let rt = state.rt()?;
    let handle = app.clone();
    let Some(path) = tauri::async_runtime::spawn_blocking(move || pick_open_path(&handle)).await.map_err(|e| e.to_string())? else {
        return Ok(json!({"cancelled": true}));
    };
    let cfg = rt.services.cfg.clone();
    let p2 = path.clone();
    let inspection = tauri::async_runtime::spawn_blocking(move || backup::inspect(&cfg, &p2)).await.map_err(|e| e.to_string())?;
    match inspection {
        Ok(i) => {
            let out = json!({"path": i.path, "manifest": i.manifest, "validation": i.validation, "shadow_validation": i.shadow_validation});
            if let Some(old) = rt.pending_restore.lock().unwrap().replace(i) {
                backup::discard(&old);
            }
            state.logs.app(Level::Info, format!("IMPORT BACKUP: {} validated", path.display()));
            Ok(out)
        }
        Err(e) => {
            state.logs.app(Level::Warn, format!("IMPORT BACKUP: {} rejected: {e}", path.display()));
            Err(e)
        }
    }
}

#[tauri::command]
async fn restore_backup(state: tauri::State<'_, AppState>, confirm: String) -> CmdResult<Value> {
    if confirm != "RESTORE" {
        return Err("restore requires confirmation".into());
    }
    let rt = state.rt()?;
    let inspection = rt.pending_restore.lock().unwrap().take().ok_or("validate a backup first (IMPORT BACKUP)")?;
    let services = rt.services.clone();
    let sup = rt.supervisor.clone();
    let logs = state.logs.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        *sup.wants_loop.lock().unwrap() = false;
        let _ = services.stop_loop(process::EXIT_LOOP_GRACE);
        services.wait_loop_stopped(process::EXIT_LOOP_GRACE + Duration::from_secs(2));
        services.stop_execution_service();
        let outcome = backup::restore(&services.cfg, &inspection)?;
        let kept = outcome.previous_db.clone();
        logs.app(Level::Info, format!("IMPORT BACKUP: restored {}; previous database kept at {:?}; shadow research database {}", inspection.path.display(), kept,
            if outcome.shadow_restored { format!("restored (previous kept at {:?})", outcome.previous_shadow_db) } else { "not in backup, current one kept".into() }));
        services.start_execution_service()?;
        // restored state is reviewed before any new trade: paused + reconciled
        let _ = services.call(reqwest::Method::POST, "/control/pause", Some(json!({"reason": "RESTORED_FROM_BACKUP"})));
        let reconciled = sup.reconcile("post-restore reconciliation").unwrap_or(false);
        Ok(json!({"restored": inspection.path, "previous_database_kept_at": kept, "shadow_restored": outcome.shadow_restored,
                  "previous_shadow_database_kept_at": outcome.previous_shadow_db, "reconciled": reconciled, "entries_paused": true}))
    })
    .await
    .map_err(|e| e.to_string())?;
    if result.is_ok() {
        state.set_auto_start(false);
    }
    result
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
           "service_api_key": state.rt.as_ref().map(|rt| json!(rt.key_source))})
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

fn node_version(node: &Path) -> String {
    let mut cmd = std::process::Command::new(node);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    match cmd.output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Err(e) => format!("not runnable: {e}"),
    }
}

#[tauri::command]
async fn app_info(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let backend = match state.rt.as_ref() {
        Some(rt) => state.client.get(format!("{}/health", rt.services.cfg.base_url())).send().await.ok(),
        None => None,
    };
    let backend: Value = match backend {
        Some(r) => r.json().await.unwrap_or(Value::Null),
        None => Value::Null,
    };
    let cfg = state.rt.as_ref().map(|rt| rt.services.cfg.clone());
    let node = match &cfg {
        Some(c) => {
            let cached = state.node_version.lock().unwrap().clone();
            match cached {
                Some(v) => Some(v),
                None => {
                    let n = c.layout.node.clone();
                    let v = tauri::async_runtime::spawn_blocking(move || node_version(&n)).await.unwrap_or_default();
                    *state.node_version.lock().unwrap() = Some(v.clone());
                    Some(v)
                }
            }
        }
        None => None,
    };
    Ok(json!({
        "mode": *state.mode.lock().unwrap(),
        "modes": config::mode_availability(),
        "live_trading_enabled": config::LIVE_TRADING_ENABLED,
        "version": APP_VERSION,
        "git_sha": GIT_SHA,
        "build_timestamp": build_timestamp(),
        "build_info": state.build_info,
        "backend": {
            "version": backend.get("version"),
            "schema_version": backend.get("schema_version"),
            "build": backend.get("build"),
            "research": backend.get("research"),
        },
        "node_version": node,
        "data_dir": state.data_dir,
        "fatal": state.fatal,
        "user_config": *state.user.lock().unwrap(),
        "config": cfg.map(|c| json!({
            "layout": c.layout.kind, "resource_dir": c.layout.resource_dir, "repo_root": c.layout.repo_root,
            "execution_service": c.layout.exec_program, "node": c.layout.node, "forward_loop": c.layout.loop_script,
            "port": c.port, "db_path": c.db_path, "logs_dir": c.logs_dir, "backups_dir": c.backups_dir,
            "cycle_interval_ms": c.cycle_interval_ms, "hummingbot_mode": c.hummingbot_mode,
        })),
    }))
}

#[derive(Serialize)]
struct Component {
    name: &'static str,
    status: &'static str, // OK | WARN | DOWN | DISABLED | STARTING
    detail: String,
}

#[tauri::command]
async fn system_health(state: tauri::State<'_, AppState>) -> CmdResult<Value> {
    let startup = state.startup.lock().unwrap().clone();
    let Some(rt) = state.rt.as_ref() else {
        return Ok(json!({"components": [], "startup": startup, "fatal": state.fatal, "mode": *state.mode.lock().unwrap(),
                         "execution_service": null, "forward_loop": null, "loop": null, "status": null, "market": null, "supervisor": null}));
    };
    let exec = rt.services.exec_status();
    let forward = rt.services.loop_status();
    let telemetry = state.logs.loop_telemetry();
    let sup = rt.supervisor.view();
    let market = sup.market.clone();
    let status = state.get("/system/status").await;
    let cfg = &rt.services.cfg;
    let mut components = Vec::new();

    components.push(if cfg.layout.scanner_file.is_file() {
        Component {
            name: "Market Edge scanner",
            status: if forward.state == ProcState::Failed { "DOWN" } else { "OK" },
            detail: format!(
                "scan-core.mjs on {} Node runtime; forward loop {:?}{}{}",
                if cfg.layout.kind == LayoutKind::Bundled { "bundled" } else { "developer" },
                forward.state,
                telemetry.last_outcome.as_ref().map(|o| format!(", last cycle {o}")).unwrap_or_default(),
                sup.loop_gave_up.as_ref().map(|m| format!(" -- {m}")).unwrap_or_default()
            ),
        }
    } else {
        Component { name: "Market Edge scanner", status: "DOWN", detail: format!("{} missing", cfg.layout.scanner_file.display()) }
    });

    components.push(match (&status, exec.state) {
        (Ok(_), s) => Component { name: "execution-service", status: "OK", detail: format!("{:?} on {} (paper only)", s, cfg.base_url()) },
        (Err(_), ProcState::Starting) => Component { name: "execution-service", status: "STARTING", detail: "starting bundled service, waiting for /health".into() },
        (Err(e), _) => Component {
            name: "execution-service",
            status: "DOWN",
            detail: sup.exec_gave_up.clone().or_else(|| if sup.recovering { Some("crashed; supervisor is restarting it".into()) } else { None })
                .or_else(|| (startup.phase == "ERROR").then(|| startup.message.clone())).unwrap_or_else(|| e.clone()),
        },
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
    components.push(Component { name: "Hummingbot", status: "DISABLED", detail: "not enabled in the desktop app; paper fills route to NAUTILUS_NATIVE".into() });
    let sqlite = pick("sqlite");
    components.push(if sqlite.get("ok").and_then(Value::as_bool) == Some(true) {
        let migration = pick("migration");
        Component {
            name: "SQLite",
            status: "OK",
            detail: format!(
                "quick_check ok, schema v{}, {} ({} KB)",
                migration.get("to_version").and_then(Value::as_u64).unwrap_or(0),
                sqlite["path"].as_str().unwrap_or("?"),
                sqlite["size_bytes"].as_u64().unwrap_or(0) / 1024
            ),
        }
    } else {
        Component { name: "SQLite", status: "DOWN", detail: sqlite.to_string() }
    });
    let recent_md_error = telemetry.last_market_data_error_at_ms.map(|t| logs::now_ms().saturating_sub(t) < 15 * 60_000).unwrap_or(false);
    components.push(Component {
        name: "Market data",
        status: match market.online {
            None => "STARTING",
            Some(false) => "DOWN",
            Some(true) if recent_md_error => "WARN",
            Some(true) => "OK",
        },
        detail: match market.online {
            None => "checking live prices…".into(),
            Some(false) => format!("MARKET DATA OFFLINE: {}", market.detail),
            Some(true) if recent_md_error => format!("{}; loop reported: {}", market.detail, telemetry.last_market_data_error.clone().unwrap_or_default()),
            Some(true) => market.detail.clone(),
        },
    });
    let halted = pick("halted");
    let last_rec = pick("last_reconcile");
    components.push(if !halted.is_null() {
        Component { name: "Reconciliation", status: "DOWN", detail: format!("HALTED: {}", halted.as_str().unwrap_or("?")) }
    } else if last_rec.is_null() {
        Component { name: "Reconciliation", status: "WARN", detail: "not run yet".into() }
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
        "market": market,
        "supervisor": sup,
        "startup": startup,
        "startup_error": (startup.phase == "ERROR").then(|| startup.message.clone()),
        "fatal": state.fatal,
        "mode": *state.mode.lock().unwrap(),
    }))
}

// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------
fn read_build_info(layout: Option<&config::Layout>) -> Value {
    layout
        .and_then(|l| l.build_info_file.as_ref())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({"app_version": APP_VERSION, "git_sha": GIT_SHA, "build_timestamp": build_timestamp(), "note": "developer build (no bundle)"}))
}

fn legacy_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(config::LEGACY_IDENTIFIER_DIR))
}

/// Resource directory of an installed app, computed from the executable
/// (headless mode has no Tauri runtime): macOS Contents/MacOS/../Resources,
/// Windows the install directory, Linux packages /usr/lib/<product>.
pub fn resource_dir_from_exe() -> Option<PathBuf> {
    let exe = config::de_verbatim(std::env::current_exe().ok()?);
    let dir = exe.parent()?.to_path_buf();
    if cfg!(target_os = "macos") {
        return Some(dir.parent()?.join("Resources"));
    }
    if cfg!(target_os = "linux") {
        let usr = dir.parent()?.join("lib").join("Market Edge");
        if usr.is_dir() {
            return Some(usr);
        }
    }
    Some(dir)
}

fn startup_sequence(services: Arc<Services>, sup: Arc<Supervisor>, startup: Arc<Mutex<Startup>>, logs: Arc<LogStore>, auto_start: bool) {
    let set = |phase: &'static str, message: String| {
        let mut s = startup.lock().unwrap();
        s.phase = phase;
        s.message = message;
    };
    set("STARTING_SERVICE", "starting execution-service (Nautilus, SQLite)…".into());
    if let Err(e) = services.start_execution_service() {
        logs.app(Level::Error, format!("execution-service startup failed: {e}"));
        set("ERROR", e);
        return;
    }
    let _ = sup.reconcile("startup reconciliation");
    sup.probe_market();
    if auto_start {
        set("STARTING_LOOP", "starting forward paper loop…".into());
        match sup.start_loop() {
            Ok(_) => logs.app(Level::Info, "forward paper loop auto-started (PAPER mode)"),
            Err(e) => logs.app(Level::Error, format!("forward loop auto-start failed: {e}")),
        }
    }
    set("READY", if auto_start { "services running".into() } else { "services running; paper loop stopped (START PAPER to begin)".into() });
    sup.spawn();
}

// ---------------------------------------------------------------------------
// headless maintenance (used by installed-app tests and support):
//   market-edge-desktop --self-check
//   market-edge-desktop --export-backup <file>
//   market-edge-desktop --verify-backup <file>
//   market-edge-desktop --restore-backup <file> --confirm RESTORE
// optional: --result <file> (JSON result also written there; Windows GUI
// builds have no console). Refuses to restore while the app is running.
// ---------------------------------------------------------------------------
fn headless(args: &[String]) -> Option<i32> {
    let cmd = args.get(1)?.clone();
    if !matches!(cmd.as_str(), "--self-check" | "--export-backup" | "--verify-backup" | "--restore-backup") {
        return None;
    }
    let result_file = args.iter().position(|a| a == "--result").and_then(|i| args.get(i + 1)).cloned();
    let emit = |v: Value, ok: bool| -> i32 {
        let s = serde_json::to_string_pretty(&v).unwrap_or_default();
        println!("{s}");
        if let Some(f) = &result_file {
            let _ = std::fs::write(f, &s);
        }
        if ok {
            0
        } else {
            1
        }
    };
    let data_dir = config::data_dir();
    let layout = match config::resolve_layout(resource_dir_from_exe().as_deref(), config::dev_allowed()) {
        Ok(l) => l,
        Err(e) => return Some(emit(json!({"ok": false, "error": e}), false)),
    };
    let cfg = AppConfig::new(layout, data_dir.clone());
    let arg = args.get(2).map(PathBuf::from);
    Some(match cmd.as_str() {
        "--self-check" => {
            let version = backup::maintenance(&cfg, &["version"]);
            let nv = node_version(&cfg.layout.node);
            let ok = version.is_ok() && nv.starts_with('v');
            emit(json!({"ok": ok, "app_version": APP_VERSION, "git_sha": GIT_SHA, "build_timestamp": build_timestamp(),
                        "layout": cfg.layout, "data_dir": data_dir, "db_path": cfg.db_path,
                        "execution_service": version.unwrap_or_else(|e| json!({"error": e})), "node_version": nv,
                        "build_info": read_build_info(Some(&cfg.layout))}), ok)
        }
        "--export-backup" => {
            let Some(dest) = arg else { return Some(emit(json!({"ok": false, "error": "usage: --export-backup <file>"}), false)) };
            let user = config::load_user_config(&data_dir).unwrap_or_default();
            match backup::export(&cfg, &user, &dest, APP_VERSION, GIT_SHA) {
                Ok(m) => emit(json!({"ok": true, "path": dest, "manifest": m, "entries": backup::entries(&dest).unwrap_or_default()}), true),
                Err(e) => emit(json!({"ok": false, "error": e}), false),
            }
        }
        "--verify-backup" => {
            let Some(src) = arg else { return Some(emit(json!({"ok": false, "error": "usage: --verify-backup <file>"}), false)) };
            match backup::inspect(&cfg, &src) {
                Ok(i) => {
                    backup::discard(&i);
                    emit(json!({"ok": true, "manifest": i.manifest, "validation": i.validation, "shadow_validation": i.shadow_validation}), true)
                }
                Err(e) => emit(json!({"ok": false, "error": e}), false),
            }
        }
        _ => {
            let Some(src) = arg else { return Some(emit(json!({"ok": false, "error": "usage: --restore-backup <file> --confirm RESTORE"}), false)) };
            if !args.windows(2).any(|w| w[0] == "--confirm" && w[1] == "RESTORE") {
                return Some(emit(json!({"ok": false, "error": "restore requires --confirm RESTORE"}), false));
            }
            if process::http().get(format!("{}/health", cfg.base_url())).send().is_ok() {
                return Some(emit(json!({"ok": false, "error": "Market Edge is running; use IMPORT BACKUP in the app or quit it first"}), false));
            }
            match backup::inspect(&cfg, &src).and_then(|i| backup::restore(&cfg, &i).map(|outcome| (i, outcome))) {
                Ok((i, outcome)) => emit(json!({"ok": true, "restored": src, "manifest": i.manifest, "previous_database_kept_at": outcome.previous_db,
                                                "shadow_restored": outcome.shadow_restored, "previous_shadow_database_kept_at": outcome.previous_shadow_db}), true),
                Err(e) => emit(json!({"ok": false, "error": e}), false),
            }
        }
    })
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = headless(&args) {
        std::process::exit(code);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = config::data_dir();
            let resource_dir = app.path().resource_dir().ok().map(config::de_verbatim);
            let layout = config::resolve_layout(resource_dir.as_deref(), config::dev_allowed());
            let _ = std::fs::create_dir_all(data_dir.join("logs"));
            let logs = Arc::new(LogStore::new(Some(&data_dir.join("logs"))));
            logs.app(Level::Info, format!(
                "Market Edge {APP_VERSION} (git {GIT_SHA}, built {}) starting in PAPER mode; os {}-{}; data dir {}",
                build_timestamp(), std::env::consts::OS, std::env::consts::ARCH, data_dir.display()
            ));
            let init = config::init_data_dir(&data_dir, layout.as_ref().ok().and_then(|l| l.defaults_file.as_deref()), APP_VERSION, legacy_data_dir().as_deref());
            let (user, first_run) = match init {
                Ok((u, f)) => {
                    if f.first_run {
                        logs.app(Level::Info, format!("first run: created {}", f.created.join(", ")));
                    }
                    if let Some(from) = &f.upgraded_from {
                        logs.app(Level::Info, format!("updated from {from} to {APP_VERSION}; existing data kept"));
                    }
                    if let Some(p) = &f.imported_legacy_db {
                        logs.app(Level::Info, format!("copied desktop-MVP database from {}", p.display()));
                    }
                    (u, Some(f))
                }
                Err(e) => {
                    logs.app(Level::Error, format!("could not initialise {}: {e}", data_dir.display()));
                    (UserConfig::default(), None)
                }
            };
            let secrets: Arc<dyn SecretBackend> = Arc::new(secrets::OsKeyring::new(secrets::SERVICE));
            let startup = Arc::new(Mutex::new(Startup { phase: "INITIALIZING", message: "initialising".into(), first_run }));
            let user = Arc::new(Mutex::new(user));
            let (rt, fatal) = match layout {
                Ok(layout) => {
                    logs.app(Level::Info, format!(
                        "layout {:?}: execution-service {} | node {} | loop {}",
                        layout.kind, layout.exec_program.display(), layout.node.display(), layout.loop_script.display()
                    ));
                    let (api_key, key_source) = secrets::service_api_key(secrets.as_ref());
                    match &key_source.warning {
                        Some(w) => logs.app(Level::Warn, format!("OS credential store unavailable; service key kept in memory only: {w}")),
                        None => logs.app(Level::Info, format!("service API key {} in {}", if key_source.created { "created" } else { "loaded" }, key_source.store)),
                    }
                    let cfg = AppConfig::new(layout, data_dir.clone());
                    let services = Arc::new(Services::new(cfg, api_key, logs.clone()));
                    let sup = Supervisor::new(services.clone(), logs.clone());
                    let auto_start = user.lock().unwrap().auto_start_paper;
                    {
                        let (services, sup, startup, logs) = (services.clone(), sup.clone(), startup.clone(), logs.clone());
                        std::thread::spawn(move || startup_sequence(services, sup, startup, logs, auto_start));
                    }
                    (Some(Runtime { services, supervisor: sup, key_source, pending_restore: Mutex::new(None) }), None)
                }
                Err(e) => {
                    logs.app(Level::Error, format!("cannot start: {e}"));
                    let mut s = startup.lock().unwrap();
                    s.phase = "ERROR";
                    s.message = e.clone();
                    drop(s);
                    (None, Some(e))
                }
            };
            // SIGTERM/SIGINT/SIGHUP (logout, `kill`, installer upgrades) quit
            // through the same graceful path as closing the window.
            #[cfg(unix)]
            {
                use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
                if let Ok(mut signals) = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP]) {
                    let handle = app.handle().clone();
                    let logs = logs.clone();
                    std::thread::spawn(move || {
                        if let Some(sig) = signals.forever().next() {
                            logs.app(Level::Info, format!("signal {sig} received; shutting down gracefully"));
                            handle.exit(0);
                        }
                    });
                }
            }
            let build_info = read_build_info(rt.as_ref().map(|r| &r.services.cfg.layout));
            let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).no_proxy().build()?;
            app.manage(AppState {
                logs,
                rt,
                fatal,
                client,
                secrets,
                mode: Mutex::new(ExecutionMode::Paper),
                startup,
                user,
                data_dir,
                build_info,
                node_version: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            system_health,
            get_account,
            get_positions,
            get_trades,
            get_trade_detail,
            get_trade_candles,
            get_signals,
            get_performance,
            get_shadow_summary,
            get_shadow_observations,
            get_research_export_info,
            export_research,
            get_shadow_observation,
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
            export_backup,
            inspect_backup,
            restore_backup,
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
                    if let Some(rt) = state.rt.as_ref() {
                        let services = rt.services.clone();
                        let _ = std::thread::spawn(move || services.shutdown_all()).join();
                    }
                    state.logs.app(Level::Info, "Market Edge exited");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::with_query;

    #[test]
    fn trade_detail_query_is_percent_encoded() {
        assert_eq!(with_query("/paper/trade", &[("trade_id", "scan-abc-ETH")]), "/paper/trade?trade_id=scan-abc-ETH");
        assert_eq!(
            with_query("/paper/trade/candles", &[("trade_id", "a&b=c #1"), ("interval", "5m")]),
            "/paper/trade/candles?trade_id=a%26b%3Dc+%231&interval=5m"
        );
    }
}
