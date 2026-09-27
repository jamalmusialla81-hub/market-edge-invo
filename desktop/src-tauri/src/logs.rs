//! Log capture for the child processes the app manages (execution-service,
//! forward paper loop) plus the controller's own events.
//!
//! Every line is classified into one of the five levels the System screen
//! filters on (INFO, WARN, ERROR, RISK, EXECUTION) from the structured JSON
//! events the services already emit (telemetry/logging.py, forward_loop.mjs).
//! Lines are kept in a bounded in-memory ring and appended to a log file in
//! the app data directory; neither is trading state.

use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const CAPACITY: usize = 5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Level {
    Info,
    Warn,
    Error,
    Risk,
    Execution,
}

#[derive(Debug, Clone, Serialize)]
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
    file: Option<File>,
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
    pub fn new(file_path: Option<&Path>) -> Self {
        let file = file_path.and_then(|p| {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            OpenOptions::new().create(true).append(true).open(p).ok()
        });
        LogStore {
            inner: Mutex::new(Inner { entries: VecDeque::with_capacity(CAPACITY), next_seq: 1, file, loop_telemetry: LoopTelemetry::default() }),
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

    fn push(&self, source: &str, level: Level, event: Option<String>, message: String) {
        let mut inner = self.inner.lock().unwrap();
        let entry = LogEntry { seq: inner.next_seq, at_ms: now_ms(), source: source.to_string(), level, event, message };
        inner.next_seq += 1;
        if let Some(file) = inner.file.as_mut() {
            let _ = writeln!(file, "{}", serde_json::to_string(&entry).unwrap_or_default());
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
