//! The SQLite store. Schema v1 is `SCHEMA`; later versions are numbered steps in `migrate()`, forward-only,
//! each in its own transaction. Before the first step runs on a file-backed database, the file is copied to
//! `backups/` (SQLite backup API), so a migration can never be the thing that loses someone's text.
//!
//! Everything here is synchronous behind one connection; callers hold the `Store` in a `Mutex`. Writes are
//! tiny (autosave is one UPDATE), so this has not needed a pool. See `docs/research/data-model.md`.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::title;

/// The schema version this build writes. A database with a higher `meta.schema_version` is refused.
pub const SCHEMA_VERSION: i64 = 1;

/// How many backups `backup_before_migrate` keeps.
const BACKUPS_KEPT: usize = 5;

/// A new `edit` version is taken when the newest one is older than this.
pub const VERSION_INTERVAL_MS: i64 = 5 * 60 * 1000;

/// How many of the newest matches a search considers; see `Store::search`.
pub const SEARCH_WINDOW: usize = 400;

/// Drafts in Trash longer than this become tombstones in `sweep()`.
pub const TRASH_DAYS: i64 = 30;
/// Tombstones older than this are deleted in `sweep()`.
pub const TOMBSTONE_DAYS: i64 = 90;

const SCHEMA: &str = r#"
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE drafts (
  id          INTEGER PRIMARY KEY,
  uuid        TEXT NOT NULL UNIQUE,
  content     TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  preview     TEXT NOT NULL DEFAULT '',
  folder      INTEGER NOT NULL DEFAULT 0,
  flagged     INTEGER NOT NULL DEFAULT 0,
  syntax      TEXT NOT NULL DEFAULT 'markdown',
  cursor      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX drafts_list     ON drafts (folder, modified_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX drafts_created  ON drafts (folder, created_at  DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX drafts_accessed ON drafts (folder, accessed_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX drafts_flagged  ON drafts (flagged, modified_at DESC) WHERE flagged = 1 AND deleted_at IS NULL;
CREATE INDEX drafts_trash    ON drafts (modified_at) WHERE folder = 2 AND deleted_at IS NULL;

CREATE VIRTUAL TABLE drafts_fts USING fts5 (
  content, title,
  content = 'drafts', content_rowid = 'id',
  tokenize = "unicode61 remove_diacritics 2"
);
CREATE TRIGGER drafts_ai AFTER INSERT ON drafts BEGIN
  INSERT INTO drafts_fts (rowid, content, title) VALUES (new.id, new.content, new.title);
END;
CREATE TRIGGER drafts_ad AFTER DELETE ON drafts BEGIN
  INSERT INTO drafts_fts (drafts_fts, rowid, content, title) VALUES ('delete', old.id, old.content, old.title);
END;
CREATE TRIGGER drafts_au AFTER UPDATE OF content, title ON drafts BEGIN
  INSERT INTO drafts_fts (drafts_fts, rowid, content, title) VALUES ('delete', old.id, old.content, old.title);
  INSERT INTO drafts_fts (rowid, content, title) VALUES (new.id, new.content, new.title);
END;

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE draft_tags (
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (draft_id, tag_id)
);
CREATE INDEX draft_tags_tag ON draft_tags (tag_id, draft_id);

CREATE TABLE versions (
  id         INTEGER PRIMARY KEY,
  uuid       TEXT NOT NULL UNIQUE,
  draft_id   INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX versions_draft ON versions (draft_id, created_at DESC);

CREATE TABLE action_groups (
  id         INTEGER PRIMARY KEY,
  uuid       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE actions (
  id            INTEGER PRIMARY KEY,
  uuid          TEXT NOT NULL UNIQUE,
  group_id      INTEGER REFERENCES action_groups(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  icon          TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL DEFAULT '',
  shortcut      TEXT,
  position      INTEGER NOT NULL,
  steps         TEXT NOT NULL,
  after_success TEXT NOT NULL DEFAULT 'nothing',
  add_tags      TEXT NOT NULL DEFAULT '',
  confirm       INTEGER NOT NULL DEFAULT 0,
  disabled      INTEGER NOT NULL DEFAULT 0,
  hidden        INTEGER NOT NULL DEFAULT 0,
  trusted_hash  TEXT,
  modified_at   INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX actions_group ON actions (group_id, position) WHERE deleted_at IS NULL;

CREATE TABLE action_runs (
  id         INTEGER PRIMARY KEY,
  action_id  INTEGER REFERENCES actions(id) ON DELETE SET NULL,
  draft_id   INTEGER REFERENCES drafts(id)  ON DELETE SET NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  status     TEXT NOT NULL,
  step       INTEGER,
  message    TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL
);
CREATE INDEX action_runs_time ON action_runs (started_at DESC);

CREATE TABLE workspaces (
  id           INTEGER PRIMARY KEY,
  uuid         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL,
  folder       INTEGER,
  query        TEXT NOT NULL DEFAULT '',
  tags_include TEXT NOT NULL DEFAULT '',
  tags_exclude TEXT NOT NULL DEFAULT '',
  flagged_only INTEGER NOT NULL DEFAULT 0,
  sort         TEXT NOT NULL DEFAULT 'modified',
  sort_desc    INTEGER NOT NULL DEFAULT 1,
  flagged_top  INTEGER NOT NULL DEFAULT 1,
  group_id     INTEGER REFERENCES action_groups(id) ON DELETE SET NULL,
  deleted_at   INTEGER
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"#;

/// Where a draft lives. Stored as an integer; the names are the wire format.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Folder {
    Inbox = 0,
    Archive = 1,
    Trash = 2,
}

impl Folder {
    fn from_i64(n: i64) -> Result<Folder> {
        Ok(match n {
            0 => Folder::Inbox,
            1 => Folder::Archive,
            2 => Folder::Trash,
            _ => bail!("unknown folder {n}"),
        })
    }
}

/// A whole draft, as the editor needs it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: i64,
    pub uuid: String,
    pub content: String,
    pub title: String,
    pub folder: Folder,
    pub flagged: bool,
    pub syntax: String,
    pub cursor: i64,
    pub created_at: i64,
    pub modified_at: i64,
    pub accessed_at: i64,
    pub tags: Vec<String>,
    pub version_count: i64,
}

/// One row of the list: never the content.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub id: i64,
    pub uuid: String,
    pub title: String,
    pub preview: String,
    pub folder: Folder,
    pub flagged: bool,
    pub modified_at: i64,
}

/// A page of the list and the cursor that fetches the next one (`None` at the end).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPage {
    pub rows: Vec<DraftSummary>,
    pub next: Option<Cursor>,
}

/// Keyset cursor: the sort key and id of the last row seen.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub key: i64,
    pub id: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: i64,
    pub title: String,
    /// `snippet()` over the content with the match marked by `\u{1}`…`\u{2}`; the UI turns those into marks.
    pub snippet: String,
    pub modified_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: i64,
    pub uuid: String,
    pub reason: String,
    pub created_at: i64,
    pub length: i64,
}

pub struct Store {
    conn: Connection,
    path: Option<PathBuf>,
    /// Milliseconds since the epoch; swapped out by tests.
    clock: Box<dyn Fn() -> i64 + Send>,
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
        let mut store = Store { conn, path: Some(path.to_path_buf()), clock: Box::new(system_now) };
        store.init()?;
        Ok(store)
    }

    /// An in-memory store for tests and the UI's fake mode.
    pub fn open_in_memory() -> Result<Store> {
        let conn = Connection::open_in_memory()?;
        let mut store = Store { conn, path: None, clock: Box::new(system_now) };
        store.init()?;
        Ok(store)
    }

    /// Tests inject time; the UI never calls this.
    pub fn set_clock(&mut self, clock: impl Fn() -> i64 + Send + 'static) {
        self.clock = Box::new(clock);
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn init(&mut self) -> Result<()> {
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

    /// Applies v1 (`SCHEMA`) and every later step up to `SCHEMA_VERSION`. Refuses a newer database.
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

    // ---- drafts ------------------------------------------------------------------------------------------

    /// Creates a draft in the Inbox. The editor calls this on the first keystroke, so an untouched new draft
    /// never becomes a row.
    pub fn new_draft(&self, content: &str) -> Result<Draft> {
        let now = self.now();
        self.conn.execute(
            "INSERT INTO drafts (uuid, content, title, preview, created_at, modified_at, accessed_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                content,
                title::title(content),
                title::preview(content),
                now
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        self.draft(id)
    }

    /// The autosave write: one UPDATE, plus a version when one is due. Returns false if the draft is gone.
    pub fn save(&self, id: i64, content: &str, cursor: i64) -> Result<bool> {
        let now = self.now();
        self.version_if_due(id, now)?;
        let n = self.conn.execute(
            "UPDATE drafts SET content = ?2, title = ?3, preview = ?4, cursor = ?5, modified_at = ?6 \
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id, content, title::title(content), title::preview(content), cursor, now],
        )?;
        Ok(n == 1)
    }

    /// Remembers the cursor without touching `modified_at`.
    pub fn save_cursor(&self, id: i64, cursor: i64) -> Result<()> {
        self.conn.execute("UPDATE drafts SET cursor = ?2 WHERE id = ?1", params![id, cursor])?;
        Ok(())
    }

    /// A draft with its tags and version count. Marks it accessed.
    pub fn draft(&self, id: i64) -> Result<Draft> {
        let now = self.now();
        self.conn.execute(
            "UPDATE drafts SET accessed_at = ?2 WHERE id = ?1 AND accessed_at < ?2 - 60000",
            params![id, now],
        )?;
        let mut draft = self
            .conn
            .query_row(
                "SELECT d.id, d.uuid, d.content, d.title, d.folder, d.flagged, d.syntax, d.cursor, d.created_at, \
                        d.modified_at, d.accessed_at, \
                        (SELECT COUNT(*) FROM versions v WHERE v.draft_id = d.id) \
                 FROM drafts d WHERE d.id = ?1 AND d.deleted_at IS NULL",
                params![id],
                |r| {
                    Ok(Draft {
                        id: r.get(0)?,
                        uuid: r.get(1)?,
                        content: r.get(2)?,
                        title: r.get(3)?,
                        folder: Folder::from_i64(r.get(4)?).map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Integer, e.into())
                        })?,
                        flagged: r.get::<_, i64>(5)? != 0,
                        syntax: r.get(6)?,
                        cursor: r.get(7)?,
                        created_at: r.get(8)?,
                        modified_at: r.get(9)?,
                        accessed_at: r.get(10)?,
                        tags: Vec::new(),
                        version_count: r.get(11)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| anyhow!("draft {id} does not exist"))?;
        draft.tags = self.tags_of(id)?;
        Ok(draft)
    }

    pub fn find_by_uuid(&self, uuid: &str) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row("SELECT id FROM drafts WHERE uuid = ?1 AND deleted_at IS NULL", params![uuid], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_folder(&self, id: i64, folder: Folder) -> Result<()> {
        let now = self.now();
        self.conn.execute(
            "UPDATE drafts SET folder = ?2, modified_at = ?3 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, folder as i64, now],
        )?;
        Ok(())
    }

    pub fn set_flagged(&self, id: i64, flagged: bool) -> Result<()> {
        let now = self.now();
        self.conn.execute(
            "UPDATE drafts SET flagged = ?2, modified_at = ?3 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, flagged as i64, now],
        )?;
        Ok(())
    }

    /// One page of a folder, newest modified first. Tag and search filters arrive with package 05.
    pub fn list(&self, folder: Folder, cursor: Option<Cursor>, limit: usize) -> Result<ListPage> {
        let (key, id) = cursor.map(|c| (c.key, c.id)).unwrap_or((i64::MAX, i64::MAX));
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, uuid, title, preview, folder, flagged, modified_at FROM drafts \
             WHERE folder = ?1 AND deleted_at IS NULL AND (modified_at < ?2 OR (modified_at = ?2 AND id < ?3)) \
             ORDER BY modified_at DESC, id DESC LIMIT ?4",
        )?;
        let mut rows: Vec<DraftSummary> = stmt
            .query_map(params![folder as i64, key, id, limit as i64 + 1], summary)?
            .collect::<rusqlite::Result<_>>()?;
        let next = if rows.len() > limit {
            rows.truncate(limit);
            rows.last().map(|r| Cursor { key: r.modified_at, id: r.id })
        } else {
            None
        };
        Ok(ListPage { rows, next })
    }

    /// Full-text search over Inbox and Archive, newest modified first.
    ///
    /// FTS5 can walk a term's matches in descending rowid order and stop early, which costs microseconds
    /// however common the word is; ranking by bm25 costs ~0.5 µs per match and reaches 20 ms for a word in
    /// most drafts. So Petrel takes the `SEARCH_WINDOW` most recently created matches and orders those by
    /// `modified_at`. For a term in fewer than `SEARCH_WINDOW` drafts this is exact; for a more common term it
    /// is "the newest drafts with that word", which is what a person typing a common word gets anyway and can
    /// narrow with a second word. Snippets are made in Rust from the content, which is cheaper than FTS5's
    /// `snippet()` by rowid. User input is quoted token by token so FTS syntax can never produce an error; the
    /// last token matches as a prefix so results appear while typing.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let fts = fts_query(query);
        if fts.is_empty() {
            return Ok(Vec::new());
        }
        let mut newest = self.conn.prepare_cached(
            "SELECT rowid FROM drafts_fts WHERE drafts_fts MATCH ?1 ORDER BY rowid DESC LIMIT ?2",
        )?;
        let ids: Vec<i64> = newest
            .query_map(params![fts, SEARCH_WINDOW as i64], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        // Integers only, so building the IN list is safe; a 400-value IN prepares in well under 0.1 ms.
        let list = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
        let mut rows = self.conn.prepare(&format!(
            "SELECT id, title, content, modified_at FROM drafts \
             WHERE id IN ({list}) AND deleted_at IS NULL AND folder != 2 ORDER BY modified_at DESC LIMIT ?1"
        ))?;
        let terms: Vec<String> = search_terms(query);
        let hits = rows
            .query_map(params![limit as i64], |r| {
                let content: String = r.get(2)?;
                Ok(SearchHit {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    snippet: snippet(&content, &terms),
                    modified_at: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(hits)
    }

    pub fn count(&self, folder: Folder) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM drafts WHERE folder = ?1 AND deleted_at IS NULL",
            params![folder as i64],
            |r| r.get(0),
        )?)
    }

    // ---- tags --------------------------------------------------------------------------------------------

    pub fn tags_of(&self, id: i64) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT t.name FROM tags t JOIN draft_tags dt ON dt.tag_id = t.id WHERE dt.draft_id = ?1 ORDER BY t.name",
        )?;
        let tags = stmt.query_map(params![id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(tags)
    }

    /// Replaces a draft's tags. Names are trimmed and lower-cased; empty and duplicate names are dropped.
    pub fn set_tags(&mut self, id: i64, names: &[String]) -> Result<Vec<String>> {
        let mut clean: Vec<String> =
            names.iter().map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty()).collect();
        clean.sort();
        clean.dedup();
        let now = self.now();
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM draft_tags WHERE draft_id = ?1", params![id])?;
        for name in &clean {
            tx.execute(
                "INSERT INTO tags (uuid, name) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING",
                params![uuid::Uuid::new_v4().to_string(), name],
            )?;
            tx.execute(
                "INSERT INTO draft_tags (draft_id, tag_id) SELECT ?1, id FROM tags WHERE name = ?2",
                params![id, name],
            )?;
        }
        tx.execute("UPDATE drafts SET modified_at = ?2 WHERE id = ?1", params![id, now])?;
        tx.commit()?;
        Ok(clean)
    }

    // ---- versions ----------------------------------------------------------------------------------------

    /// Snapshots the current text as an `edit` version when the newest version is older than
    /// `VERSION_INTERVAL_MS` (or there is none). Called from `save` before the new text goes in.
    fn version_if_due(&self, id: i64, now: i64) -> Result<bool> {
        let newest: Option<i64> = self.conn.query_row(
            "SELECT MAX(created_at) FROM versions WHERE draft_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        if newest.is_some_and(|t| now - t < VERSION_INTERVAL_MS) {
            return Ok(false);
        }
        self.snapshot(id, "edit", now)
    }

    /// Always snapshots: before an action run, before a restore.
    pub fn snapshot(&self, id: i64, reason: &str, now: i64) -> Result<bool> {
        let n = self.conn.execute(
            "INSERT INTO versions (uuid, draft_id, content, reason, created_at) \
             SELECT ?1, id, content, ?3, ?4 FROM drafts WHERE id = ?2 AND deleted_at IS NULL AND content != ''",
            params![uuid::Uuid::new_v4().to_string(), id, reason, now],
        )?;
        Ok(n == 1)
    }

    pub fn versions(&self, id: i64) -> Result<Vec<Version>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, uuid, reason, created_at, length(content) FROM versions \
             WHERE draft_id = ?1 ORDER BY created_at DESC, id DESC",
        )?;
        let v = stmt
            .query_map(params![id], |r| {
                Ok(Version {
                    id: r.get(0)?,
                    uuid: r.get(1)?,
                    reason: r.get(2)?,
                    created_at: r.get(3)?,
                    length: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(v)
    }

    pub fn version_content(&self, version_id: i64) -> Result<String> {
        Ok(self
            .conn
            .query_row("SELECT content FROM versions WHERE id = ?1", params![version_id], |r| r.get(0))?)
    }

    /// Puts a version's text back. The current text becomes a `restore` version first.
    pub fn restore(&mut self, version_id: i64) -> Result<Draft> {
        let now = self.now();
        let (draft_id, content): (i64, String) = self.conn.query_row(
            "SELECT draft_id, content FROM versions WHERE id = ?1",
            params![version_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO versions (uuid, draft_id, content, reason, created_at) \
             SELECT ?1, id, content, 'restore', ?3 FROM drafts WHERE id = ?2",
            params![uuid::Uuid::new_v4().to_string(), draft_id, now],
        )?;
        tx.execute(
            "UPDATE drafts SET content = ?2, title = ?3, preview = ?4, modified_at = ?5 WHERE id = ?1",
            params![draft_id, content, title::title(&content), title::preview(&content), now],
        )?;
        tx.commit()?;
        self.draft(draft_id)
    }

    // ---- housekeeping -------------------------------------------------------------------------------------

    /// Trash older than `TRASH_DAYS` becomes tombstones (content cleared, versions gone); tombstones older
    /// than `TOMBSTONE_DAYS` are deleted; tags nobody uses are removed. Runs at start and daily.
    /// Version thinning by age tier arrives with package 01.
    pub fn sweep(&mut self) -> Result<SweepReport> {
        let now = self.now();
        let day = 24 * 60 * 60 * 1000;
        let tx = self.conn.transaction()?;
        let tombstoned = tx.execute(
            "UPDATE drafts SET deleted_at = ?1, content = '', title = '', preview = '' \
             WHERE folder = 2 AND deleted_at IS NULL AND modified_at < ?2",
            params![now, now - TRASH_DAYS * day],
        )?;
        tx.execute(
            "DELETE FROM versions WHERE draft_id IN (SELECT id FROM drafts WHERE deleted_at IS NOT NULL)",
            [],
        )?;
        let purged = tx.execute(
            "DELETE FROM drafts WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
            params![now - TOMBSTONE_DAYS * day],
        )?;
        let tags = tx.execute("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM draft_tags)", [])?;
        tx.commit()?;
        Ok(SweepReport { tombstoned, purged, tags_removed: tags })
    }

    /// Empties the Trash now: tombstones, no undo.
    pub fn empty_trash(&mut self) -> Result<usize> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM versions WHERE draft_id IN (SELECT id FROM drafts WHERE folder = 2)", [])?;
        let n = tx.execute(
            "UPDATE drafts SET deleted_at = ?1, content = '', title = '', preview = '' \
             WHERE folder = 2 AND deleted_at IS NULL",
            params![now],
        )?;
        tx.commit()?;
        Ok(n)
    }

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

    /// For benchmarks and tests only: run arbitrary SQL.
    #[doc(hidden)]
    pub fn raw(&self) -> &Connection {
        &self.conn
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct SweepReport {
    pub tombstoned: usize,
    pub purged: usize,
    pub tags_removed: usize,
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

fn summary(r: &Row) -> rusqlite::Result<DraftSummary> {
    Ok(DraftSummary {
        id: r.get(0)?,
        uuid: r.get(1)?,
        title: r.get(2)?,
        preview: r.get(3)?,
        folder: Folder::from_i64(r.get(4)?).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Integer, e.into())
        })?,
        flagged: r.get::<_, i64>(5)? != 0,
        modified_at: r.get(6)?,
    })
}

/// Turns what the user typed into an FTS5 query that cannot fail to parse: every token is a quoted string
/// (embedded quotes doubled), the last one is a prefix match, tokens are ANDed.
pub fn fts_query(input: &str) -> String {
    let tokens: Vec<&str> = input.split_whitespace().collect();
    let mut out = Vec::with_capacity(tokens.len());
    for (i, tok) in tokens.iter().enumerate() {
        let tok = tok.trim_matches(|c: char| !c.is_alphanumeric());
        if tok.is_empty() {
            continue;
        }
        let quoted = format!("\"{}\"", tok.replace('"', "\"\""));
        if i == tokens.len() - 1 {
            out.push(format!("{quoted}*"));
        } else {
            out.push(quoted);
        }
    }
    out.join(" ")
}

/// The cleaned tokens of a query, lower-cased, for highlighting.
fn search_terms(input: &str) -> Vec<String> {
    input
        .split_whitespace()
        .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
        .filter(|t| !t.is_empty())
        .collect()
}

/// About `SNIPPET_WORDS` words around the first term found, with every term occurrence in that window wrapped
/// in `\u{1}`…`\u{2}`. Falls back to the start of the body when no term is found (a diacritic-folded match).
pub fn snippet(content: &str, terms: &[String]) -> String {
    const SNIPPET_WORDS: usize = 14;
    let words: Vec<&str> = content.split_whitespace().collect();
    let matches = |w: &str| {
        let lw = w.to_lowercase();
        terms.iter().any(|t| lw.contains(t.as_str()))
    };
    let first = words.iter().position(|w| matches(w));
    let start = first.map(|i| i.saturating_sub(SNIPPET_WORDS / 3)).unwrap_or(0);
    let end = (start + SNIPPET_WORDS).min(words.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    for (i, w) in words[start..end].iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        if matches(w) {
            out.push('\u{1}');
            out.push_str(w);
            out.push('\u{2}');
        } else {
            out.push_str(w);
        }
    }
    if end < words.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    /// A store whose clock is the returned counter (milliseconds).
    fn store_with_clock(start: i64) -> (Store, Arc<AtomicI64>) {
        let mut s = store();
        let now = Arc::new(AtomicI64::new(start));
        let c = now.clone();
        s.set_clock(move || c.load(Ordering::SeqCst));
        (s, now)
    }

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn fresh_database_is_at_current_version() {
        let s = store();
        assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(s
            .conn
            .query_row("SELECT value FROM meta WHERE key = 'device_id'", [], |r| r.get::<_, String>(0))
            .is_ok());
    }

    #[test]
    fn reopening_a_file_keeps_drafts_and_does_not_migrate_again() {
        let dir = std::env::temp_dir().join(format!("petrel-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("petrel.db");
        let id = {
            let s = Store::open(&path).unwrap();
            s.new_draft("Hello\nworld").unwrap().id
        };
        let s = Store::open(&path).unwrap();
        assert_eq!(s.draft(id).unwrap().title, "Hello");
        assert!(!dir.join("backups").exists(), "no migration ran, so no backup");
        drop(s); // Windows will not delete an open database
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_newer_database_is_refused() {
        let s = store();
        s.conn.execute("UPDATE meta SET value = '999' WHERE key = 'schema_version'", []).unwrap();
        let mut s = s;
        let err = s.migrate().unwrap_err().to_string();
        assert!(err.contains("newer Petrel"), "{err}");
    }

    #[test]
    fn migrating_a_file_makes_a_backup_first() {
        // A v0 database: one that exists but has no schema at all. The first step is v1, so the backup is made
        // only when the file already had a version; simulate that by writing meta at v1 and asking for v1 → no
        // step. Real coverage of a step comes with v2; here we exercise `backup_before_migrate` directly.
        let dir = std::env::temp_dir().join(format!("petrel-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("petrel.db");
        let s = Store::open(&path).unwrap();
        s.new_draft("Keep me").unwrap();
        let backup = s.backup_before_migrate(1).unwrap().unwrap();
        assert!(backup.exists());
        let copy = Connection::open(&backup).unwrap();
        let n: i64 =
            copy.query_row("SELECT COUNT(*) FROM drafts WHERE title = 'Keep me'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        for _ in 0..BACKUPS_KEPT + 2 {
            std::thread::sleep(std::time::Duration::from_millis(1050));
            s.backup_before_migrate(1).unwrap();
        }
        let files: Vec<_> =
            std::fs::read_dir(dir.join("backups")).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(files.len(), BACKUPS_KEPT, "{files:?}");
        assert!(files.iter().all(|f| f.to_string_lossy().ends_with(".db")), "one file per backup: {files:?}");
        drop(s);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn new_save_open_round_trip() {
        let s = store();
        let d = s.new_draft("# Title\n\nBody text").unwrap();
        assert_eq!(d.title, "Title");
        assert_eq!(d.folder, Folder::Inbox);
        assert_eq!(d.version_count, 0);
        assert!(s.save(d.id, "# Changed\n\nMore", 9).unwrap());
        let d2 = s.draft(d.id).unwrap();
        assert_eq!(d2.content, "# Changed\n\nMore");
        assert_eq!(d2.title, "Changed");
        assert_eq!(d2.cursor, 9);
        assert_eq!(d2.version_count, 1, "first save snapshots the original text");
        assert!(!s.save(9999, "x", 0).unwrap());
    }

    #[test]
    fn list_pages_by_keyset() {
        let mut s = store();
        let t = Arc::new(AtomicI64::new(1_000_000));
        let c = t.clone();
        s.set_clock(move || c.fetch_add(1, Ordering::SeqCst));
        for i in 0..25 {
            s.new_draft(&format!("Draft {i}")).unwrap();
        }
        let p1 = s.list(Folder::Inbox, None, 10).unwrap();
        assert_eq!(p1.rows.len(), 10);
        assert_eq!(p1.rows[0].title, "Draft 24");
        let p2 = s.list(Folder::Inbox, p1.next, 10).unwrap();
        assert_eq!(p2.rows[0].title, "Draft 14");
        let p3 = s.list(Folder::Inbox, p2.next, 10).unwrap();
        assert_eq!(p3.rows.len(), 5);
        assert!(p3.next.is_none());
    }

    #[test]
    fn folders_and_flags() {
        let s = store();
        let d = s.new_draft("one").unwrap();
        s.set_folder(d.id, Folder::Archive).unwrap();
        assert_eq!(s.count(Folder::Inbox).unwrap(), 0);
        assert_eq!(s.count(Folder::Archive).unwrap(), 1);
        s.set_flagged(d.id, true).unwrap();
        assert!(s.draft(d.id).unwrap().flagged);
    }

    #[test]
    fn search_is_safe_and_matches_prefixes() {
        let s = store();
        s.new_draft("Groceries\nmilk, eggs, bread").unwrap();
        s.new_draft("Café plans\nmeet at the café").unwrap();
        let t = s.new_draft("Trashed\nmilk").unwrap();
        s.set_folder(t.id, Folder::Trash).unwrap();
        assert_eq!(s.search("mil", 10).unwrap().len(), 1, "trash is excluded, prefix matches");
        assert_eq!(s.search("cafe", 10).unwrap().len(), 1, "diacritics are folded");
        assert!(s.search("milk\" OR *", 10).is_ok(), "FTS syntax in input cannot error");
        assert!(s.search("   ", 10).unwrap().is_empty());
        let hit = &s.search("eggs", 10).unwrap()[0];
        assert_eq!(hit.snippet, "Groceries milk, \u{1}eggs,\u{2} bread");
    }

    #[test]
    fn search_is_newest_first_and_exact_under_the_window() {
        let mut s = store();
        let t = Arc::new(AtomicI64::new(1_000_000));
        let c = t.clone();
        s.set_clock(move || c.fetch_add(1, Ordering::SeqCst));
        let ids: Vec<i64> = (0..10).map(|i| s.new_draft(&format!("note {i} common")).unwrap().id).collect();
        s.save(ids[2], "note 2 common edited", 0).unwrap(); // oldest-created but newest-modified
        let hits = s.search("common", 3).unwrap();
        assert_eq!(hits.iter().map(|h| h.id).collect::<Vec<_>>(), vec![ids[2], ids[9], ids[8]]);
    }

    #[test]
    fn snippet_windows_around_the_first_match() {
        let terms = vec!["seven".to_string()];
        let text = (0..30)
            .map(|i| ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][i % 10])
            .collect::<Vec<_>>()
            .join(" ");
        let snip = snippet(&text, &terms);
        assert!(snip.starts_with("…three four five six \u{1}seven\u{2} eight"), "{snip}");
        assert!(snip.ends_with('…'));
        assert_eq!(snippet("short text", &["nothing".into()]), "short text");
        assert_eq!(snippet("", &terms), "");
    }

    #[test]
    fn fts_query_quotes_everything() {
        assert_eq!(fts_query("hello world"), "\"hello\" \"world\"*");
        assert_eq!(fts_query("a\"b"), "\"a\"\"b\"*");
        assert_eq!(fts_query("(x) -y"), "\"x\" \"y\"*");
        assert_eq!(fts_query("***"), "");
    }

    #[test]
    fn tags_are_normalised() {
        let mut s = store();
        let d = s.new_draft("t").unwrap();
        let tags = s.set_tags(d.id, &["Work".into(), " work ".into(), "".into(), "idea".into()]).unwrap();
        assert_eq!(tags, vec!["idea", "work"]);
        assert_eq!(s.draft(d.id).unwrap().tags, vec!["idea", "work"]);
        s.set_tags(d.id, &[]).unwrap();
        assert!(s.tags_of(d.id).unwrap().is_empty());
        assert_eq!(s.sweep().unwrap().tags_removed, 2);
    }

    #[test]
    fn versions_are_taken_every_five_minutes_and_restore_keeps_the_present() {
        let (mut s, now) = store_with_clock(10_000_000);
        let d = s.new_draft("v1").unwrap();
        s.save(d.id, "v2", 0).unwrap(); // snapshots v1
        now.fetch_add(1000, Ordering::SeqCst);
        s.save(d.id, "v3", 0).unwrap(); // too soon, no snapshot
        assert_eq!(s.versions(d.id).unwrap().len(), 1);
        now.fetch_add(VERSION_INTERVAL_MS, Ordering::SeqCst);
        s.save(d.id, "v4", 0).unwrap(); // snapshots v3
        let versions = s.versions(d.id).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(s.version_content(versions[1].id).unwrap(), "v1");
        let restored = s.restore(versions[1].id).unwrap();
        assert_eq!(restored.content, "v1");
        let after = s.versions(d.id).unwrap();
        assert_eq!(after.len(), 3);
        assert_eq!(after[0].reason, "restore");
        assert_eq!(s.version_content(after[0].id).unwrap(), "v4");
    }

    #[test]
    fn sweep_tombstones_old_trash_and_purges_old_tombstones() {
        let (mut s, now) = store_with_clock(1_700_000_000_000);
        let day = 24 * 60 * 60 * 1000;
        let d = s.new_draft("bin me").unwrap();
        s.set_folder(d.id, Folder::Trash).unwrap();
        now.fetch_add(29 * day, Ordering::SeqCst);
        assert_eq!(s.sweep().unwrap().tombstoned, 0);
        now.fetch_add(2 * day, Ordering::SeqCst);
        assert_eq!(s.sweep().unwrap().tombstoned, 1);
        assert!(s.draft(d.id).is_err(), "a tombstone is not a draft");
        assert_eq!(s.count(Folder::Trash).unwrap(), 0);
        let uuid_kept: Option<String> = s
            .conn
            .query_row("SELECT uuid FROM drafts WHERE id = ?1", params![d.id], |r| r.get(0))
            .optional()
            .unwrap();
        assert_eq!(uuid_kept.as_deref(), Some(d.uuid.as_str()));
        assert!(s.search("bin", 10).unwrap().is_empty(), "tombstones are out of the index");
        now.fetch_add(91 * day, Ordering::SeqCst);
        assert_eq!(s.sweep().unwrap().purged, 1);
    }

    #[test]
    fn empty_trash_is_immediate() {
        let mut s = store();
        let d = s.new_draft("gone").unwrap();
        s.set_folder(d.id, Folder::Trash).unwrap();
        assert_eq!(s.empty_trash().unwrap(), 1);
        assert_eq!(s.count(Folder::Trash).unwrap(), 0);
    }

    #[test]
    fn settings_round_trip() {
        let s = store();
        assert!(s.setting("x").unwrap().is_none());
        s.set_setting("x", "1").unwrap();
        s.set_setting("x", "2").unwrap();
        assert_eq!(s.setting("x").unwrap().as_deref(), Some("2"));
    }
}
