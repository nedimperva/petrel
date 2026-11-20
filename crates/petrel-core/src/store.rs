//! The SQLite store: one connection, the schema steps, settings, and the undo list. The notes index and every
//! note operation are in `notes.rs`; the files in the folder are the truth and this database can be rebuilt
//! from them. Schema steps are forward-only, each in its own transaction (`schema.rs`). Before the first step
//! runs on a file-backed database, the file is copied to `backups/` (SQLite backup API), so a migration can
//! never be the thing that loses someone's text.
//!
//! Everything here is synchronous behind one connection; callers hold the `Store` in a `Mutex`. The one other
//! connection is the checkpointer's (`Checkpointer`), which copies the WAL into the database file off the write
//! path.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::retention::Retention;
use crate::schema::{SCHEMA, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4};

/// The schema version this build writes. A database with a higher `meta.schema_version` is refused.
pub const SCHEMA_VERSION: i64 = 5;

/// How many backups `backup_before_migrate` keeps.
const BACKUPS_KEPT: usize = 5;

/// A new `edit` version of a note is taken when the newest one is older than this.
pub const VERSION_INTERVAL_MS: i64 = 5 * 60 * 1000;

/// How often the checkpointer copies the WAL into the database file. This is also about the most a power cut can
/// take under `synchronous = NORMAL` (an app crash loses nothing); SQLite's default was 1,000 pages of writes.
const CHECKPOINT_EVERY: Duration = Duration::from_secs(2);

/// The WAL size at which a write checkpoints inline after all, if the checkpointer has fallen behind or is not
/// running (~16 MB).
const WAL_CAP_PAGES: i64 = 4_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoToken {
    pub token: String,
    /// How many steps the change took.
    pub count: usize,
}

pub struct Store {
    /// Declared first so it stops before the main connection closes; the last connection out removes the WAL.
    _checkpointer: Option<Checkpointer>,
    pub(crate) conn: Connection,
    path: Option<PathBuf>,
    /// Milliseconds since the epoch; swapped out by tests.
    clock: Box<dyn Fn() -> i64 + Send>,
    /// Renames, moves and trashed notes, newest last (`notes.rs`).
    pub(crate) notes_undo: VecDeque<crate::notes::NotesUndo>,
}

