//! Local process management: the execution-service and the forward paper
//! loop are Market Edge's own programs, started as child processes. In the
//! installed app they are the bundled frozen service
//! (Resources/execution-service/market-edge-exec) and the bundled Node
//! runtime running the unmodified forward loop; in a developer build, the
//! repo's run_server.py and forward_loop.mjs (see config.rs). The app never
//! reimplements them.
//!
//! Stop semantics:
//! - forward loop: "STOP" on stdin; the loop finishes its current cycle
//!   (each backend call is one committed SQLite transaction), closes its
//!   runtime segment and exits. Open trades stay OPEN and resume from their
//!   last checked candle next time. Only if it has not exited after a grace
//!   period is it killed -- still safe, because no call leaves partial state.
//! - execution-service: POST /system/shutdown (graceful uvicorn exit, works
//!   the same on Windows), then kill only after a grace period.
//! Services the app did not start (adopted) are never stopped by it.
//!
//! An exit nobody asked for is recorded as a crash for the supervisor
//! (supervisor.rs), which decides whether a bounded restart is safe.

use crate::config::AppConfig;
use crate::logs::{Level, LogStore};
use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const LOOP_STOP_GRACE: Duration = Duration::from_secs(240);
pub const EXIT_LOOP_GRACE: Duration = Duration::from_secs(45);
pub const SERVICE_STOP_GRACE: Duration = Duration::from_secs(15);
pub const SERVICE_START_TIMEOUT: Duration = Duration::from_secs(180); // first launch of the frozen bundle can be slow (AV scans on Windows)
/// run_server.py exits with this code when it refuses a database (newer
/// schema / failed migration). Restarting would not help.
pub const EXIT_STARTUP_REFUSED: i32 = 3;

struct Managed {
    child: Child,
    stdin: Option<ChildStdin>,
    started_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProcState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Adopted,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcStatus {
    pub state: ProcState,
    pub pid: Option<u32>,
    pub started_at_ms: Option<u64>,
    pub last_exit: Option<String>,
    pub exit_code: Option<i32>,
    /// the program actually started (proves which binary runs)
    pub program: Option<String>,
    pub crashes: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Crash {
    pub at_ms: u64,
    pub exit: String,
    pub code: Option<i32>,
}

struct Slot {
    managed: Option<Managed>,
    state: ProcState,
    last_exit: Option<String>,
    exit_code: Option<i32>,
    stop_requested: bool,
    program: Option<String>,
    crashes: u32,
    unhandled_crash: Option<Crash>,
}

impl Slot {
    fn new() -> Self {
        Slot { managed: None, state: ProcState::Stopped, last_exit: None, exit_code: None, stop_requested: false, program: None, crashes: 0, unhandled_crash: None }
    }
    /// Reap a child that exited; anything not requested is a crash.
    fn refresh(&mut self) {
        if let Some(m) = self.managed.as_mut() {
            if let Ok(Some(status)) = m.child.try_wait() {
                self.last_exit = Some(format!("exited: {status}"));
                self.exit_code = status.code();
                self.managed = None;
                let requested = std::mem::take(&mut self.stop_requested);
                if requested || status.success() {
                    self.state = ProcState::Stopped;
                } else {
                    self.state = ProcState::Failed;
                    self.crashes += 1;
                    self.unhandled_crash = Some(Crash { at_ms: crate::logs::now_ms(), exit: format!("{status}"), code: status.code() });
                }
            }
        }
    }
    fn status(&mut self) -> ProcStatus {
        self.refresh();
        ProcStatus {
            state: self.state,
            pid: self.managed.as_ref().map(|m| m.child.id()),
            started_at_ms: self.managed.as_ref().map(|m| m.started_at_ms),
            last_exit: self.last_exit.clone(),
            exit_code: self.exit_code,
            program: self.program.clone(),
            crashes: self.crashes,
        }
    }
}

pub struct Services {
    pub cfg: AppConfig,
    api_key: String,
    logs: Arc<LogStore>,
    exec: Mutex<Slot>,
    forward: Arc<Mutex<Slot>>,
}

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

/// Children must not pick up a developer's interpreter settings: the frozen
/// service and the bundled Node runtime use only what ships in the app.
fn isolate_env(cmd: &mut Command) {
    for k in ["PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE", "VIRTUAL_ENV", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS_OVERRIDE"] {
        cmd.env_remove(k);
    }
}

fn pipe_output(child: &mut Child, source: &'static str, logs: &Arc<LogStore>) {
    if let Some(out) = child.stdout.take() {
        let logs = logs.clone();
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                logs.push_line(source, &line, false);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let logs = logs.clone();
        thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                logs.push_line(source, &line, true);
            }
        });
    }
}

