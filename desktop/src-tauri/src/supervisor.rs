//! Supervision of the local services, and the market-data gate.
//!
//! Rules (all bounded, all logged to desktop.log / reconciliation.log):
//! - execution-service crash: shown DOWN at once; the forward loop is told to
//!   stop (it cannot trade without the service anyway); the service is
//!   restarted at most MAX_EXEC_RESTARTS times per EXEC_WINDOW with backoff.
//!   After a restart new entries are paused (SUPERVISOR_RECOVERY) BEFORE the
//!   loop comes back, a reconciliation runs, and only a clean reconciliation
//!   lifts that pause and restarts the loop. A database the service refuses
//!   (exit 3: newer schema / failed migration) is never restarted.
//! - forward-loop crash: new entries paused (FORWARD_LOOP_CRASHED); restarted
//!   only if the service is healthy, trading is not halted, market data is
//!   online and a reconciliation is clean -- at most MAX_LOOP_RESTARTS per
//!   LOOP_WINDOW.
//! - market data: probed every PROBE_INTERVAL. Unreachable => MARKET DATA
//!   OFFLINE and new entries paused (MARKET_DATA_OFFLINE). Only a later
//!   successful fetch of fresh prices lifts that pause.
//! The supervisor only ever lifts a pause carrying its own reason (the
//! service checks this atomically), so an operator's PAUSE is never undone,
//! and it never clears a kill switch/halt.

use crate::logs::{self, Level, LogStore};
use crate::process::{Crash, ProcState, Services, EXIT_STARTUP_REFUSED};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const MAX_EXEC_RESTARTS: usize = 3;
pub const EXEC_WINDOW: Duration = Duration::from_secs(10 * 60);
pub const MAX_LOOP_RESTARTS: usize = 3;
pub const LOOP_WINDOW: Duration = Duration::from_secs(30 * 60);
pub const PROBE_INTERVAL: Duration = Duration::from_secs(30);
pub const DEFAULT_PROBE_URL: &str = "https://api.hyperliquid.xyz/info";

pub const REASON_RECOVERY: &str = "SUPERVISOR_RECOVERY";
pub const REASON_LOOP_CRASH: &str = "FORWARD_LOOP_CRASHED";
pub const REASON_OFFLINE: &str = "MARKET_DATA_OFFLINE";