fn system_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Store {
    /// Opens (creating if needed) the database at `path` and brings it to `SCHEMA_VERSION`.
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        let mut store = Store {
            _checkpointer: None,
            conn,
            path: Some(path.to_path_buf()),
            clock: Box::new(system_now),
            notes_undo: VecDeque::new(),
        };
        store.init()?;
        // After `init`, so the checkpointer never sees a database mid-migration.
        store.conn.pragma_update(None, "wal_autocheckpoint", WAL_CAP_PAGES)?;
        store._checkpointer = Some(Checkpointer::spawn(path)?);
        Ok(store)
    }

    /// An in-memory store for tests.
    pub fn open_in_memory() -> Result<Store> {
        let conn = Connection::open_in_memory()?;
        let mut store = Store {
            _checkpointer: None,
            conn,
            path: None,
            clock: Box::new(system_now),
            notes_undo: VecDeque::new(),
        };
        store.init()?;
        Ok(store)
    }

    /// Tests inject time; the app never calls this.
    pub fn set_clock(&mut self, clock: impl Fn() -> i64 + Send + 'static) {
        self.clock = Box::new(clock);
    }

    pub(crate) fn now(&self) -> i64 {
        (self.clock)()
    }

    fn init(&mut self) -> Result<()> {
        // `rarray(?)` binds a list of ids as one parameter, so id sets never become SQL text.
        rusqlite::vtab::array::load_module(&self.conn)?;
        self.conn.pragma_update(None, "journal_mode", "WAL")?;
        self.conn.pragma_update(None, "synchronous", "NORMAL")?;
        self.conn.pragma_update(None, "foreign_keys", "ON")?;
        self.conn.busy_timeout(std::time::Duration::from_secs(5))?;
        self.migrate()
    }

    pub fn schema_version(&self) -> Result<i64> {
        let has_meta: bool = self.conn.query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
            [],
            |r| r.get(0),
        )?;
        if !has_meta {
            return Ok(0);
        }
        let v: Option<String> = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0))
            .optional()?;
        Ok(v.and_then(|s| s.parse().ok()).unwrap_or(0))
    }

    /// Applies v1 and every later step up to `SCHEMA_VERSION`. Refuses a newer database.
    fn migrate(&mut self) -> Result<()> {
        let mut version = self.schema_version()?;
        if version > SCHEMA_VERSION {
            bail!(
                "this database was written by a newer Petrel (schema {version}, this build knows {SCHEMA_VERSION}); \
                 update Petrel or restore a backup"
            );
        }
        if version == SCHEMA_VERSION {
            return Ok(());
        }
        if version > 0 {
            self.backup_before_migrate(version)?;
        }
        while version < SCHEMA_VERSION {
            let next = version + 1;
            let tx = self.conn.transaction()?;
            match next {
                1 => {
                    tx.execute_batch(SCHEMA)?;
                    let now = system_now();
                    tx.execute(
                        "INSERT INTO meta (key, value) VALUES ('device_id', ?1), ('created', ?2)",
                        params![uuid::Uuid::new_v4().to_string(), now.to_string()],
                    )?;
                }
                2 => tx.execute_batch(SCHEMA_V2)?,
                3 => tx.execute_batch(SCHEMA_V3)?,
                4 => tx.execute_batch(SCHEMA_V4)?,
                5 => tx.execute_batch(crate::notes::SCHEMA_V5)?,
                _ => unreachable!("no migration step for v{next}"),
            }
            tx.execute(
                "INSERT INTO meta (key, value) VALUES ('schema_version', ?1) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![next.to_string()],
            )?;
            tx.commit()?;
            version = next;
        }
        Ok(())
    }

    /// Copies the database to `<dir>/backups/petrel-v<version>-<date>.db` and keeps the newest `BACKUPS_KEPT`.
    fn backup_before_migrate(&self, version: i64) -> Result<Option<PathBuf>> {
        let Some(path) = &self.path else { return Ok(None) };
        let dir = path.parent().unwrap_or(Path::new(".")).join("backups");
        std::fs::create_dir_all(&dir)?;
        let date = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let target = dir.join(format!("petrel-v{version}-{date}.db"));
        let mut dest = Connection::open(&target)?;
        {
            let backup = rusqlite::backup::Backup::new(&self.conn, &mut dest)?;
            backup.run_to_completion(256, std::time::Duration::from_millis(0), None)?;
        }
        // The copy inherits WAL mode from the header; a backup should be one file, not three.
        dest.pragma_update(None, "journal_mode", "DELETE")?;
        drop(dest);
        let mut backups: Vec<PathBuf> = std::fs::read_dir(&dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|e| e == "db"))
            .collect();
        backups.sort();
        for old in backups.iter().rev().skip(BACKUPS_KEPT) {
            remove_with_retry(old);
        }
        Ok(Some(target))
    }

    /// The database file, if any (the UI shows it in About).
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Puts a change back. A token works once; an unknown one (too old, already used, or from before a restart)
    /// is an error the UI can show as "nothing to undo".
    pub fn undo(&mut self, token: &str) -> Result<usize> {
        if !token.starts_with(crate::notes::TOKEN_PREFIX) {
            bail!("nothing to undo: that change is too old or was already undone");
        }
        self.undo_notes(token)
    }

    // ---- housekeeping ------------------------------------------------------------------------------------

    pub fn retention(&self) -> Result<Retention> {
        Ok(Retention::from_settings(|k| self.setting(k).ok().flatten()))
    }

    /// Housekeeping, at start and daily: notes' versions are thinned by age tier (`retention`). The save path
    /// never deletes anything; this is the only place.
    pub fn sweep(&mut self) -> Result<SweepReport> {
        Ok(SweepReport { versions_thinned: self.thin_note_histories()? })
    }

    // ---- settings ----------------------------------------------------------------------------------------

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Every setting whose key starts with `prefix` (the UI reads its `ui.` settings in one call at start).
    pub fn settings_with_prefix(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        // `>=` and `<` instead of LIKE, so `_` and `%` in a prefix are not wildcards.
        let mut end = prefix.to_string();
        end.push(char::MAX);
        let mut st =
            self.conn.prepare("SELECT key, value FROM settings WHERE key >= ?1 AND key < ?2 ORDER BY key")?;
        let rows = st.query_map(params![prefix, end], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// For benchmarks and tests only: run arbitrary SQL.
    #[doc(hidden)]
    pub fn raw(&self) -> &Connection {
        &self.conn
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepReport {
    pub versions_thinned: usize,
}

/// Copies the WAL into the database file every `CHECKPOINT_EVERY` on a thread and connection of its own. With
/// SQLite's default, the write that crosses 1,000 WAL pages does the copy and the fsyncs itself; on Windows that
/// write took a second. A PASSIVE checkpoint takes no lock a writer needs, so the store's writes never wait for
/// it, and it does nothing when the WAL has nothing new.
struct Checkpointer {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl Checkpointer {
    fn spawn(path: &Path) -> Result<Checkpointer> {
        let conn =
            Connection::open(path).with_context(|| format!("opening {} to checkpoint", path.display()))?;
        let (stop, stopped) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new().name("petrel-checkpoint".into()).spawn(move || {
            while let Err(mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(CHECKPOINT_EVERY) {
                // A failed pass is retried on the next tick, and the WAL cap is the backstop.
                let _ = conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()));
            }
        })?;
        Ok(Checkpointer { stop: Some(stop), thread: Some(thread) })
    }
}

impl Drop for Checkpointer {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

pub(crate) fn id_array(ids: &[i64]) -> rusqlite::vtab::array::Array {
    Rc::new(ids.iter().copied().map(Value::from).collect())
}

/// Deletes a file, retrying briefly: on Windows a file just written can be held for a moment by the indexer
/// or the antivirus, and a backup that cannot be pruned today is only clutter, not an error.
fn remove_with_retry(path: &Path) {
    for attempt in 0..5 {
        match std::fs::remove_file(path) {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) if attempt < 4 => std::thread::sleep(std::time::Duration::from_millis(50 << attempt)),
            Err(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_database_is_at_the_current_schema_and_reopens() {
        let dir = std::env::temp_dir().join(format!("petrel-store-{}", uuid::Uuid::new_v4()));
        let path = dir.join("petrel.db");
        {
            let s = Store::open(&path).unwrap();
            assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
            s.set_setting("ui.x", "1").unwrap();
        }
        let s = Store::open(&path).unwrap();
        assert_eq!(s.setting("ui.x").unwrap().as_deref(), Some("1"));
        assert_eq!(s.settings_with_prefix("ui.").unwrap(), vec![("ui.x".to_string(), "1".to_string())]);
        drop(s);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_database_from_a_newer_petrel_is_refused() {
        let dir = std::env::temp_dir().join(format!("petrel-store-{}", uuid::Uuid::new_v4()));
        let path = dir.join("petrel.db");
        Store::open(&path)
            .unwrap()
            .raw()
            .execute("UPDATE meta SET value = '99' WHERE key = 'schema_version'", [])
            .unwrap();
        assert!(Store::open(&path).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_old_token_is_nothing_to_undo() {
        let mut s = Store::open_in_memory().unwrap();
        assert!(s.undo("batch-1").is_err());
    }
}
