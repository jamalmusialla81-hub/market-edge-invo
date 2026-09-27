//! Local process management: the execution-service (Python/FastAPI) and the
//! forward paper loop (Node) are the repo's own programs, started as child
//! processes. The app never reimplements them.
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
}

struct Slot {
    managed: Option<Managed>,
    state: ProcState,
    last_exit: Option<String>,
}

impl Slot {
    fn new() -> Self {
        Slot { managed: None, state: ProcState::Stopped, last_exit: None }
    }
    /// Reap a child that exited on its own.
    fn refresh(&mut self) {
        if let Some(m) = self.managed.as_mut() {
            if let Ok(Some(status)) = m.child.try_wait() {
                self.last_exit = Some(format!("exited: {status}"));
                self.managed = None;
                self.state = if status.success() { ProcState::Stopped } else { ProcState::Failed };
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

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder().timeout(Duration::from_secs(5)).build().expect("http client")
}

impl Services {
    pub fn new(cfg: AppConfig, api_key: String, logs: Arc<LogStore>) -> Self {
        Services { cfg, api_key, logs, exec: Mutex::new(Slot::new()), forward: Arc::new(Mutex::new(Slot::new())) }
    }

    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    fn health_ok(&self) -> bool {
        http().get(format!("{}/health", self.cfg.base_url())).send().map(|r| r.status().is_success()).unwrap_or(false)
    }

    fn key_accepted(&self) -> Option<bool> {
        let resp = http().get(format!("{}/system/status", self.cfg.base_url())).header("X-API-Key", &self.api_key).send().ok()?;
        Some(resp.status().is_success())
    }

    pub fn exec_status(&self) -> ProcStatus {
        self.exec.lock().unwrap().status()
    }

    pub fn loop_status(&self) -> ProcStatus {
        self.forward.lock().unwrap().status()
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
        let repo = self.cfg.repo_root.clone().ok_or("Market Edge repository not found (set MARKET_EDGE_HOME)")?;
        let _ = std::fs::create_dir_all(&self.cfg.data_dir);
        let mut cmd = Command::new(&self.cfg.python);
        cmd.arg("run_server.py")
            .current_dir(repo.join("execution-service"))
            .env("MARKET_EDGE_EXEC_API_KEY", &self.api_key)
            .env("EXECUTION_SERVICE_DB_PATH", &self.cfg.db_path)
            .env("EXECUTION_SERVICE_PORT", self.cfg.port.to_string())
            .env("HUMMINGBOT_MODE", &self.cfg.hummingbot_mode)
            .env("PYTHONUNBUFFERED", "1")
            .env("EXECUTION_SERVICE_ACCESS_LOG", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut cmd);
        {
            let mut slot = self.exec.lock().unwrap();
            let mut child = cmd.spawn().map_err(|e| format!("could not start execution-service with '{}': {e}", self.cfg.python))?;
            pipe_output(&mut child, "execution-service", &self.logs);
            self.logs.app(Level::Info, format!("started execution-service pid {} on port {} db {}", child.id(), self.cfg.port, self.cfg.db_path.display()));
            slot.managed = Some(Managed { child, stdin: None, started_at_ms: crate::logs::now_ms() });
            slot.state = ProcState::Starting;
        }
        let deadline = Instant::now() + Duration::from_secs(120); // first nautilus_trader import can be slow
        while Instant::now() < deadline {
            {
                let mut slot = self.exec.lock().unwrap();
                slot.refresh();
                if slot.managed.is_none() {
                    slot.state = ProcState::Failed;
                    return Err(format!("execution-service exited during startup ({}) -- see System logs", slot.last_exit.clone().unwrap_or_default()));
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
        self.exec.lock().unwrap().state = ProcState::Failed;
        Err("execution-service did not become healthy within 120s".into())
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
        let repo = self.cfg.repo_root.clone().ok_or("Market Edge repository not found (set MARKET_EDGE_HOME)")?;
        let mut cmd = Command::new(&self.cfg.node);
        cmd.arg(repo.join("signal-bridge").join("forward_loop.mjs"))
            .current_dir(&repo)
            .env("MARKET_EDGE_EXEC_API_KEY", &self.api_key)
            .env("EXECUTION_SERVICE_URL", self.cfg.base_url())
            .env("CYCLE_INTERVAL_MS", self.cfg.cycle_interval_ms.to_string())
            .env("FORWARD_LOOP_STDIN_CONTROL", "1")
            .env("FORWARD_LOOP_MAIN", "1")
            .env("SEGMENT_NAME", format!("desktop-{}", crate::logs::now_ms()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("could not start forward loop with '{}': {e}", self.cfg.node))?;
        pipe_output(&mut child, "forward-loop", &self.logs);
        let stdin = child.stdin.take();
        self.logs.app(Level::Info, format!("START PAPER: forward loop pid {} every {}s", child.id(), self.cfg.cycle_interval_ms / 1000));
        slot.managed = Some(Managed { child, stdin, started_at_ms: crate::logs::now_ms() });
        slot.state = ProcState::Running;
        slot.last_exit = None;
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
                        slot.last_exit = Some("killed after stop grace period".into());
                        logs.app(Level::Warn, "forward loop did not stop within the grace period and was terminated (backend state is transactional; open trades stay open)");
                        return;
                    }
                }
            });
        }
        Ok(slot.status())
    }

    fn wait_loop_stopped(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.forward.lock().unwrap().status().pid.is_none() {
                return true;
            }
            thread::sleep(Duration::from_millis(250));
        }
        false
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
        let mut slot = self.exec.lock().unwrap();
        slot.refresh();
        if let Some(mut m) = slot.managed.take() {
            let _ = http().post(format!("{}/system/shutdown", self.cfg.base_url())).header("X-API-Key", &self.api_key).send();
            let deadline = Instant::now() + SERVICE_STOP_GRACE;
            loop {
                if let Ok(Some(_)) = m.child.try_wait() {
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
}