#[derive(Debug, Clone, Default, Serialize)]
pub struct MarketState {
    pub online: Option<bool>,
    pub detail: String,
    pub checked_at_ms: Option<u64>,
    pub offline_since_ms: Option<u64>,
    pub last_fresh_at_ms: Option<u64>,
    pub markets: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SupervisorView {
    pub exec_restarts_in_window: usize,
    pub loop_restarts_in_window: usize,
    pub exec_gave_up: Option<String>,
    pub loop_gave_up: Option<String>,
    pub last_exec_crash: Option<Crash>,
    pub last_loop_crash: Option<Crash>,
    pub last_action: Option<String>,
    pub recovering: bool,
    pub market: MarketState,
}

struct Inner {
    exec_restarts: VecDeque<Instant>,
    loop_restarts: VecDeque<Instant>,
    view: SupervisorView,
    last_probe: Option<Instant>,
}

pub struct Supervisor {
    services: Arc<Services>,
    logs: Arc<LogStore>,
    probe_url: Mutex<String>,
    probe_client: reqwest::blocking::Client,
    /// backoff unit; tests shorten it
    backoff: Duration,
    inner: Mutex<Inner>,
    /// user asked the loop to run (START PAPER / auto start); restart it after a recovery
    pub wants_loop: Mutex<bool>,
}

fn prune(q: &mut VecDeque<Instant>, window: Duration) -> usize {
    while q.front().map(|t| t.elapsed() > window).unwrap_or(false) {
        q.pop_front();
    }
    q.len()
}

impl Supervisor {
    pub fn new(services: Arc<Services>, logs: Arc<LogStore>) -> Arc<Self> {
        let probe_url = std::env::var("MARKET_EDGE_MARKET_PROBE_URL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_PROBE_URL.into());
        Self::with_options(services, logs, probe_url, Duration::from_secs(2))
    }

    pub fn with_options(services: Arc<Services>, logs: Arc<LogStore>, probe_url: String, backoff: Duration) -> Arc<Self> {
        Arc::new(Supervisor {
            services,
            logs,
            probe_url: Mutex::new(probe_url),
            probe_client: reqwest::blocking::Client::builder().timeout(Duration::from_secs(8)).build().expect("probe client"),
            backoff,
            inner: Mutex::new(Inner { exec_restarts: VecDeque::new(), loop_restarts: VecDeque::new(), view: SupervisorView::default(), last_probe: None }),
            wants_loop: Mutex::new(false),
        })
    }

    pub fn set_probe_url(&self, url: &str) {
        *self.probe_url.lock().unwrap() = url.to_string();
        self.inner.lock().unwrap().last_probe = None;
    }

    pub fn view(&self) -> SupervisorView {
        let mut inner = self.inner.lock().unwrap();
        inner.view.exec_restarts_in_window = prune(&mut inner.exec_restarts, EXEC_WINDOW);
        inner.view.loop_restarts_in_window = prune(&mut inner.loop_restarts, LOOP_WINDOW);
        inner.view.clone()
    }

    pub fn market(&self) -> MarketState {
        self.inner.lock().unwrap().view.market.clone()
    }

    fn action(&self, level: Level, msg: String) {
        self.logs.app_event(level, "supervisor", msg.clone());
        self.inner.lock().unwrap().view.last_action = Some(format!("{} {msg}", logs::iso_now()));
    }

    /// The operator pressed RESTART SERVICES: reset the give-up state.
    pub fn reset(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.exec_restarts.clear();
        inner.loop_restarts.clear();
        inner.view.exec_gave_up = None;
        inner.view.loop_gave_up = None;
    }

    fn pause(&self, reason: &str) -> bool {
        match self.services.call(reqwest::Method::POST, "/control/pause", Some(json!({"reason": reason, "only_if_unpaused": true}))) {
            Ok(v) => v.get("paused").and_then(Value::as_bool) == Some(true),
            Err(e) => {
                self.logs.app(Level::Warn, format!("could not pause entries ({reason}): {e}"));
                false
            }
        }
    }

    fn resume_own(&self, reason: &str) -> bool {
        self.services
            .call(reqwest::Method::POST, "/control/resume", Some(json!({"only_if_reason": reason})))
            .map(|v| v.get("resumed").and_then(Value::as_bool) == Some(true))
            .unwrap_or(false)
    }

    /// Reconcile through the service (records it; a failure halts trading there).
    pub fn reconcile(&self, why: &str) -> Result<bool, String> {
        let r = self.services.call(reqwest::Method::POST, "/reconcile", Some(json!({})));
        match &r {
            Ok(v) => {
                let ok = v.get("reconciled").and_then(Value::as_bool) == Some(true);
                self.logs.app_event(if ok { Level::Info } else { Level::Error }, "reconcile", format!("{why}: reconciled={ok} {v}"));
                Ok(ok)
            }
            Err(e) => {
                self.logs.app_event(Level::Error, "reconcile", format!("{why}: reconciliation could not run: {e}"));
                Err(e.clone())
            }
        }
    }

    fn halted(&self) -> Option<String> {
        self.services
            .call(reqwest::Method::GET, "/system/status", None)
            .ok()
            .and_then(|s| s.get("halted").and_then(Value::as_str).map(str::to_string))
    }

    fn service_up(&self) -> bool {
        matches!(self.services.exec_status().state, ProcState::Running | ProcState::Adopted) && self.services.health_ok()
    }

    /// Start the loop because the operator wants it running (START PAPER / auto start).
    pub fn start_loop(&self) -> Result<crate::process::ProcStatus, String> {
        let status = self.services.start_loop()?;
        *self.wants_loop.lock().unwrap() = true;
        self.inner.lock().unwrap().view.loop_gave_up = None;
        Ok(status)
    }

    pub fn stop_loop(&self, grace: Duration) -> Result<crate::process::ProcStatus, String> {
        *self.wants_loop.lock().unwrap() = false;
        self.services.stop_loop(grace)
    }

    // ------------------------------------------------------------------
    pub fn tick(&self) {
        if let Some(crash) = self.services.take_exec_crash() {
            self.on_exec_crash(crash);
        }
        if let Some(crash) = self.services.take_loop_crash() {
            self.on_loop_crash(crash);
        }
        let due = self.inner.lock().unwrap().last_probe.map(|t| t.elapsed() >= PROBE_INTERVAL).unwrap_or(true);
        if due {
            self.probe_market();
        }
    }

    fn on_exec_crash(&self, crash: Crash) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.view.last_exec_crash = Some(crash.clone());
            inner.view.recovering = true;
        }
        self.action(Level::Error, format!("execution-service CRASHED ({}); new entries cannot be placed until it is back and reconciled", crash.exit));
        let loop_was_running = self.services.loop_status().pid.is_some();
        if loop_was_running {
            let _ = self.services.stop_loop(crate::process::LOOP_STOP_GRACE);
        }
        if crash.code == Some(EXIT_STARTUP_REFUSED) {
            self.give_up_exec("the service refused its database (newer schema or failed migration); the database was not modified".into());
            return;
        }
        let attempts = {
            let mut inner = self.inner.lock().unwrap();
            prune(&mut inner.exec_restarts, EXEC_WINDOW)
        };
        if attempts >= MAX_EXEC_RESTARTS {
            self.give_up_exec(format!("crashed {} times within {} minutes; automatic restarts stopped. Use RESTART SERVICES after checking execution-service.log", attempts + 1, EXEC_WINDOW.as_secs() / 60));
            return;
        }
        let delay = self.backoff * 3u32.pow(attempts as u32);
        self.action(Level::Warn, format!("restarting execution-service in {}s (attempt {}/{})", delay.as_secs_f32(), attempts + 1, MAX_EXEC_RESTARTS));
        thread::sleep(delay);
        self.inner.lock().unwrap().exec_restarts.push_back(Instant::now());
        if !loop_was_running || !self.services.wait_loop_stopped(Duration::from_secs(10)) {
            // a loop that won't stop can't reach the service anyway; the pause below gates it
        }
        match self.services.start_execution_service() {
            Ok(_) => self.recover_after_restart(),
            Err(e) => {
                self.action(Level::Error, format!("execution-service restart failed: {e}"));
                // a failed start is another crash for the bound
                if let Some(c) = self.services.take_exec_crash() {
                    self.on_exec_crash(c);
                } else {
                    self.inner.lock().unwrap().view.recovering = false;
                }
            }
        }
    }

