//! EXPORT BACKUP / IMPORT BACKUP.
//!
//! A backup is a zip file (`.mebackup`) with:
//!   manifest.json             format, app/schema version, sha256 + row counts of the DB
//!   market_edge_paper.sqlite3 consistent snapshot (SQLite online backup API, taken by
//!                             the bundled execution-service binary: `backup-db`)
//!   settings.json             non-secret desktop settings
//! Risk settings, trade/signal history, equity curve and reconciliation log
//! live in the database, so they are included. Secrets are NOT: the service
//! API key and operator keys stay in the OS keychain and never enter a backup
//! (manifest.secrets_included = false).
//!
//! Restore validates first (zip, manifest, sha256, SQLite integrity_check,
//! required tables, schema not newer than this build), then keeps the current
//! database as backups/pre-restore-*.sqlite3 before replacing it. Nothing is
//! deleted.

use crate::config::{AppConfig, UserConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const FORMAT: &str = "market-edge-backup";
pub const FORMAT_VERSION: u32 = 1;
pub const DB_ENTRY: &str = "market_edge_paper.sqlite3";
pub const EXTENSION: &str = "mebackup";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub created_at: String,
    pub app_version: String,
    pub git_sha: String,
    pub schema_version: u64,
    pub db_sha256: String,
    pub db_bytes: u64,
    pub counts: Value,
    pub starting_equity: Value,
    pub secrets_included: bool,
    pub contents: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Inspection {
    pub path: PathBuf,
    pub manifest: Manifest,
    pub validation: Value,
    #[serde(skip)]
    pub extracted_db: PathBuf,
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// Run one maintenance subcommand of the execution-service program
/// (the frozen binary when installed); returns its JSON output.
pub fn maintenance(cfg: &AppConfig, args: &[&str]) -> Result<Value, String> {
    let layout = &cfg.layout;
    let mut cmd = Command::new(&layout.exec_program);
    // a working directory that exists even before first run (self-check)
    let cwd = layout.exec_cwd.clone().unwrap_or_else(|| if cfg.data_dir.is_dir() { cfg.data_dir.clone() } else { std::env::temp_dir() });
    cmd.args(&layout.exec_args).args(args).current_dir(cwd);
    for k in ["PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"] {
        cmd.env_remove(k);
    }
    if let Some(m) = &layout.migrations_dir {
        cmd.env("EXECUTION_SERVICE_MIGRATIONS_DIR", m);
    }
    if let Some(b) = &layout.build_info_file {
        cmd.env("MARKET_EDGE_BUILD_INFO", b);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("could not run {}: {e}", layout.exec_program.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let last = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    let value: Value = serde_json::from_str(last)
        .map_err(|_| format!("{} {:?} gave no JSON (exit {:?}): {}", layout.exec_program.display(), args, out.status.code(), String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")))?;
    Ok(value)
}

fn stamp() -> String {
    crate::logs::iso_now().replace([':', '-'], "").replace('.', "-")
}

pub fn default_export_name() -> String {
    format!("market-edge-backup-{}.{EXTENSION}", &stamp()[..15])
}

/// Write a backup of the live database to `dest`.
pub fn export(cfg: &AppConfig, user: &UserConfig, dest: &Path, app_version: &str, git_sha: &str) -> Result<Manifest, String> {
    if !cfg.db_path.is_file() {
        return Err(format!("no database yet at {}", cfg.db_path.display()));
    }
    let work = cfg.backups_dir.join(format!(".export-{}", stamp()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = (|| {
        let snap = work.join(DB_ENTRY);
        let snap_s = snap.to_string_lossy().into_owned();
        let db_s = cfg.db_path.to_string_lossy().into_owned();
        let info = maintenance(cfg, &["backup-db", &db_s, &snap_s])?;
        if info.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(format!("snapshot failed validation: {info}"));
        }
        let manifest = Manifest {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            created_at: crate::logs::iso_now(),
            app_version: app_version.into(),
            git_sha: git_sha.into(),
            schema_version: info.get("schema_version").and_then(Value::as_u64).unwrap_or(0),
            db_sha256: sha256_file(&snap).map_err(|e| e.to_string())?,
            db_bytes: std::fs::metadata(&snap).map(|m| m.len()).unwrap_or(0),
            counts: info.get("counts").cloned().unwrap_or(Value::Null),
            starting_equity: info.get("starting_equity").cloned().unwrap_or(Value::Null),
            secrets_included: false,
            contents: vec!["manifest.json".into(), DB_ENTRY.into(), "settings.json".into()],
        };
        // non-secret desktop settings only
        let settings = serde_json::json!({"auto_start_paper": user.auto_start_paper, "versions_seen": user.versions_seen});
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = dest.with_extension("partial");
        {
            let file = std::fs::File::create(&tmp).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("manifest.json", opts).map_err(|e| e.to_string())?;
            zip.write_all(&serde_json::to_vec_pretty(&manifest).unwrap()).map_err(|e| e.to_string())?;
            zip.start_file("settings.json", opts).map_err(|e| e.to_string())?;
            zip.write_all(&serde_json::to_vec_pretty(&settings).unwrap()).map_err(|e| e.to_string())?;
            zip.start_file(DB_ENTRY, opts).map_err(|e| e.to_string())?;
            let mut db = std::fs::File::open(&snap).map_err(|e| e.to_string())?;
            std::io::copy(&mut db, &mut zip).map_err(|e| e.to_string())?;
            zip.finish().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
        Ok(manifest)
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}

/// Validate a backup without touching the live database. The extracted
/// database is left in backups/.restore-* for `restore`.
pub fn inspect(cfg: &AppConfig, path: &Path) -> Result<Inspection, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "not a Market Edge backup (not a zip archive)".to_string())?;
    let manifest: Manifest = {
        let mut entry = zip.by_name("manifest.json").map_err(|_| "not a Market Edge backup (no manifest.json)".to_string())?;
        let mut s = String::new();
        entry.read_to_string(&mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| format!("manifest.json is invalid: {e}"))?
    };
    if manifest.format != FORMAT {
        return Err(format!("unknown backup format '{}'", manifest.format));
    }
    if manifest.format_version > FORMAT_VERSION {
        return Err(format!("backup format v{} is newer than this app supports (v{FORMAT_VERSION})", manifest.format_version));
    }
    if manifest.secrets_included {
        return Err("backup claims to contain secrets; refusing".into());
    }
    let work = cfg.backups_dir.join(format!(".restore-{}", stamp()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let extracted = work.join(DB_ENTRY);
    {
        let mut entry = zip.by_name(DB_ENTRY).map_err(|_| "backup has no database".to_string())?;
        let mut out = std::fs::File::create(&extracted).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    let fail = |msg: String| {
        let _ = std::fs::remove_dir_all(&work);
        Err(msg)
    };
    match sha256_file(&extracted) {
        Ok(h) if h == manifest.db_sha256 => {}
        Ok(h) => return fail(format!("database checksum mismatch (backup corrupted): expected {}, got {h}", manifest.db_sha256)),
        Err(e) => return fail(e.to_string()),
    }
    let p = extracted.to_string_lossy().into_owned();
    let validation = match maintenance(cfg, &["validate-db", &p]) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    if validation.get("ok").and_then(Value::as_bool) != Some(true) {
        return fail(format!("backup database failed validation: {}", validation.get("problems").cloned().unwrap_or(validation.clone())));
    }
    Ok(Inspection { path: path.to_path_buf(), manifest, validation, extracted_db: extracted })
}

/// Replace the live database with a validated backup. The caller must have
/// stopped the forward loop and the execution-service. Returns the path the
/// previous database was kept at.
pub fn restore(cfg: &AppConfig, inspection: &Inspection) -> Result<Option<PathBuf>, String> {
    std::fs::create_dir_all(&cfg.backups_dir).map_err(|e| e.to_string())?;
    let kept = if cfg.db_path.is_file() {
        let dst = cfg.backups_dir.join(format!("pre-restore-{}.sqlite3", stamp()));
        std::fs::copy(&cfg.db_path, &dst).map_err(|e| format!("could not keep the current database: {e}"))?;
        Some(dst)
    } else {
        None
    };
    let tmp = cfg.db_path.with_extension("sqlite3.restoring");
    std::fs::copy(&inspection.extracted_db, &tmp).map_err(|e| e.to_string())?;
    for suffix in ["-journal", "-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", cfg.db_path.display()));
        if side.exists() {
            let _ = std::fs::rename(&side, cfg.backups_dir.join(format!("pre-restore-{}{suffix}", stamp())));
        }
    }
    std::fs::rename(&tmp, &cfg.db_path).map_err(|e| format!("could not install the restored database: {e}"))?;
    if let Some(dir) = inspection.extracted_db.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
    Ok(kept)
}

/// Remove a validated-but-not-restored extraction.
pub fn discard(inspection: &Inspection) {
    if let Some(dir) = inspection.extracted_db.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Every entry name in a backup (tests / diagnostics).
pub fn entries(path: &Path) -> Result<Vec<String>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    Ok(zip.file_names().map(str::to_string).collect())
}
