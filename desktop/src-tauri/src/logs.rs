//! Log capture for the child processes the app manages (execution-service,
//! forward paper loop) plus the controller's own events.
//!
//! Every line is classified into one of the five levels the System screen
//! filters on (INFO, WARN, ERROR, RISK, EXECUTION) from the structured JSON
//! events the services already emit (telemetry/logging.py, forward_loop.mjs).
//! Lines are kept in a bounded in-memory ring (loop telemetry) and written to
//! rotating files in <app data>/logs/, which the System screen reads:
//!   desktop.log            the controller's own events (startup, supervision, controls)
//!   execution-service.log  the frozen Python service's stdout/stderr
//!   forward-loop.log       the Node forward loop's stdout/stderr
//!   reconciliation.log     every reconciliation result, whichever process reported it
//! Each file rotates at 5 MB, keeping 5 old files. None of this is trading state.

use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const CAPACITY: usize = 5000;
pub const ROTATE_BYTES: u64 = 5 * 1024 * 1024;
pub const ROTATE_KEEP: usize = 5;
pub const LOG_FILES: &[&str] = &["desktop", "execution-service", "forward-loop", "reconciliation"];

/// Append-only file that rotates to name.1 .. name.KEEP when it grows past
/// `max_bytes`.
pub struct RotatingFile {
    path: PathBuf,
    file: Option<File>,
    size: u64,
    max_bytes: u64,
    keep: usize,
}

impl RotatingFile {
    pub fn open(path: PathBuf, max_bytes: u64, keep: usize) -> Self {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let file = OpenOptions::new().create(true).append(true).open(&path).ok();
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        RotatingFile { path, file, size, max_bytes, keep }
    }

    fn rotated(&self, n: usize) -> PathBuf {
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push(format!(".{n}"));
        self.path.with_file_name(name)
    }

    fn rotate(&mut self) {
        self.file = None;
        let _ = std::fs::remove_file(self.rotated(self.keep));
        for n in (1..self.keep).rev() {
            let _ = std::fs::rename(self.rotated(n), self.rotated(n + 1));
        }
        let _ = std::fs::rename(&self.path, self.rotated(1));
        self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        self.size = 0;
    }

    pub fn write_line(&mut self, line: &str) {
        if self.size + line.len() as u64 + 1 > self.max_bytes && self.size > 0 {
            self.rotate();
        }
        if let Some(f) = self.file.as_mut() {
            if writeln!(f, "{line}").is_ok() {
                self.size += line.len() as u64 + 1;
            }
        }
    }
}

/// Last `max_lines` entries of one log file (reads at most the last 1 MB).
pub fn tail_file(path: &Path, max_lines: usize) -> Vec<LogEntry> {
    let Ok(mut f) = File::open(path) else { return vec![] };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(1024 * 1024);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return vec![];
    }
    let mut buf = String::new();
    let _ = f.read_to_string(&mut buf);
    let mut lines: Vec<&str> = buf.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // probably a partial line
    }
    let from = lines.len().saturating_sub(max_lines);
    lines[from..].iter().filter_map(|l| serde_json::from_str::<LogEntry>(l).ok()).collect()
}

/// Is this line about reconciliation? (Copied to reconciliation.log.)
pub fn is_reconciliation(event: Option<&str>, message: &str) -> bool {
    if matches!(event, Some("reconcile")) {
        return true;
    }
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(message.trim()) {
        if map.contains_key("reconciled") || map.get("event").and_then(|v| v.as_str()).map(|e| e.contains("reconcil")).unwrap_or(false) {
            return true;
        }
    }
    message.to_ascii_lowercase().contains("reconcil")
}

/// UTC timestamp in RFC 3339 form, without a date/time crate.
pub fn iso_now() -> String {
    iso_from_ms(now_ms())
}

pub fn iso_from_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // civil_from_days (H. Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms % 1000)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Level {
    Info,
    Warn,
    Error,
    Risk,
    Execution,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct LogEntry {
    pub seq: u64,
    pub at_ms: u64,
    pub source: String,
    pub level: Level,
    pub event: Option<String>,
    pub message: String,
}