    fn give_up_exec(&self, why: String) {
        self.action(Level::Error, format!("execution-service NOT restarted: {why}"));
        let mut inner = self.inner.lock().unwrap();
        inner.view.exec_gave_up = Some(why);
        inner.view.recovering = false;
    }

    /// After a service restart: pause first, reconcile, then (only if clean)
    /// lift our pause and bring the loop back.
    fn recover_after_restart(&self) {
        let paused = self.pause(REASON_RECOVERY);
        match self.reconcile("post-restart reconciliation") {
            Ok(true) => {
                if paused {
                    self.resume_own(REASON_RECOVERY);
                }
                self.action(Level::Info, "execution-service recovered: state reloaded from SQLite and reconciled clean".into());
                if *self.wants_loop.lock().unwrap() && self.services.loop_status().pid.is_none() {
                    match self.services.start_loop() {
                        Ok(_) => self.action(Level::Info, "forward loop restarted after recovery".into()),
                        Err(e) => self.action(Level::Error, format!("forward loop not restarted: {e}")),
                    }
                }
            }
            Ok(false) => self.action(Level::Error, "post-restart reconciliation FAILED: trading halted, entries stay paused; review before RESUME".into()),
            Err(e) => self.action(Level::Error, format!("post-restart reconciliation did not run ({e}); entries stay paused")),
        }
        self.inner.lock().unwrap().view.recovering = false;
    }

    fn on_loop_crash(&self, crash: Crash) {
        self.inner.lock().unwrap().view.last_loop_crash = Some(crash.clone());
        self.action(Level::Error, format!("forward loop CRASHED ({}); new entries paused", crash.exit));
        let paused = self.service_up() && self.pause(REASON_LOOP_CRASH);
        if !*self.wants_loop.lock().unwrap() {
            return;
        }
        let attempts = {
            let mut inner = self.inner.lock().unwrap();
            prune(&mut inner.loop_restarts, LOOP_WINDOW)
        };
        let unsafe_reason = if attempts >= MAX_LOOP_RESTARTS {
            Some(format!("crashed {} times within {} minutes", attempts + 1, LOOP_WINDOW.as_secs() / 60))
        } else if !self.service_up() {
            Some("execution-service is not healthy".into())
        } else if let Some(h) = self.halted() {
            Some(format!("trading is halted ({h})"))
        } else if self.market().online == Some(false) {
            Some("market data is offline".into())
        } else {
            None
        };
        if let Some(why) = unsafe_reason {
            let msg = format!("forward loop NOT restarted: {why}. Entries stay paused; START PAPER when resolved");
            self.action(Level::Error, msg.clone());
            let mut inner = self.inner.lock().unwrap();
            inner.view.loop_gave_up = Some(msg);
            return;
        }
        thread::sleep(self.backoff * 2 * 3u32.pow(attempts as u32));
        match self.reconcile("pre-restart reconciliation (forward loop crash)") {
            Ok(true) => {
                self.inner.lock().unwrap().loop_restarts.push_back(Instant::now());
                match self.services.start_loop() {
                    Ok(_) => {
                        if paused {
                            self.resume_own(REASON_LOOP_CRASH);
                        }
                        self.action(Level::Info, format!("forward loop restarted (attempt {}/{}) after a clean reconciliation", attempts + 1, MAX_LOOP_RESTARTS));
                    }
                    Err(e) => self.action(Level::Error, format!("forward loop restart failed: {e}")),
                }
            }
            _ => {
                let msg = "forward loop NOT restarted: reconciliation was not clean".to_string();
                self.action(Level::Error, msg.clone());
                self.inner.lock().unwrap().view.loop_gave_up = Some(msg);
            }
        }
    }