pub fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder().timeout(Duration::from_secs(5)).no_proxy().build().expect("http client")
}

impl Services {
    pub fn new(cfg: AppConfig, api_key: String, logs: Arc<LogStore>) -> Self {
        Services { cfg, api_key, logs, exec: Mutex::new(Slot::new()), forward: Arc::new(Mutex::new(Slot::new())) }
    }

    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    pub fn health_ok(&self) -> bool {
        http().get(format!("{}/health", self.cfg.base_url())).send().map(|r| r.status().is_success()).unwrap_or(false)
    }

    fn key_accepted(&self) -> Option<bool> {
        let resp = http().get(format!("{}/system/status", self.cfg.base_url())).header("X-API-Key", &self.api_key).send().ok()?;
        Some(resp.status().is_success())
    }

    /// Authenticated JSON call to the local service (blocking; supervisor thread).
    pub fn call(&self, method: reqwest::Method, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        let mut req = http().request(method, format!("{}{}", self.cfg.base_url(), path)).header("X-API-Key", &self.api_key);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().map_err(|e| format!("execution-service unreachable: {e}"))?;
        let status = resp.status();
        let value: serde_json::Value = resp.json().unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status.as_u16(), value.get("detail").cloned().unwrap_or(value)));
        }
        Ok(value)
    }

    pub fn exec_status(&self) -> ProcStatus {
        self.exec.lock().unwrap().status()
    }

    pub fn loop_status(&self) -> ProcStatus {
        self.forward.lock().unwrap().status()
    }

    pub fn take_exec_crash(&self) -> Option<Crash> {
        let mut slot = self.exec.lock().unwrap();
        slot.refresh();
        slot.unhandled_crash.take()
    }

    pub fn take_loop_crash(&self) -> Option<Crash> {
        let mut slot = self.forward.lock().unwrap();
        slot.refresh();
        slot.unhandled_crash.take()
    }

    pub fn exec_pid(&self) -> Option<u32> {
        self.exec.lock().unwrap().status().pid
    }

    /// Start (or adopt) the execution-service and wait until /health answers.
    /// Blocking: call from a worker thread.
    pub fn start_execution_service(&self) -> Result<ProcStatus, String> {
        {
            let mut slot = self.exec.lock().unwrap();
            slot.refresh();
            if slot.managed.is_some() || slot.state == ProcState::Adopted {
                return Ok(slot.status());
            }
        }
        if self.health_ok() {
            // Something already listens on our port. Adopt it only if it
            // accepts this app's key (e.g. one left running by a previous
            // app session); never talk to a service we can't authenticate to.
            return match self.key_accepted() {
                Some(true) => {
                    let mut slot = self.exec.lock().unwrap();
                    slot.state = ProcState::Adopted;
                    self.logs.app(Level::Info, format!("adopted execution-service already running on port {}", self.cfg.port));
                    Ok(slot.status())
                }
                _ => Err(format!(
                    "port {} is already used by a service that rejects this app's API key; stop it or set MARKET_EDGE_EXEC_PORT",
                    self.cfg.port
                )),
            };
        }
        let layout = &self.cfg.layout;
        let _ = std::fs::create_dir_all(&self.cfg.data_dir);
        let mut cmd = Command::new(&layout.exec_program);
        cmd.args(&layout.exec_args)
            .current_dir(layout.exec_cwd.as_ref().unwrap_or(&self.cfg.data_dir))
            .env("MARKET_EDGE_EXEC_API_KEY", &self.api_key)
            .env("EXECUTION_SERVICE_DB_PATH", &self.cfg.db_path)
            .env("MARKET_EDGE_SHADOW_DB", &self.cfg.shadow_db_path)
            .env("EXECUTION_SERVICE_PORT", self.cfg.port.to_string())
            .env("EXECUTION_SERVICE_BACKUP_DIR", &self.cfg.backups_dir)
            .env("HUMMINGBOT_MODE", &self.cfg.hummingbot_mode)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("EXECUTION_SERVICE_ACCESS_LOG", "0")
            // we hold its stdin: if this app dies uncleanly the pipe closes
            // and the service shuts itself down (no orphan on the port)
            .env("EXECUTION_SERVICE_EXIT_ON_STDIN_EOF", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        isolate_env(&mut cmd);
        if let Some(m) = &layout.migrations_dir {
            cmd.env("EXECUTION_SERVICE_MIGRATIONS_DIR", m);
        }
        if let Some(b) = &layout.build_info_file {
            cmd.env("MARKET_EDGE_BUILD_INFO", b);
        }
        hide_console(&mut cmd);
        let program = format!("{} {}", layout.exec_program.display(), layout.exec_args.join(" ")).trim().to_string();
        {
            let mut slot = self.exec.lock().unwrap();
            let mut child = cmd.spawn().map_err(|e| format!("could not start execution-service '{}': {e}", layout.exec_program.display()))?;
            pipe_output(&mut child, "execution-service", &self.logs);
            let stdin = child.stdin.take();
            self.logs.app(Level::Info, format!("started execution-service pid {} ({program}) on port {} db {}", child.id(), self.cfg.port, self.cfg.db_path.display()));
            slot.managed = Some(Managed { child, stdin, started_at_ms: crate::logs::now_ms() });
            slot.state = ProcState::Starting;
            slot.stop_requested = false;
            slot.program = Some(program);
        }
        let deadline = Instant::now() + SERVICE_START_TIMEOUT;
        while Instant::now() < deadline {
            {
                let mut slot = self.exec.lock().unwrap();
                slot.refresh();
                if slot.managed.is_none() {
                    slot.state = ProcState::Failed;
                    let refused = slot.exit_code == Some(EXIT_STARTUP_REFUSED);
                    // startup failures are reported to the caller, not handled as crashes
                    slot.unhandled_crash = None;
                    return Err(if refused {
                        "execution-service refused the database (newer schema or failed migration); it was NOT modified -- see execution-service.log".into()
                    } else {
                        format!("execution-service exited during startup ({}) -- see execution-service.log", slot.last_exit.clone().unwrap_or_default())
                    });
                }
            }
            if self.health_ok() {
                let mut slot = self.exec.lock().unwrap();
                slot.state = ProcState::Running;
                self.logs.app(Level::Info, "execution-service healthy");
                return Ok(slot.status());
            }
            thread::sleep(Duration::from_millis(500));
        }
        // don't leave a half-started process behind
        let mut slot = self.exec.lock().unwrap();
        if let Some(mut m) = slot.managed.take() {
            let _ = m.child.kill();
            let _ = m.child.wait();
        }
        slot.state = ProcState::Failed;
        Err(format!("execution-service did not become healthy within {}s", SERVICE_START_TIMEOUT.as_secs()))
    }

    pub fn start_loop(&self) -> Result<ProcStatus, String> {
        let mut slot = self.forward.lock().unwrap();
        slot.refresh();
        if slot.managed.is_some() {
            return Err(format!("forward loop is already {:?}", slot.state).to_uppercase());
        }
        {
            let exec = self.exec.lock().unwrap().status();
            if !matches!(exec.state, ProcState::Running | ProcState::Adopted) {
                return Err("execution-service is not running".into());
            }
        }
        let layout = &self.cfg.layout;
        let mut cmd = Command::new(&layout.node);
        cmd.arg(&layout.loop_script)
            .current_dir(layout.loop_cwd.as_ref().unwrap_or(&self.cfg.data_dir))
            .env("MARKET_EDGE_EXEC_API_KEY", &self.api_key)
            .env("EXECUTION_SERVICE_URL", self.cfg.base_url())
            .env("CYCLE_INTERVAL_MS", self.cfg.cycle_interval_ms.to_string())
            .env("FORWARD_LOOP_STDIN_CONTROL", "1")
            .env("FORWARD_LOOP_MAIN", "1")
            .env("SEGMENT_NAME", format!("desktop-{}", crate::logs::now_ms()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        isolate_env(&mut cmd);
        hide_console(&mut cmd);
        let program = format!("{} {}", layout.node.display(), layout.loop_script.display());
        let mut child = cmd.spawn().map_err(|e| format!("could not start forward loop with '{}': {e}", layout.node.display()))?;
        pipe_output(&mut child, "forward-loop", &self.logs);
        let stdin = child.stdin.take();
        self.logs.app(Level::Info, format!("START PAPER: forward loop pid {} ({program}) every {}s", child.id(), self.cfg.cycle_interval_ms / 1000));
        slot.managed = Some(Managed { child, stdin, started_at_ms: crate::logs::now_ms() });
        slot.state = ProcState::Running;
        slot.last_exit = None;
        slot.exit_code = None;
        slot.stop_requested = false;
        slot.program = Some(program);
        Ok(slot.status())
    }

    /// Ask the loop to stop after its current cycle; returns immediately.
    /// A watcher thread enforces the grace period.
    pub fn stop_loop(&self, grace: Duration) -> Result<ProcStatus, String> {
        let mut slot = self.forward.lock().unwrap();
        slot.refresh();
        if slot.managed.is_none() {
            return Ok(slot.status());
        }
        if slot.state != ProcState::Stopping {
            if let Some(stdin) = slot.managed.as_mut().and_then(|m| m.stdin.as_mut()) {
                let _ = stdin.write_all(b"STOP\n");
                let _ = stdin.flush();
            }
            slot.state = ProcState::Stopping;
            slot.stop_requested = true;
            self.logs.app(Level::Info, "STOP PAPER: forward loop will stop after its current cycle");
            self.logs.reset_loop_schedule();
            let forward = self.forward.clone();
            let logs = self.logs.clone();
            thread::spawn(move || {
                let deadline = Instant::now() + grace;
                loop {
                    thread::sleep(Duration::from_millis(250));
                    let mut slot = forward.lock().unwrap();
                    slot.refresh();
                    if slot.managed.is_none() {
                        logs.app(Level::Info, "forward loop stopped cleanly");
                        return;
                    }
                    if Instant::now() >= deadline {
                        if let Some(mut m) = slot.managed.take() {
                            let _ = m.child.kill();
                            let _ = m.child.wait();
                        }
                        slot.state = ProcState::Stopped;
                        slot.stop_requested = false;
                        slot.last_exit = Some("killed after stop grace period".into());
                        logs.app(Level::Warn, "forward loop did not stop within the grace period and was terminated (backend state is transactional; open trades stay open)");
                        return;
                    }
                }
            });
        }
        Ok(slot.status())
    }

    pub fn wait_loop_stopped(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.forward.lock().unwrap().status().pid.is_none() {
                return true;
            }
            thread::sleep(Duration::from_millis(250));
        }
        false
    }

    /// Graceful stop of a service this app started (restore, exit).
    pub fn stop_execution_service(&self) {
        let mut slot = self.exec.lock().unwrap();
        slot.refresh();
        if slot.state == ProcState::Adopted {
            slot.state = ProcState::Stopped;
            return;
        }
        if let Some(mut m) = slot.managed.take() {
            slot.stop_requested = false;
            let _ = http().post(format!("{}/system/shutdown", self.cfg.base_url())).header("X-API-Key", &self.api_key).send();
            // close its stdin too: ends the service's parent-watch read, which on
            // Windows otherwise blocks interpreter teardown (synchronous pipe I/O)
            drop(m.stdin.take());
            let deadline = Instant::now() + SERVICE_STOP_GRACE;
            loop {
                if let Ok(Some(status)) = m.child.try_wait() {
                    slot.last_exit = Some(format!("stopped: {status}"));
                    self.logs.app(Level::Info, "execution-service stopped");
                    break;
                }
                if Instant::now() >= deadline {
                    let _ = m.child.kill();
                    let _ = m.child.wait();
                    self.logs.app(Level::Warn, "execution-service terminated after shutdown grace period");
                    break;
                }
                thread::sleep(Duration::from_millis(200));
            }
            slot.state = ProcState::Stopped;
        }
    }

    /// Test/diagnostic hook: kill the service abruptly, as a crash would.
    pub fn kill_execution_service_for_test(&self) -> bool {
        let mut slot = self.exec.lock().unwrap();
        match slot.managed.as_mut() {
            Some(m) => m.child.kill().is_ok(),
            None => false,
        }
    }

    /// App exit: stop new work, let persisted state stand, stop what we started.
    pub fn shutdown_all(&self) {
        let running = self.loop_status().pid.is_some();
        if running {
            let _ = self.stop_loop(EXIT_LOOP_GRACE);
            if !self.wait_loop_stopped(EXIT_LOOP_GRACE + Duration::from_secs(2)) {
                self.logs.app(Level::Warn, "forward loop still running at exit; terminated");
            }
        }
        self.stop_execution_service();
    }
}