/// What the loop's own log lines say about its schedule; surfaced on the
/// Dashboard as last/next scan time.
#[derive(Debug, Clone, Default, Serialize)]
pub struct LoopTelemetry {
    pub last_cycle_started_at: Option<String>,
    pub last_cycle_finished_at: Option<String>,
    pub last_outcome: Option<String>,
    pub last_reconciled: Option<bool>,
    pub next_cycle_at: Option<String>,
    pub cycles_seen: u64,
    pub last_market_data_error: Option<String>,
    pub last_market_data_error_at_ms: Option<u64>,
}

pub struct LogStore {
    inner: Mutex<Inner>,
}

struct Inner {
    entries: VecDeque<LogEntry>,
    next_seq: u64,
    files: Vec<(&'static str, RotatingFile)>,
    loop_telemetry: LoopTelemetry,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

const RISK_EVENTS: &[&str] = &[
    "risk_rejected",
    "risk_accepted",
    "signal_rejected",
    "duplicate_blocked",
    "kill_switch_engaged",
    "no_trade",
    "LOOP_STOP_REQUESTED",
];
const EXECUTION_EVENTS: &[&str] = &[
    "signal_received",
    "route_selected",
    "order_submitted",
    "fill",
    "partially_filled",
    "cancel",
    "paper_trade_opened",
    "paper_exit",
];
const ERROR_EVENTS: &[&str] = &["backend_disconnect", "paper_exit_failed"];
const WARN_EVENTS: &[&str] = &["STALE_MARKET_DATA", "NO_LIVE_MID"];

/// Classify one raw line from a child process. `stderr` is only a hint:
/// the services log structured events to stderr as a matter of course.
pub fn classify(line: &str, stderr: bool) -> (Level, Option<String>) {
    let trimmed = line.trim();
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let event = map.get("event").and_then(|v| v.as_str()).map(str::to_string);
        if let Some(ev) = event.as_deref() {
            if ERROR_EVENTS.contains(&ev) {
                return (Level::Error, event);
            }
            if WARN_EVENTS.contains(&ev) {
                return (Level::Warn, event);
            }
            if RISK_EVENTS.contains(&ev) {
                return (Level::Risk, event);
            }
            if EXECUTION_EVENTS.contains(&ev) {
                return (Level::Execution, event);
            }
        }
        // forward_loop.mjs cycle summaries: {"cycle":..,"outcome":..}
        if let Some(outcome) = map.get("outcome").and_then(|v| v.as_str()) {
            let level = if outcome == "ERROR" {
                Level::Error
            } else if outcome == "EXECUTED" {
                Level::Execution
            } else if outcome.starts_with("REJECTED") || outcome == "DUPLICATE" || outcome == "STALE" {
                Level::Risk
            } else {
                Level::Info
            };
            if map.get("reconciled").and_then(|v| v.as_bool()) == Some(false) {
                return (Level::Error, Some("cycle".into()));
            }
            return (level, Some("cycle".into()));
        }
        return (Level::Info, event);
    }
    let upper = trimmed.to_ascii_uppercase();
    if upper.contains("TRACEBACK") || upper.contains("ERROR") || upper.contains("FAILED") || upper.contains("EXCEPTION") {
        return (Level::Error, None);
    }
    if upper.contains("WARN") || upper.contains("STALE") {
        return (Level::Warn, None);
    }
    let _ = stderr;
    (Level::Info, None)
}

impl LogStore {
    /// `logs_dir`: where the four rotating files go (None: memory only, tests).
    pub fn new(logs_dir: Option<&Path>) -> Self {
        Self::with_rotation(logs_dir, ROTATE_BYTES, ROTATE_KEEP)
    }

    pub fn with_rotation(logs_dir: Option<&Path>, max_bytes: u64, keep: usize) -> Self {
        let files = logs_dir
            .map(|d| LOG_FILES.iter().map(|name| (*name, RotatingFile::open(d.join(format!("{name}.log")), max_bytes, keep))).collect())
            .unwrap_or_default();
        LogStore {
            inner: Mutex::new(Inner { entries: VecDeque::with_capacity(CAPACITY), next_seq: 1, files, loop_telemetry: LoopTelemetry::default() }),
        }
    }

    pub fn file_for_source(source: &str) -> &'static str {
        match source {
            "execution-service" => "execution-service",
            "forward-loop" => "forward-loop",
            _ => "desktop",
        }
    }