    /// Fetch live mids (fresh data, never cached prices). Blocking.
    pub fn probe_market(&self) {
        let url = self.probe_url.lock().unwrap().clone();
        let started = Instant::now();
        let result = self.probe_client.post(&url).json(&json!({"type": "allMids"})).send();
        let (ok, markets, detail) = match result {
            Ok(r) if r.status().is_success() => {
                let mids: Value = r.json().unwrap_or(Value::Null);
                let n = mids.as_object().map(|m| m.values().filter(|v| v.as_str().and_then(|s| s.parse::<f64>().ok()).map(|p| p > 0.0).unwrap_or(false)).count()).unwrap_or(0);
                (n > 0, n, format!("Hyperliquid allMids: {n} markets, {} ms", started.elapsed().as_millis()))
            }
            Ok(r) => (false, 0, format!("market data HTTP {}", r.status().as_u16())),
            Err(e) => (false, 0, format!("market data unreachable: {e}")),
        };
        let now = logs::now_ms();
        let was = {
            let mut inner = self.inner.lock().unwrap();
            inner.last_probe = Some(Instant::now());
            let m = &mut inner.view.market;
            let was = m.online;
            m.online = Some(ok);
            m.detail = detail.clone();
            m.checked_at_ms = Some(now);
            m.markets = markets;
            if ok {
                m.last_fresh_at_ms = Some(now);
                m.offline_since_ms = None;
            } else if m.offline_since_ms.is_none() {
                m.offline_since_ms = Some(now);
            }
            was
        };
        if !ok {
            if was != Some(false) {
                self.action(Level::Warn, format!("MARKET DATA OFFLINE ({detail}); new entries paused, no prices are invented"));
            }
            if self.service_up() {
                self.pause(REASON_OFFLINE);
            }
        } else if self.service_up() && self.resume_own(REASON_OFFLINE) {
            self.action(Level::Info, format!("market data back online with fresh prices ({detail}); new entries resumed"));
        }
    }

    /// Run until the app exits.
    pub fn spawn(self: &Arc<Self>) {
        let me = self.clone();
        thread::spawn(move || loop {
            me.tick();
            if let Ok(path) = std::env::var("MARKET_EDGE_STATUS_FILE") {
                me.write_status_file(&path);
            }
            thread::sleep(Duration::from_secs(2));
        });
    }

    /// Diagnostics for automated installed-app tests (only when
    /// MARKET_EDGE_STATUS_FILE is set). Contains no secrets.
    pub fn write_status_file(&self, path: &str) {
        let s = &self.services;
        let get = |p: &str| s.call(reqwest::Method::GET, p, None).ok();
        let health = crate::process::http().get(format!("{}/health", s.cfg.base_url())).send().ok().and_then(|r| r.json::<Value>().ok());
        let status = get("/system/status");
        let account = get("/paper/account");
        let positions = get("/paper/positions");
        let trades = get("/paper/trades");
        let signals = get("/paper/signals?limit=50");
        let count = |v: &Option<Value>, k: &str| v.as_ref().and_then(|x| x.get(k)).and_then(Value::as_array).map(|a| a.len());
        let snapshot = json!({
            "at": logs::iso_now(),
            "layout": s.cfg.layout.kind,
            "resource_dir": s.cfg.layout.resource_dir,
            "repo_root": s.cfg.layout.repo_root,
            "data_dir": s.cfg.data_dir,
            "db_path": s.cfg.db_path,
            "execution_service": s.exec_status(),
            "forward_loop": s.loop_status(),
            "loop": self.logs.loop_telemetry(),
            "supervisor": self.view(),
            "health": health,
            "status": status.as_ref().map(|v| json!({
                "halted": v.get("halted"), "entries_paused": v.get("entries_paused"), "entries_paused_reason": v.get("entries_paused_reason"),
                "nautilus": v.get("nautilus"), "sqlite": v.get("sqlite"), "last_reconcile": v.get("last_reconcile"),
                "migration": v.get("migration"), "open_positions": v.get("open_positions"), "latest_signal": v.get("latest_signal"),
            })),
            "account": account,
            "positions": positions.as_ref().and_then(|v| v.get("positions")).cloned(),
            "positions_count": count(&positions, "positions"),
            "trades_count": count(&trades, "trades"),
            "trade_ids": trades.as_ref().and_then(|v| v.get("trades")).and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|t| t.get("trade_id").cloned()).collect::<Vec<_>>()),
            "signals_count": count(&signals, "signals"),
        });
        let tmp = format!("{path}.tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(&snapshot).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(tmp, path);
        }
    }
}