    pub fn push_line(&self, source: &str, line: &str, stderr: bool) {
        let (level, event) = classify(line, stderr);
        self.push(source, level, event, line.trim_end().to_string());
        if source == "forward-loop" {
            self.observe_loop_line(line);
        }
    }

    pub fn app(&self, level: Level, message: impl Into<String>) {
        self.push("app", level, None, message.into());
    }

    /// A controller event with a name (e.g. "reconcile", "supervisor").
    pub fn app_event(&self, level: Level, event: &str, message: impl Into<String>) {
        self.push("app", level, Some(event.to_string()), message.into());
    }

    fn push(&self, source: &str, level: Level, event: Option<String>, message: String) {
        let mut inner = self.inner.lock().unwrap();
        let entry = LogEntry { seq: inner.next_seq, at_ms: now_ms(), source: source.to_string(), level, event, message };
        inner.next_seq += 1;
        let line = serde_json::to_string(&entry).unwrap_or_default();
        let main = Self::file_for_source(source);
        let reconciliation = is_reconciliation(entry.event.as_deref(), &entry.message);
        for (name, file) in inner.files.iter_mut() {
            if *name == main || (reconciliation && *name == "reconciliation") {
                file.write_line(&line);
            }
        }
        if inner.entries.len() == CAPACITY {
            inner.entries.pop_front();
        }
        inner.entries.push_back(entry);
    }

    fn observe_loop_line(&self, line: &str) {
        let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(line.trim()) else { return };
        let mut inner = self.inner.lock().unwrap();
        let t = &mut inner.loop_telemetry;
        let at = map.get("at").and_then(|v| v.as_str()).map(str::to_string);
        match map.get("event").and_then(|v| v.as_str()) {
            Some("CYCLE_START") => {
                t.last_cycle_started_at = at;
                t.next_cycle_at = None;
            }
            Some("NEXT_CYCLE_AT") => t.next_cycle_at = at,
            Some("STALE_MARKET_DATA") | Some("NO_LIVE_MID") => {
                t.last_market_data_error = map.get("error").and_then(|v| v.as_str()).map(str::to_string);
                t.last_market_data_error_at_ms = Some(now_ms());
            }
            _ => {
                if let Some(outcome) = map.get("outcome").and_then(|v| v.as_str()) {
                    t.last_outcome = Some(outcome.to_string());
                    t.last_cycle_finished_at = at;
                    t.last_reconciled = map.get("reconciled").and_then(|v| v.as_bool());
                    t.cycles_seen += 1;
                }
            }
        }
    }

    pub fn since(&self, after_seq: u64, limit: usize) -> Vec<LogEntry> {
        let inner = self.inner.lock().unwrap();
        let mut out: Vec<LogEntry> = inner.entries.iter().filter(|e| e.seq > after_seq).cloned().collect();
        if out.len() > limit {
            out.drain(0..out.len() - limit);
        }
        out
    }

    pub fn loop_telemetry(&self) -> LoopTelemetry {
        self.inner.lock().unwrap().loop_telemetry.clone()
    }

    pub fn reset_loop_schedule(&self) {
        self.inner.lock().unwrap().loop_telemetry.next_cycle_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_structured_service_events() {
        assert_eq!(classify(r#"{"event":"risk_rejected","reason":"DRAWDOWN_LIMIT_HIT"}"#, true).0, Level::Risk);
        assert_eq!(classify(r#"{"event":"kill_switch_engaged"}"#, true).0, Level::Risk);
        assert_eq!(classify(r#"{"event":"paper_trade_opened","signal_id":"s"}"#, true).0, Level::Execution);
        assert_eq!(classify(r#"{"event":"fill"}"#, true).0, Level::Execution);
        assert_eq!(classify(r#"{"event":"backend_disconnect"}"#, true).0, Level::Error);
        assert_eq!(classify(r#"{"event":"STALE_MARKET_DATA","error":"HTTP 503"}"#, true).0, Level::Warn);
        assert_eq!(classify(r#"{"event":"CYCLE_START","cycle":0}"#, false).0, Level::Info);
    }

    #[test]
    fn classifies_loop_cycle_summaries() {
        assert_eq!(classify(r#"{"cycle":1,"outcome":"EXECUTED","reconciled":true}"#, false).0, Level::Execution);
        assert_eq!(classify(r#"{"cycle":1,"outcome":"REJECTED:DRAWDOWN_LIMIT_HIT","reconciled":true}"#, false).0, Level::Risk);
        assert_eq!(classify(r#"{"cycle":1,"outcome":"ERROR","error":"x"}"#, false).0, Level::Error);
        assert_eq!(classify(r#"{"cycle":1,"outcome":"NO_VALID_CANDIDATE","reconciled":false}"#, false).0, Level::Error);
    }

    #[test]
    fn classifies_plain_text() {
        assert_eq!(classify("Traceback (most recent call last):", true).0, Level::Error);
        assert_eq!(classify("INFO:     Uvicorn running on http://127.0.0.1:8765", true).0, Level::Info);
        assert_eq!(classify("WARNING: something", true).0, Level::Warn);
    }

    #[test]
    fn ring_is_bounded_and_since_is_incremental() {
        let store = LogStore::new(None);
        for i in 0..(CAPACITY + 10) {
            store.app(Level::Info, format!("line {i}"));
        }
        let all = store.since(0, usize::MAX);
        assert_eq!(all.len(), CAPACITY);
        let last = all.last().unwrap().seq;
        assert!(store.since(last, 100).is_empty());
        assert_eq!(store.since(last - 3, 100).len(), 3);
        assert_eq!(store.since(0, 10).len(), 10);
    }

    #[test]
    fn writes_separate_files_and_copies_reconciliation() {
        let dir = tempfile::tempdir().unwrap();
        let store = LogStore::new(Some(dir.path()));
        store.app(Level::Info, "desktop starting");
        store.push_line("execution-service", "INFO:     Uvicorn running", true);
        store.push_line("forward-loop", r#"{"cycle":1,"outcome":"EXECUTED","reconciled":true}"#, false);
        store.app_event(Level::Info, "reconcile", "RECONCILE NOW: reconciled");
        let read = |n: &str| tail_file(&dir.path().join(format!("{n}.log")), 100);
        assert_eq!(read("desktop").len(), 2);
        assert_eq!(read("execution-service").len(), 1);
        assert_eq!(read("forward-loop").len(), 1);
        let rec = read("reconciliation");
        assert_eq!(rec.len(), 2, "loop cycle + desktop reconcile");
        assert_eq!(rec[0].source, "forward-loop");
    }

    #[test]
    fn rotates_and_keeps_a_bounded_number_of_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = LogStore::with_rotation(Some(dir.path()), 2_000, 3);
        for i in 0..205 {
            store.app(Level::Info, format!("line {i} {}", "x".repeat(40)));
        }
        let p = |s: &str| dir.path().join(s);
        assert!(p("desktop.log").is_file() && p("desktop.log.1").is_file() && p("desktop.log.3").is_file());
        assert!(!p("desktop.log.4").exists());
        assert!(std::fs::metadata(p("desktop.log")).unwrap().len() <= 2_000);
        let tail = tail_file(&p("desktop.log"), 2);
        assert_eq!(tail.len(), 2);
        assert!(tail.last().unwrap().message.starts_with("line 204"));
    }

    #[test]
    fn iso_timestamps() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_790_486_400_123), "2026-09-27T05:20:00.123Z");
        assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn tracks_loop_schedule_from_its_own_lines() {
        let store = LogStore::new(None);
        store.push_line("forward-loop", r#"{"event":"CYCLE_START","cycle":0,"at":"2026-09-27T05:00:00.000Z"}"#, false);
        store.push_line("forward-loop", r#"{"cycle":0,"at":"2026-09-27T05:00:40.000Z","outcome":"NO_VALID_CANDIDATE","reconciled":true}"#, false);
        store.push_line("forward-loop", r#"{"event":"NEXT_CYCLE_AT","at":"2026-09-27T05:05:40.000Z"}"#, false);
        let t = store.loop_telemetry();
        assert_eq!(t.last_cycle_started_at.as_deref(), Some("2026-09-27T05:00:00.000Z"));
        assert_eq!(t.last_outcome.as_deref(), Some("NO_VALID_CANDIDATE"));
        assert_eq!(t.next_cycle_at.as_deref(), Some("2026-09-27T05:05:40.000Z"));
        assert_eq!(t.last_reconciled, Some(true));
        assert_eq!(t.cycles_seen, 1);
    }
}
