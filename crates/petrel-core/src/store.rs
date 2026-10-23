//! The SQLite store. Schema v1 is `SCHEMA`; later versions are numbered steps in `migrate()`, forward-only,
//! each in its own transaction. Before the first step runs on a file-backed database, the file is copied to
//! `backups/` (SQLite backup API), so a migration can never be the thing that loses someone's text.
//!
//! Everything here is synchronous behind one connection; callers hold the `Store` in a `Mutex`. Writes are
//! tiny (autosave is one UPDATE), so this has not needed a pool. The one other connection is the checkpointer's
//! (`Checkpointer`), which copies the WAL into the database file off the write path. See
//! `docs/research/data-model.md`.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::types::{ToSql, Value};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};

pub use crate::query::{fts_query, snippet};
use crate::query::{parse_query, search_terms};
use crate::retention::{self, Retention, VersionAge, DAY_MS, HOUR_MS};
use crate::title;

/// The schema version this build writes. A database with a higher `meta.schema_version` is refused.
pub const SCHEMA_VERSION: i64 = 4;

/// How many backups `backup_before_migrate` keeps.
const BACKUPS_KEPT: usize = 5;

/// A new `edit` version is taken when the newest one is older than this.
pub const VERSION_INTERVAL_MS: i64 = 5 * 60 * 1000;

/// How many of the newest matches a search considers; see `Store::search`.
pub const SEARCH_WINDOW: usize = 400;

/// The most rows one list page may ask for.
pub const LIST_MAX: usize = 500;

/// A tag filter matching at most this many drafts is resolved to a set of ids first and the list sorts that
/// set; a broader tag is checked row by row while walking the sort index, where matches are dense enough that a
/// page fills quickly. Free text is always a set: the newest this-many matches, like `search` (package 01
/// Decisions).
pub const CANDIDATES_MAX: usize = 2_000;

/// How many batch changes can be undone.
const UNDO_KEPT: usize = 50;

/// How often the checkpointer copies the WAL into the database file. This is also about the most a power cut can
/// take under `synchronous = NORMAL` (an app crash loses nothing); SQLite's default was 1,000 pages of writes.
const CHECKPOINT_EVERY: Duration = Duration::from_secs(2);

/// The WAL size at which a write checkpoints inline after all, if the checkpointer has fallen behind or is not
/// running (~16 MB).
const WAL_CAP_PAGES: i64 = 4_000;

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

/// v2: the list can be sorted by title without sorting a whole folder.
const SCHEMA_V2: &str = r#"
CREATE INDEX drafts_title ON drafts (folder, title COLLATE NOCASE, id) WHERE deleted_at IS NULL;
"#;

/// v3: counts kept by triggers, so the folder badges and the tag list never count rows, and the title, created
/// and accessed indexes lose their folder column. With the folder first, moving a draft moved its entry in each
/// of those indexes to another part of the tree: archiving 50 scattered drafts wrote 330 pages, and the undo as
/// many (19 ms on Windows). Without it a move touches the row and the `drafts_list` entry, ~1 page a draft. Those
/// three sorts now check the folder per row (`Store::scan`), or sort a small folder whole from `drafts_list`,
/// which carries their keys so that sort never reads the table (0.2 ms for 1,000 drafts against 1.5 ms). Its
/// entry is rewritten on every save and move anyway, so the extra columns cost bytes, not writes.
///
/// The counts Only live drafts are
/// counted (`deleted_at IS NULL`). A row whose count reached 0 stays; readers skip it. `draft_tags` rows are only
/// ever inserted or deleted, never updated. A live draft deleted outright (nothing does that today) is taken out
/// of the counts in a BEFORE trigger, while its tags can still be read.
const SCHEMA_V3: &str = r#"
DROP INDEX drafts_list;
DROP INDEX drafts_title;
DROP INDEX drafts_created;
DROP INDEX drafts_accessed;
CREATE INDEX drafts_list     ON drafts (folder, modified_at DESC, id DESC, title COLLATE NOCASE, created_at, accessed_at)
  WHERE deleted_at IS NULL;
CREATE INDEX drafts_title    ON drafts (title COLLATE NOCASE, id) WHERE deleted_at IS NULL;
CREATE INDEX drafts_created  ON drafts (created_at DESC, id DESC)  WHERE deleted_at IS NULL;
CREATE INDEX drafts_accessed ON drafts (accessed_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE folder_counts (folder INTEGER PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE tag_counts (
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  folder INTEGER NOT NULL,
  n      INTEGER NOT NULL,
  PRIMARY KEY (tag_id, folder)
) WITHOUT ROWID;

INSERT INTO folder_counts (folder, n)
  SELECT folder, COUNT(*) FROM drafts WHERE deleted_at IS NULL GROUP BY folder;
INSERT INTO tag_counts (tag_id, folder, n)
  SELECT dt.tag_id, d.folder, COUNT(*) FROM draft_tags dt JOIN drafts d ON d.id = dt.draft_id
  WHERE d.deleted_at IS NULL GROUP BY dt.tag_id, d.folder;

CREATE TRIGGER counts_draft_ai AFTER INSERT ON drafts WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO folder_counts (folder, n) VALUES (new.folder, 1) ON CONFLICT (folder) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER counts_draft_au AFTER UPDATE OF folder, deleted_at ON drafts
  WHEN old.folder IS NOT new.folder OR (old.deleted_at IS NULL) IS NOT (new.deleted_at IS NULL) BEGIN
  UPDATE folder_counts SET n = n - 1 WHERE folder = old.folder AND old.deleted_at IS NULL;
  INSERT INTO folder_counts (folder, n) SELECT new.folder, 1 WHERE new.deleted_at IS NULL
    ON CONFLICT (folder) DO UPDATE SET n = n + 1;
  UPDATE tag_counts SET n = n - 1 WHERE folder = old.folder AND old.deleted_at IS NULL
    AND tag_id IN (SELECT tag_id FROM draft_tags WHERE draft_id = old.id);
  INSERT INTO tag_counts (tag_id, folder, n)
    SELECT tag_id, new.folder, 1 FROM draft_tags WHERE draft_id = new.id AND new.deleted_at IS NULL
    ON CONFLICT (tag_id, folder) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER counts_draft_bd BEFORE DELETE ON drafts WHEN old.deleted_at IS NULL BEGIN
  UPDATE folder_counts SET n = n - 1 WHERE folder = old.folder;
  UPDATE tag_counts SET n = n - 1 WHERE folder = old.folder
    AND tag_id IN (SELECT tag_id FROM draft_tags WHERE draft_id = old.id);
END;
CREATE TRIGGER counts_tag_ai AFTER INSERT ON draft_tags BEGIN
  INSERT INTO tag_counts (tag_id, folder, n)
    SELECT new.tag_id, folder, 1 FROM drafts WHERE id = new.draft_id AND deleted_at IS NULL
    ON CONFLICT (tag_id, folder) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER counts_tag_ad AFTER DELETE ON draft_tags BEGIN
  UPDATE tag_counts SET n = n - 1 WHERE tag_id = old.tag_id
    AND folder = (SELECT folder FROM drafts WHERE id = old.draft_id AND deleted_at IS NULL);
END;
"#;

/// v4: a batch move keeps the counts itself. The per-row folder trigger cost ~13 µs a draft, most of the time of
/// archiving 50 drafts and undoing it (5.2 ms on Windows). `move_drafts` and `undo` set `count_ctl.manual`, work
/// out the change per folder and tag in two grouped queries, and clear it before commit; a failed batch rolls the
/// flag back with everything else. Every other write still goes through the trigger.
const SCHEMA_V4: &str = r#"
CREATE TABLE count_ctl (id INTEGER PRIMARY KEY CHECK (id = 1), manual INTEGER NOT NULL);
INSERT INTO count_ctl (id, manual) VALUES (1, 0);
DROP TRIGGER counts_draft_au;
CREATE TRIGGER counts_draft_au AFTER UPDATE OF folder, deleted_at ON drafts
  WHEN (old.folder IS NOT new.folder OR (old.deleted_at IS NULL) IS NOT (new.deleted_at IS NULL))
    AND (SELECT manual FROM count_ctl WHERE id = 1) = 0 BEGIN
  UPDATE folder_counts SET n = n - 1 WHERE folder = old.folder AND old.deleted_at IS NULL;
  INSERT INTO folder_counts (folder, n) SELECT new.folder, 1 WHERE new.deleted_at IS NULL
    ON CONFLICT (folder) DO UPDATE SET n = n + 1;
  UPDATE tag_counts SET n = n - 1 WHERE folder = old.folder AND old.deleted_at IS NULL
    AND tag_id IN (SELECT tag_id FROM draft_tags WHERE draft_id = old.id);
  INSERT INTO tag_counts (tag_id, folder, n)
    SELECT tag_id, new.folder, 1 FROM draft_tags WHERE draft_id = new.id AND new.deleted_at IS NULL
    ON CONFLICT (tag_id, folder) DO UPDATE SET n = n + 1;
END;
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

/// Keyset cursor: the sort key and id of the last row seen, and whether that row was in the flagged-first
/// part of a `flagged_top` list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub key: SortKey,
    pub id: i64,
    #[serde(default)]
    pub flagged: bool,
}

/// A row's value in the sort column: a timestamp, or a title.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SortKey {
    Int(i64),
    Text(String),
}

impl SortKey {
    /// The order SQLite gives `title COLLATE NOCASE`: bytes, with ASCII letters folded.
    fn cmp_nocase(&self, other: &SortKey) -> Ordering {
        match (self, other) {
            (SortKey::Int(a), SortKey::Int(b)) => a.cmp(b),
            (SortKey::Text(a), SortKey::Text(b)) => {
                a.bytes().map(|c| c.to_ascii_lowercase()).cmp(b.bytes().map(|c| c.to_ascii_lowercase()))
            }
            (SortKey::Int(_), SortKey::Text(_)) => Ordering::Less,
            (SortKey::Text(_), SortKey::Int(_)) => Ordering::Greater,
        }
    }
}

/// What a list is ordered by. The names are the wire format and the `workspaces.sort` values.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sort {
    #[default]
    Modified,
    Created,
    Accessed,
    Title,
}

impl Sort {
    /// The column, as it appears in the matching index.
    fn column(self) -> &'static str {
        match self {
            Sort::Modified => "modified_at",
            Sort::Created => "created_at",
            Sort::Accessed => "accessed_at",
            Sort::Title => "title COLLATE NOCASE",
        }
    }
}

/// One page of the draft list. Every field has a default, so the UI sends only what it sets.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ListQuery {
    /// `None` is Inbox and Archive together ("All").
    pub folder: Option<Folder>,
    pub flagged_only: bool,
    /// The draft has every one of these tags.
    pub tags_all: Vec<String>,
    /// The draft has none of these tags.
    pub tags_none: Vec<String>,
    /// Free text, as the user typed it; quoted for FTS5 by `fts_query`.
    pub fts: String,
    pub sort: Sort,
    pub desc: bool,
    /// Flagged drafts first, each part in the sort order.
    pub flagged_top: bool,
    pub cursor: Option<Cursor>,
    pub limit: usize,
}

impl Default for ListQuery {
    fn default() -> ListQuery {
        ListQuery {
            folder: Some(Folder::Inbox),
            flagged_only: false,
            tags_all: Vec::new(),
            tags_none: Vec::new(),
            fts: String::new(),
            sort: Sort::Modified,
            desc: true,
            flagged_top: false,
            cursor: None,
            limit: 50,
        }
    }
}

impl ListQuery {
    pub fn folder(folder: Folder) -> ListQuery {
        ListQuery { folder: Some(folder), ..ListQuery::default() }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub name: String,
    pub count: i64,
}

/// Returned by a batch change; `Store::undo(token)` puts the batch back. Tokens live in memory, for the newest
/// `UNDO_KEPT` batches, and are used once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoToken {
    pub token: String,
    /// Drafts the batch changed; drafts already in the target state are not counted and not touched.
    pub count: usize,
}

/// What a batch changed, so undo can put it back.
struct UndoBatch {
    token: String,
    /// The `modified_at` the batch wrote. Undo restores the old `modified_at` only where this is still the
    /// value, so a draft edited after the batch keeps its newer time.
    at: i64,
    change: Change,
}

enum Change {
    /// `column` is `"folder"` or `"flagged"`, a compile-time name, never user input. Rows are
    /// `(id, old value, old modified_at)`.
    Column { column: &'static str, rows: Vec<(i64, i64, i64)> },
    /// `(id, old tag ids, old modified_at)`.
    Tags { rows: Vec<(i64, Vec<i64>, i64)> },
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
    /// Declared first so it stops before the main connection closes; the last connection out removes the WAL.
    _checkpointer: Option<Checkpointer>,
    pub(crate) conn: Connection,
    path: Option<PathBuf>,
    /// Milliseconds since the epoch; swapped out by tests.
    clock: Box<dyn Fn() -> i64 + Send>,
    /// Newest last.
    undo: VecDeque<UndoBatch>,
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
            undo: VecDeque::new(),
        };
        store.init()?;
        // After `init`, so the checkpointer never sees a database mid-migration.
        store.conn.pragma_update(None, "wal_autocheckpoint", WAL_CAP_PAGES)?;
        store._checkpointer = Some(Checkpointer::spawn(path)?);
        Ok(store)
    }

    /// An in-memory store for tests and the UI's fake mode.
    pub fn open_in_memory() -> Result<Store> {
        let conn = Connection::open_in_memory()?;
        let mut store = Store {
            _checkpointer: None,
            conn,
            path: None,
            clock: Box::new(system_now),
            undo: VecDeque::new(),
        };
        store.init()?;
        Ok(store)
    }

    /// Tests inject time; the UI never calls this.
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
                2 => tx.execute_batch(SCHEMA_V2)?,
                3 => tx.execute_batch(SCHEMA_V3)?,
                4 => tx.execute_batch(SCHEMA_V4)?,
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

    // ---- batches with undo -------------------------------------------------------------------------------

    /// Moves drafts to a folder. Drafts already there are left alone.
    pub fn move_drafts(&mut self, ids: &[i64], folder: Folder) -> Result<UndoToken> {
        self.batch(ids, "folder", folder as i64)
    }

    /// Flags or unflags drafts. Drafts already in that state are left alone.
    pub fn flag_drafts(&mut self, ids: &[i64], flagged: bool) -> Result<UndoToken> {
        self.batch(ids, "flagged", flagged as i64)
    }

    fn batch(&mut self, ids: &[i64], column: &'static str, value: i64) -> Result<UndoToken> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        let rows: Vec<(i64, i64, i64)> = tx
            .prepare(&format!(
                "SELECT id, {column}, modified_at FROM drafts \
                 WHERE id IN rarray(?1) AND deleted_at IS NULL AND {column} != ?2"
            ))?
            .query_map(params![id_array(ids), value], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        if column == "folder" {
            count_move(&tx, ids, value)?;
        }
        tx.execute(
            &format!(
                "UPDATE drafts SET {column} = ?2, modified_at = ?3 \
                 WHERE id IN rarray(?1) AND deleted_at IS NULL AND {column} != ?2"
            ),
            params![id_array(ids), value, now],
        )?;
        if column == "folder" {
            tx.execute("UPDATE count_ctl SET manual = 0", [])?;
        }
        tx.commit()?;
        let count = rows.len();
        Ok(self.remember(now, count, Change::Column { column, rows }))
    }

    /// Adds tags to drafts, keeping the tags they have. Drafts that already carry all of them are left alone.
    pub fn add_tags(&mut self, ids: &[i64], names: &[String]) -> Result<UndoToken> {
        let mut clean: Vec<String> = names.iter().map(|n| tag_name(n)).filter(|n| !n.is_empty()).collect();
        clean.sort();
        clean.dedup();
        let now = self.now();
        let tx = self.conn.transaction()?;
        let mut rows = Vec::new();
        {
            let mut make =
                tx.prepare("INSERT INTO tags (uuid, name) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING")?;
            let mut tag_ids = Vec::new();
            for name in &clean {
                make.execute(params![uuid::Uuid::new_v4().to_string(), name])?;
                tag_ids.push(tx.query_row("SELECT id FROM tags WHERE name = ?1", params![name], |r| {
                    r.get::<_, i64>(0)
                })?);
            }
            let mut current = tx.prepare(
                "SELECT d.modified_at, (SELECT group_concat(tag_id) FROM draft_tags WHERE draft_id = d.id) \
                 FROM drafts d WHERE d.id = ?1 AND d.deleted_at IS NULL",
            )?;
            let mut link =
                tx.prepare("INSERT OR IGNORE INTO draft_tags (draft_id, tag_id) VALUES (?1, ?2)")?;
            let mut touch = tx.prepare("UPDATE drafts SET modified_at = ?2 WHERE id = ?1")?;
            for &id in ids {
                let Some((modified, have)): Option<(i64, Option<String>)> =
                    current.query_row(params![id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?
                else {
                    continue;
                };
                let have: Vec<i64> =
                    have.unwrap_or_default().split(',').filter_map(|t| t.parse().ok()).collect();
                if tag_ids.iter().all(|t| have.contains(t)) {
                    continue;
                }
                for t in &tag_ids {
                    link.execute(params![id, t])?;
                }
                touch.execute(params![id, now])?;
                rows.push((id, have, modified));
            }
        }
        tx.commit()?;
        let count = rows.len();
        Ok(self.remember(now, count, Change::Tags { rows }))
    }

    fn remember(&mut self, at: i64, count: usize, change: Change) -> UndoToken {
        let token = UndoToken { token: uuid::Uuid::new_v4().to_string(), count };
        self.undo.push_back(UndoBatch { token: token.token.clone(), at, change });
        while self.undo.len() > UNDO_KEPT {
            self.undo.pop_front();
        }
        token
    }

    /// Puts a batch back. Returns how many drafts changed. A token works once; an unknown one (too old, already
    /// used, or from before a restart) is an error the UI can show as "nothing to undo".
    pub fn undo(&mut self, token: &str) -> Result<usize> {
        let Some(pos) = self.undo.iter().position(|b| b.token == token) else {
            bail!("nothing to undo: that change is too old or was already undone");
        };
        let batch = self.undo.remove(pos).expect("position is in range");
        let tx = self.conn.transaction()?;
        let mut n = 0;
        let restore_time =
            "UPDATE drafts SET modified_at = CASE WHEN modified_at = ?3 THEN ?2 ELSE modified_at END \
                            WHERE id = ?1 AND deleted_at IS NULL";
        match &batch.change {
            Change::Column { column, rows } => {
                if *column == "folder" {
                    let mut by_folder: HashMap<i64, Vec<i64>> = HashMap::new();
                    for (id, old, _) in rows {
                        by_folder.entry(*old).or_default().push(*id);
                    }
                    for (folder, ids) in &by_folder {
                        count_move(&tx, ids, *folder)?;
                    }
                }
                let mut stmt = tx.prepare(&format!(
                    "UPDATE drafts SET {column} = ?2, \
                     modified_at = CASE WHEN modified_at = ?4 THEN ?3 ELSE modified_at END \
                     WHERE id = ?1 AND deleted_at IS NULL"
                ))?;
                for (id, old, modified) in rows {
                    n += stmt.execute(params![id, old, modified, batch.at])?;
                }
                drop(stmt);
                tx.execute("UPDATE count_ctl SET manual = 0", [])?;
            }
            Change::Tags { rows } => {
                let mut clear = tx.prepare("DELETE FROM draft_tags WHERE draft_id = ?1")?;
                // A tag removed by `sweep()` since the batch stays gone; the rest come back.
                let mut link = tx.prepare(
                    "INSERT OR IGNORE INTO draft_tags (draft_id, tag_id) SELECT ?1, id FROM tags WHERE id = ?2",
                )?;
                let mut time = tx.prepare(restore_time)?;
                for (id, old, modified) in rows {
                    let changed = time.execute(params![id, modified, batch.at])?;
                    if changed == 0 {
                        continue; // tombstoned since
                    }
                    clear.execute(params![id])?;
                    for t in old {
                        link.execute(params![id, t])?;
                    }
                    n += 1;
                }
            }
        }
        tx.commit()?;
        Ok(n)
    }

    // ---- lists and search --------------------------------------------------------------------------------

    /// One page of the draft list, by keyset on `(sort key, id)`; never OFFSET, so page 200 costs what page 1
    /// does. "All" (no folder) merges the Inbox and Archive scans; `flagged_top` is the flagged scan followed by
    /// the unflagged one, not `ORDER BY flagged`, so each part still walks an index.
    pub fn list(&self, q: &ListQuery) -> Result<ListPage> {
        let limit = q.limit.clamp(1, LIST_MAX);
        let empty = ListPage { rows: Vec::new(), next: None };
        let Some(filter) = self.filter(q)? else { return Ok(empty) };
        if filter.candidates.as_ref().is_some_and(|c| c.is_empty()) {
            return Ok(empty);
        }
        if let Some(c) = &q.cursor {
            let text = matches!(c.key, SortKey::Text(_));
            if text != (q.sort == Sort::Title) {
                bail!("the cursor is from a list with another sort");
            }
        }
        let folders: &[Folder] = match &q.folder {
            Some(f) => std::slice::from_ref(f),
            None => &[Folder::Inbox, Folder::Archive],
        };
        let split = q.flagged_top && !q.flagged_only;
        let segments: &[Option<bool>] = if q.flagged_only {
            &[Some(true)]
        } else if split {
            &[Some(true), Some(false)]
        } else {
            &[None]
        };
        // A flagged-top cursor says which part it stopped in.
        let first = usize::from(split && q.cursor.as_ref().is_some_and(|c| !c.flagged));
        let mut rows: Vec<(DraftSummary, SortKey, bool)> = Vec::new();
        for (i, &flagged) in segments.iter().enumerate().skip(first) {
            let after = if i == first { q.cursor.as_ref() } else { None };
            let want = limit + 1 - rows.len();
            for (row, key) in self.scan(&filter, folders, flagged, q.sort, q.desc, after, want)? {
                rows.push((row, key, split && flagged == Some(true)));
            }
            if rows.len() > limit {
                break;
            }
        }
        let next = if rows.len() > limit {
            rows.truncate(limit);
            rows.last().map(|(r, key, flagged)| Cursor { key: key.clone(), id: r.id, flagged: *flagged })
        } else {
            None
        };
        Ok(ListPage { rows: rows.into_iter().map(|(r, _, _)| r).collect(), next })
    }

    /// Resolves names and text to ids once per list call. `None` means nothing can match (an unknown tag).
    fn filter(&self, q: &ListQuery) -> Result<Option<Filter>> {
        let mut f = Filter::default();
        let mut sets: Vec<Vec<i64>> = Vec::new();
        let mut tagged = self.conn.prepare_cached(
            "SELECT draft_id FROM draft_tags WHERE tag_id = ?1 ORDER BY draft_id DESC LIMIT ?2",
        )?;
        let mut live =
            self.conn.prepare_cached("SELECT IFNULL(SUM(n), 0) FROM tag_counts WHERE tag_id = ?1")?;
        let mut walk: Vec<(i64, i64)> = Vec::new();
        for name in &q.tags_all {
            let name = tag_name(name);
            if name.is_empty() {
                continue;
            }
            let Some(tag) = self.tag_id(&name)? else { return Ok(None) };
            // The live count is a lower bound on the tag's rows (tombstones keep theirs), so a tag over the
            // limit is known broad without fetching its ids.
            let n: i64 = live.query_row(params![tag], |r| r.get(0))?;
            if n <= CANDIDATES_MAX as i64 {
                let ids: Vec<i64> = tagged
                    .query_map(params![tag, CANDIDATES_MAX as i64 + 1], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                if ids.len() <= CANDIDATES_MAX {
                    sets.push(ids);
                    continue;
                }
            }
            walk.push((n, tag));
        }
        // The rarest tag first: most rows walked fail its check, and the next one is never run.
        walk.sort();
        f.walk_tags = walk.into_iter().map(|(_, tag)| tag).collect();
        for name in &q.tags_none {
            if let Some(tag) = self.tag_id(&tag_name(name))? {
                f.none_tags.push(tag);
            }
        }
        let fts = fts_query(&q.fts);
        if !fts.is_empty() {
            let ids: Vec<i64> = self
                .conn
                .prepare_cached(
                    "SELECT rowid FROM drafts_fts WHERE drafts_fts MATCH ?1 ORDER BY rowid DESC LIMIT ?2",
                )?
                .query_map(params![fts, CANDIDATES_MAX as i64 + 1], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            // Checking FTS5 row by row costs a query parse per row (12 ms for a common word at 5k drafts),
            // so a broad text filter keeps the newest `CANDIDATES_MAX` matches instead, as `search` does.
            let mut ids = ids;
            ids.truncate(CANDIDATES_MAX);
            sets.push(ids);
        }
        // Flagged-only with another filter: the flagged drafts are an index-only read (`drafts_flagged`), and
        // adding them to the intersection usually leaves a set small enough to fetch by id. Walking the sort
        // index instead tests every row of a folder when few of the set are flagged (10 ms on Windows).
        if q.flagged_only && !sets.is_empty() {
            let ids: Vec<i64> = self
                .conn
                .prepare_cached("SELECT id FROM drafts WHERE flagged = 1 AND deleted_at IS NULL")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            sets.push(ids);
        }
        sets.sort_by_key(Vec::len);
        let mut sets = sets.into_iter();
        if let Some(first) = sets.next() {
            let mut keep: HashSet<i64> = first.into_iter().collect();
            for other in sets {
                let other: HashSet<i64> = other.into_iter().collect();
                keep.retain(|id| other.contains(id));
            }
            let ids: Vec<i64> = keep.into_iter().collect();
            // Looking each id up and sorting costs ~2 µs an id; walking the sort index and testing each row
            // against the set costs ~0.08 µs a row and stops after a page, about `limit × drafts / ids` rows. So
            // only a small set is fetched by id (measured at 50k: a 50-draft tag 0.02 ms by id against 2.7 ms
            // walked; a 660-draft set 1.4 ms by id against 0.25 ms walked).
            let drafts: i64 =
                self.conn.query_row("SELECT IFNULL(MAX(id), 0) FROM drafts", [], |r| r.get(0))?;
            let n = ids.len() as i64;
            f.by_id = n * n * 25 < (q.limit.clamp(1, LIST_MAX) as i64 + 1) * drafts;
            f.candidates = Some(ids);
        }
        Ok(Some(f))
    }

    /// Up to `want` rows after `after`, in order, from each folder's index scan, merged.
    #[allow(clippy::too_many_arguments)]
    fn scan(
        &self,
        f: &Filter,
        folders: &[Folder],
        flagged: Option<bool>,
        sort: Sort,
        desc: bool,
        after: Option<&Cursor>,
        want: usize,
    ) -> Result<Vec<(DraftSummary, SortKey)>> {
        let col = sort.column();
        let (cmp, dir) = if desc { ("<", "DESC") } else { (">", "ASC") };
        let mut args: Vec<Box<dyn ToSql>> = vec![Box::new(0i64)]; // ?1 is the folder, set per scan
        let mut arg = |v: Box<dyn ToSql>| {
            args.push(v);
            format!("?{}", args.len())
        };
        // Flagged drafts newest-modified first can walk `drafts_flagged` and check the folder per row; anything
        // else walks the sort index and checks the flag per row (`+` keeps the planner off the flagged index).
        let by_flag = flagged == Some(true) && sort == Sort::Modified && f.candidates.is_none();
        // `+` on the folder and the order key makes SQLite look a small id set up and sort it, instead of walking
        // a folder's index and testing each row against the set.
        let by_id = f.by_id;
        // Only `drafts_list` (modified) leads with the folder (v3). The other sorts walk their index and check
        // the folder per row in the table, ~1.6 µs a row for about `want × drafts / folder size` rows; a small
        // folder is read whole from `drafts_list`, which carries the sort keys, and sorted, ~0.2 µs a draft.
        let mut sort_whole = false;
        let mut walk_all = false;
        if sort != Sort::Modified && !by_id {
            let sizes = folders.iter().map(|f| self.count(*f)).collect::<Result<Vec<i64>>>()?;
            let total: i64 = [Folder::Inbox, Folder::Archive, Folder::Trash]
                .iter()
                .map(|f| self.count(*f))
                .sum::<Result<i64>>()?;
            sort_whole = sizes.iter().all(|n| n * n <= 8 * want as i64 * total);
            walk_all = !sort_whole;
        }
        let mut sql = format!(
            "SELECT id, uuid, title, preview, folder, flagged, modified_at, {col} FROM drafts \
             WHERE {}folder = ?1 AND deleted_at IS NULL",
            if by_flag || by_id || walk_all { "+" } else { "" }
        );
        match flagged {
            Some(true) if by_flag => sql += " AND flagged = 1",
            Some(flagged) => sql += &format!(" AND +flagged = {}", flagged as i64),
            None => {}
        }
        if let Some(ids) = &f.candidates {
            sql += &format!(" AND id IN rarray({})", arg(Box::new(id_array(ids))));
        }
        for tag in &f.walk_tags {
            sql += &format!(
                " AND EXISTS (SELECT 1 FROM draft_tags WHERE draft_id = drafts.id AND tag_id = {})",
                arg(Box::new(*tag))
            );
        }
        if !f.none_tags.is_empty() {
            sql += &format!(
                " AND NOT EXISTS (SELECT 1 FROM draft_tags WHERE draft_id = drafts.id AND tag_id IN rarray({}))",
                arg(Box::new(id_array(&f.none_tags)))
            );
        }
        if let Some(c) = after {
            let key: Box<dyn ToSql> = match &c.key {
                SortKey::Int(n) => Box::new(*n),
                SortKey::Text(s) => Box::new(s.clone()),
            };
            let key = arg(key);
            // The plain bound lets SQLite seek the index; the row value alone does not under a collation.
            sql += &format!(" AND {col} {cmp}= {key} AND ({col}, id) {cmp} ({key}, {})", arg(Box::new(c.id)));
        }
        let order = if by_id || sort_whole { format!("+{col}") } else { col.to_string() };
        sql += &format!(" ORDER BY {order} {dir}, id {dir} LIMIT {}", arg(Box::new(want as i64)));

        let mut stmt = self.conn.prepare_cached(&sql)?;
        let mut out: Vec<(DraftSummary, SortKey)> = Vec::new();
        for folder in folders {
            args[0] = Box::new(*folder as i64);
            let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
                let key =
                    if sort == Sort::Title { SortKey::Text(r.get(7)?) } else { SortKey::Int(r.get(7)?) };
                Ok((summary(r)?, key))
            })?;
            for row in rows {
                out.push(row?);
            }
        }
        if folders.len() > 1 {
            out.sort_by(|(a, ka), (b, kb)| {
                let o = ka.cmp_nocase(kb).then(a.id.cmp(&b.id));
                if desc {
                    o.reverse()
                } else {
                    o
                }
            });
            out.truncate(want);
        }
        Ok(out)
    }

    /// The search box. Filters (`tag:`, `-tag:`, `is:flagged`, `in:`) are parsed in Rust; the rest is free text.
    ///
    /// Free text alone takes the fast path: FTS5 walks a term's matches in descending rowid order and stops
    /// early, which costs microseconds however common the word is, while ranking by bm25 costs ~0.5 µs per
    /// match and reaches 20 ms for a word in most drafts. So Petrel takes the `SEARCH_WINDOW` most recently
    /// created matches and orders those by `modified_at`. For a term in fewer than `SEARCH_WINDOW` drafts this
    /// is exact; for a more common term it is "the newest drafts with that word", which is what a person typing
    /// a common word gets anyway and can narrow with a second word. With filters, search is a `list` query
    /// (exact, newest modified first). Snippets are made in Rust from the content, which is cheaper than
    /// FTS5's `snippet()` by rowid.
    pub fn search(&self, input: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let p = parse_query(input);
        if p.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<i64> = if p.text_only() {
            let mut newest = self.conn.prepare_cached(
                "SELECT rowid FROM drafts_fts WHERE drafts_fts MATCH ?1 ORDER BY rowid DESC LIMIT ?2",
            )?;
            let window: Vec<i64> = newest
                .query_map(params![fts_query(&p.text), SEARCH_WINDOW as i64], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut stmt = self.conn.prepare_cached(
                "SELECT id FROM drafts WHERE id IN rarray(?1) AND deleted_at IS NULL AND folder != 2 \
                 ORDER BY modified_at DESC, id DESC LIMIT ?2",
            )?;
            let ids = stmt
                .query_map(params![id_array(&window), limit as i64], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            ids
        } else {
            let q = ListQuery {
                folder: p.folder,
                flagged_only: p.flagged,
                tags_all: p.tags_all.clone(),
                tags_none: p.tags_none.clone(),
                fts: p.text.clone(),
                limit,
                ..ListQuery::default()
            };
            self.list(&q)?.rows.into_iter().map(|r| r.id).collect()
        };
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let terms = search_terms(&p.text);
        let mut stmt = self
            .conn
            .prepare_cached("SELECT id, title, content, modified_at FROM drafts WHERE id IN rarray(?1)")?;
        let mut by_id: HashMap<i64, SearchHit> = stmt
            .query_map(params![id_array(&ids)], |r| {
                let content: String = r.get(2)?;
                let snippet =
                    if terms.is_empty() { title::preview(&content) } else { snippet(&content, &terms) };
                Ok((
                    r.get(0)?,
                    SearchHit { id: r.get(0)?, title: r.get(1)?, snippet, modified_at: r.get(3)? },
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
    }

    /// Live drafts in a folder, from `folder_counts` (schema v3).
    pub fn count(&self, folder: Folder) -> Result<i64> {
        Ok(self
            .conn
            .prepare_cached("SELECT n FROM folder_counts WHERE folder = ?1")?
            .query_row(params![folder as i64], |r| r.get(0))
            .optional()?
            .unwrap_or(0))
    }

    // ---- tags --------------------------------------------------------------------------------------------

    pub fn tags_of(&self, id: i64) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT t.name FROM tags t JOIN draft_tags dt ON dt.tag_id = t.id WHERE dt.draft_id = ?1 ORDER BY t.name",
        )?;
        let tags = stmt.query_map(params![id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(tags)
    }

    /// Replaces a draft's tags. Names are trimmed and lower-cased; empty and duplicate names are dropped. Tags
    /// nobody uses any more stay until `sweep()`, so an undo or a quick re-tag keeps the tag's identity.
    pub fn set_tags(&mut self, id: i64, names: &[String]) -> Result<Vec<String>> {
        let mut clean: Vec<String> = names.iter().map(|n| tag_name(n)).filter(|n| !n.is_empty()).collect();
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

    fn tag_id(&self, name: &str) -> Result<Option<i64>> {
        Ok(self
            .conn
            .prepare_cached("SELECT id FROM tags WHERE name = ?1")?
            .query_row(params![name], |r| r.get(0))
            .optional()?)
    }

    /// Every tag in use in a folder (`None`: Inbox and Archive) with how many drafts carry it, by name.
    pub fn tag_counts(&self, folder: Option<Folder>) -> Result<Vec<TagCount>> {
        let folders: Vec<i64> = match folder {
            Some(f) => vec![f as i64],
            None => vec![Folder::Inbox as i64, Folder::Archive as i64],
        };
        // The counts are kept by triggers (schema v3); counting rows was 31 ms at 50k here and 84 ms on Windows.
        let mut stmt = self.conn.prepare_cached(
            "SELECT t.name, SUM(c.n) AS n FROM tag_counts c JOIN tags t ON t.id = c.tag_id \
             WHERE c.folder IN rarray(?1) GROUP BY c.tag_id HAVING n > 0 ORDER BY t.name",
        )?;
        let counts = stmt
            .query_map(params![id_array(&folders)], |r| Ok(TagCount { name: r.get(0)?, count: r.get(1)? }))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(counts)
    }

    /// Renames a tag on every draft. If a tag with the new name exists, the two are merged into it. Returns how
    /// many drafts carried the old tag. `modified_at` is left alone: a rename should not reshuffle the list.
    pub fn rename_tag(&mut self, from: &str, to: &str) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let n = rename_tag_in(&tx, &tag_name(from), &tag_name(to))?;
        tx.commit()?;
        Ok(n)
    }

    /// Merges several tags into one (created if needed), in one transaction.
    pub fn merge_tags(&mut self, from: &[String], into: &str) -> Result<usize> {
        let into = tag_name(into);
        let tx = self.conn.transaction()?;
        let mut n = 0;
        for name in from {
            let name = tag_name(name);
            if name != into {
                n += rename_tag_in(&tx, &name, &into)?;
            }
        }
        tx.commit()?;
        Ok(n)
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

    /// The retention settings, with defaults and floors applied.
    pub fn retention(&self) -> Result<Retention> {
        Ok(Retention::from_settings(|k| self.setting(k).ok().flatten()))
    }

    /// Housekeeping, at start and daily. Trash older than `trash_days` becomes tombstones (content cleared,
    /// versions gone); tombstones older than `tombstone_days` are deleted; tags nobody uses are removed; versions
    /// are thinned by age tier (`retention`). The save path never deletes anything; this is the only place.
    pub fn sweep(&mut self) -> Result<SweepReport> {
        let now = self.now();
        let r = self.retention()?;
        let tx = self.conn.transaction()?;
        let tombstoned = tx.execute(
            "UPDATE drafts SET deleted_at = ?1, content = '', title = '', preview = '' \
             WHERE folder = 2 AND deleted_at IS NULL AND modified_at < ?2",
            params![now, now - r.trash_days * DAY_MS],
        )?;
        tx.execute(
            "DELETE FROM versions WHERE draft_id IN (SELECT id FROM drafts WHERE deleted_at IS NOT NULL)",
            [],
        )?;
        let purged = tx.execute(
            "DELETE FROM drafts WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
            params![now - r.tombstone_days * DAY_MS],
        )?;
        let tags = tx.execute("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM draft_tags)", [])?;
        let doomed = {
            let mut stmt = tx.prepare(
                "SELECT id, draft_id, reason, created_at FROM versions WHERE created_at < ?1 \
                 ORDER BY draft_id, created_at DESC, id DESC",
            )?;
            let rows: Vec<(i64, i64, String, i64)> = stmt
                .query_map(params![now - r.versions_all_hours * HOUR_MS], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
                .collect::<rusqlite::Result<_>>()?;
            let ages: Vec<VersionAge> = rows
                .iter()
                .map(|(id, draft_id, reason, created_at)| VersionAge {
                    id: *id,
                    draft_id: *draft_id,
                    reason,
                    created_at: *created_at,
                })
                .collect();
            retention::versions_to_thin(&ages, now, &r)
        };
        let thinned =
            tx.execute("DELETE FROM versions WHERE id IN rarray(?1)", params![id_array(&doomed)])?;
        tx.commit()?;
        Ok(SweepReport { tombstoned, purged, tags_removed: tags, versions_thinned: thinned })
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
#[serde(rename_all = "camelCase")]
pub struct SweepReport {
    pub tombstoned: usize,
    pub purged: usize,
    pub tags_removed: usize,
    pub versions_thinned: usize,
}

/// A list's filters, resolved to ids.
#[derive(Default)]
struct Filter {
    /// Small filters intersected into one id set; `None` when there is none.
    candidates: Option<Vec<i64>>,
    /// The set is small enough to fetch by id rather than walk the sort index (`Store::filter`).
    by_id: bool,
    /// Broad tags, checked per row.
    walk_tags: Vec<i64>,
    none_tags: Vec<i64>,
}

/// Moves the counts of the live drafts in `ids` that are not already in `folder` to `folder`, and turns the
/// per-row trigger off (`count_ctl.manual`, schema v4) for the UPDATE that follows. The caller clears the flag
/// before commit.
fn count_move(tx: &Transaction, ids: &[i64], folder: i64) -> Result<()> {
    tx.execute("UPDATE count_ctl SET manual = 1", [])?;
    let moving = "FROM drafts d WHERE d.id IN rarray(?1) AND d.deleted_at IS NULL AND d.folder != ?2";
    let folders: Vec<(i64, i64)> = tx
        .prepare_cached(&format!("SELECT d.folder, COUNT(*) {moving} GROUP BY d.folder"))?
        .query_map(params![id_array(ids), folder], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let tags: Vec<(i64, i64, i64)> = tx
        .prepare_cached(&format!(
            "SELECT dt.tag_id, d.folder, COUNT(*) {} GROUP BY dt.tag_id, d.folder",
            moving.replace("FROM drafts d", "FROM drafts d JOIN draft_tags dt ON dt.draft_id = d.id")
        ))?
        .query_map(params![id_array(ids), folder], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out_folder = tx.prepare_cached("UPDATE folder_counts SET n = n - ?2 WHERE folder = ?1")?;
    let mut in_folder = tx.prepare_cached(
        "INSERT INTO folder_counts (folder, n) VALUES (?1, ?2) ON CONFLICT (folder) DO UPDATE SET n = n + ?2",
    )?;
    for (from, n) in &folders {
        out_folder.execute(params![from, n])?;
        in_folder.execute(params![folder, n])?;
    }
    let mut out_tag =
        tx.prepare_cached("UPDATE tag_counts SET n = n - ?3 WHERE tag_id = ?1 AND folder = ?2")?;
    let mut in_tag = tx.prepare_cached(
        "INSERT INTO tag_counts (tag_id, folder, n) VALUES (?1, ?2, ?3) \
         ON CONFLICT (tag_id, folder) DO UPDATE SET n = n + ?3",
    )?;
    for (tag, from, n) in &tags {
        out_tag.execute(params![tag, from, n])?;
        in_tag.execute(params![tag, folder, n])?;
    }
    Ok(())
}

/// Copies the WAL into the database file every `CHECKPOINT_EVERY` on a thread and connection of its own. With
/// SQLite's default, the write that crosses 1,000 WAL pages does the copy and the fsyncs itself; on Windows that
/// write took a second (package 01 Results). A PASSIVE checkpoint takes no lock a writer needs, so the store's
/// writes never wait for it, and it does nothing when the WAL has nothing new.
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

fn id_array(ids: &[i64]) -> rusqlite::vtab::array::Array {
    Rc::new(ids.iter().copied().map(Value::from).collect())
}

/// How a tag name is stored: trimmed, lower-case.
fn tag_name(name: &str) -> String {
    name.trim().to_lowercase()
}

fn rename_tag_in(tx: &Transaction, from: &str, to: &str) -> Result<usize> {
    if to.is_empty() {
        bail!("a tag needs a name");
    }
    let Some(from_id): Option<i64> =
        tx.query_row("SELECT id FROM tags WHERE name = ?1", params![from], |r| r.get(0)).optional()?
    else {
        bail!("there is no tag named {from}");
    };
    let n: i64 =
        tx.query_row("SELECT COUNT(*) FROM draft_tags WHERE tag_id = ?1", params![from_id], |r| r.get(0))?;
    if from == to {
        return Ok(n as usize);
    }
    let to_id: Option<i64> =
        tx.query_row("SELECT id FROM tags WHERE name = ?1", params![to], |r| r.get(0)).optional()?;
    match to_id {
        None => {
            tx.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![from_id, to])?;
        }
        Some(to_id) => {
            tx.execute(
                "INSERT OR IGNORE INTO draft_tags (draft_id, tag_id) SELECT draft_id, ?2 FROM draft_tags WHERE tag_id = ?1",
                params![from_id, to_id],
            )?;
            tx.execute("DELETE FROM tags WHERE id = ?1", params![from_id])?;
        }
    }
    Ok(n as usize)
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
        drop(copy); // or Windows keeps this backup alive and the prune can't remove it
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

    /// A store whose clock moves one millisecond per call, so every timestamp differs.
    fn ticking_store() -> (Store, Arc<AtomicI64>) {
        let mut s = store();
        let t = Arc::new(AtomicI64::new(1_000_000));
        let c = t.clone();
        s.set_clock(move || c.fetch_add(1, Ordering::SeqCst));
        (s, t)
    }

    fn titles(page: &ListPage) -> Vec<&str> {
        page.rows.iter().map(|r| r.title.as_str()).collect()
    }

    /// Every row of a list, page by page.
    fn all_pages(s: &Store, q: &ListQuery) -> Vec<String> {
        let mut q = q.clone();
        let mut out = Vec::new();
        loop {
            let page = s.list(&q).unwrap();
            assert!(page.rows.len() <= q.limit);
            out.extend(page.rows.iter().map(|r| r.title.clone()));
            match page.next {
                Some(c) => q.cursor = Some(c),
                None => return out,
            }
        }
    }

    #[test]
    fn list_pages_by_keyset() {
        let (s, _) = ticking_store();
        for i in 0..25 {
            s.new_draft(&format!("Draft {i}")).unwrap();
        }
        let mut q = ListQuery { limit: 10, ..ListQuery::folder(Folder::Inbox) };
        let p1 = s.list(&q).unwrap();
        assert_eq!(p1.rows.len(), 10);
        assert_eq!(p1.rows[0].title, "Draft 24");
        q.cursor = p1.next;
        let p2 = s.list(&q).unwrap();
        assert_eq!(p2.rows[0].title, "Draft 14");
        q.cursor = p2.next;
        let p3 = s.list(&q).unwrap();
        assert_eq!(p3.rows.len(), 5);
        assert!(p3.next.is_none());
    }

    #[test]
    fn every_sort_pages_the_same_rows_in_both_directions() {
        let (mut s, t) = ticking_store();
        // Titles out of creation order, two equal but for case (the id breaks the tie).
        let names = ["delta", "Alpha", "charlie", "bravo", "alpha", "Echo", "foxtrot"];
        let ids: Vec<i64> = names.iter().map(|n| s.new_draft(n).unwrap().id).collect();
        // Touch some so modified and accessed orders differ from created.
        s.save(ids[0], "delta", 0).unwrap();
        t.fetch_add(120_000, Ordering::SeqCst);
        s.draft(ids[3]).unwrap();
        s.move_drafts(&[ids[6]], Folder::Archive).unwrap();
        let expect_asc = |sort: Sort| -> Vec<String> {
            let mut rows: Vec<(SortKey, i64, String)> = s
                .raw()
                .prepare(
                    "SELECT id, title, created_at, modified_at, accessed_at FROM drafts WHERE folder = 0",
                )
                .unwrap()
                .query_map([], |r| {
                    let key = match sort {
                        Sort::Title => SortKey::Text(r.get(1)?),
                        Sort::Created => SortKey::Int(r.get(2)?),
                        Sort::Modified => SortKey::Int(r.get(3)?),
                        Sort::Accessed => SortKey::Int(r.get(4)?),
                    };
                    Ok((key, r.get(0)?, r.get(1)?))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            rows.sort_by(|a, b| a.0.cmp_nocase(&b.0).then(a.1.cmp(&b.1)));
            rows.into_iter().map(|r| r.2).collect()
        };
        for sort in [Sort::Modified, Sort::Created, Sort::Accessed, Sort::Title] {
            for limit in [1, 2, 4, 50] {
                let q = ListQuery { sort, desc: false, limit, ..ListQuery::folder(Folder::Inbox) };
                assert_eq!(all_pages(&s, &q), expect_asc(sort), "{sort:?} asc, pages of {limit}");
                let mut desc = expect_asc(sort);
                desc.reverse();
                let q = ListQuery { desc: true, ..q };
                assert_eq!(all_pages(&s, &q), desc, "{sort:?} desc, pages of {limit}");
            }
        }
        let q = ListQuery { sort: Sort::Title, desc: false, ..ListQuery::folder(Folder::Inbox) };
        assert_eq!(all_pages(&s, &q), vec!["Alpha", "alpha", "bravo", "charlie", "delta", "Echo"]);
    }

    #[test]
    fn a_cursor_from_another_sort_is_refused() {
        let (s, _) = ticking_store();
        s.new_draft("a").unwrap();
        s.new_draft("b").unwrap();
        let page = s.list(&ListQuery { limit: 1, ..ListQuery::default() }).unwrap();
        let q = ListQuery { sort: Sort::Title, cursor: page.next, ..ListQuery::default() };
        assert!(s.list(&q).is_err());
    }

    #[test]
    fn all_merges_inbox_and_archive() {
        let (mut s, _) = ticking_store();
        let ids: Vec<i64> = (0..9).map(|i| s.new_draft(&format!("d{i}")).unwrap().id).collect();
        s.move_drafts(&[ids[1], ids[4], ids[7]], Folder::Archive).unwrap();
        s.move_drafts(&[ids[8]], Folder::Trash).unwrap();
        // A move is a modification: the archived three share the newest time, then go by id.
        let q = ListQuery { folder: None, limit: 2, ..ListQuery::default() };
        assert_eq!(all_pages(&s, &q), vec!["d7", "d4", "d1", "d6", "d5", "d3", "d2", "d0"]);
    }

    #[test]
    fn flagged_top_lists_flagged_first_across_pages() {
        let (mut s, _) = ticking_store();
        let ids: Vec<i64> = (0..8).map(|i| s.new_draft(&format!("d{i}")).unwrap().id).collect();
        s.flag_drafts(&[ids[2], ids[5]], true).unwrap();
        // Sorted by created, so flagging (a modification) does not move them on its own.
        for limit in [1, 2, 3, 10] {
            let q = ListQuery { flagged_top: true, sort: Sort::Created, limit, ..ListQuery::default() };
            assert_eq!(
                all_pages(&s, &q),
                vec!["d5", "d2", "d7", "d6", "d4", "d3", "d1", "d0"],
                "pages of {limit}"
            );
        }
        let q =
            ListQuery { flagged_only: true, flagged_top: true, sort: Sort::Created, ..ListQuery::default() };
        assert_eq!(all_pages(&s, &q), vec!["d5", "d2"]);
        // By modified the flagged part walks the flagged index; flagging made both newest, in id order.
        s.move_drafts(&[ids[5]], Folder::Archive).unwrap();
        for limit in [1, 2, 10] {
            let q = ListQuery { flagged_top: true, folder: None, limit, ..ListQuery::default() };
            assert_eq!(
                all_pages(&s, &q),
                vec!["d5", "d2", "d7", "d6", "d4", "d3", "d1", "d0"],
                "pages of {limit}"
            );
            let q = ListQuery { flagged_top: true, limit, ..ListQuery::default() };
            assert_eq!(all_pages(&s, &q), vec!["d2", "d7", "d6", "d4", "d3", "d1", "d0"], "pages of {limit}");
        }
    }

    #[test]
    fn tag_filters_all_and_none() {
        let (mut s, _) = ticking_store();
        let a = s.new_draft("a").unwrap().id;
        let b = s.new_draft("b").unwrap().id;
        let c = s.new_draft("c").unwrap().id;
        s.set_tags(a, &["work".into(), "urgent".into()]).unwrap();
        s.set_tags(b, &["work".into()]).unwrap();
        s.set_tags(c, &["home".into()]).unwrap();
        let list = |tags_all: &[&str], tags_none: &[&str]| {
            let q = ListQuery {
                tags_all: tags_all.iter().map(|t| t.to_string()).collect(),
                tags_none: tags_none.iter().map(|t| t.to_string()).collect(),
                ..ListQuery::default()
            };
            titles(&s.list(&q).unwrap()).into_iter().map(String::from).collect::<Vec<_>>()
        };
        assert_eq!(list(&["Work"], &[]), vec!["b", "a"]);
        assert_eq!(list(&["work", "urgent"], &[]), vec!["a"]);
        assert_eq!(list(&["work"], &["urgent"]), vec!["b"]);
        assert_eq!(list(&[], &["work"]), vec!["c"]);
        assert_eq!(list(&["nosuchtag"], &[]), Vec::<String>::new());
        assert_eq!(list(&[], &["nosuchtag"]), vec!["c", "b", "a"]);
        // A tiny set is fetched by id and sorted; every sort still applies.
        let q = ListQuery {
            tags_all: vec!["work".into()],
            sort: Sort::Title,
            desc: false,
            limit: 1,
            ..ListQuery::default()
        };
        assert_eq!(all_pages(&s, &q), vec!["a", "b"]);
    }

    #[test]
    fn broad_filters_walk_the_index_and_agree_with_narrow_ones() {
        // More than CANDIDATES_MAX matches forces the per-row path for the tag and the text.
        let (s, _) = ticking_store();
        let n = 2 * CANDIDATES_MAX + 100;
        s.raw().execute_batch("BEGIN; INSERT INTO tags (uuid, name) VALUES ('t', 'all');").unwrap();
        for i in 0..n {
            let d =
                s.new_draft(&format!("note {i}\ncommon {}", if i % 3 == 0 { "rare" } else { "" })).unwrap();
            s.raw()
                .execute(
                    "INSERT INTO draft_tags (draft_id, tag_id) SELECT ?1, id FROM tags WHERE name = 'all'",
                    [d.id],
                )
                .unwrap();
        }
        // Two more broad tags (two thirds each), walked together.
        s.raw()
            .execute_batch(
                "INSERT INTO tags (uuid, name) VALUES ('t2', 'not0'), ('t3', 'not1');
                 INSERT INTO draft_tags (draft_id, tag_id) SELECT d.id, t.id FROM drafts d, tags t
                   WHERE (t.name = 'not0' AND d.id % 3 != 0) OR (t.name = 'not1' AND d.id % 3 != 1);
                 COMMIT;",
            )
            .unwrap();
        let q =
            ListQuery { tags_all: vec!["not0".into(), "not1".into()], limit: 500, ..ListQuery::default() };
        let both = all_pages(&s, &q);
        assert_eq!(both.len(), (1..=n).filter(|id| id % 3 == 2).count());
        let q = ListQuery { tags_all: vec!["not0".into(), "not1".into(), "all".into()], ..q };
        assert_eq!(all_pages(&s, &q), both, "a broad tag beside the intersection");
        let q = ListQuery { tags_all: vec!["all".into(), "not0".into()], limit: 500, ..ListQuery::default() };
        assert_eq!(
            all_pages(&s, &q).len(),
            (1..=n).filter(|id| id % 3 != 0).count(),
            "too broad together: walked"
        );
        let q = ListQuery {
            tags_all: vec!["all".into()],
            fts: "common".into(),
            limit: 7,
            ..ListQuery::default()
        };
        let page = s.list(&q).unwrap();
        assert_eq!(page.rows.len(), 7);
        assert_eq!(titles(&page)[0], format!("note {}", n - 1));
        let q = ListQuery {
            tags_all: vec!["all".into()],
            fts: "rare".into(),
            limit: 500,
            ..ListQuery::default()
        };
        assert_eq!(all_pages(&s, &q).len(), n.div_ceil(3), "a narrow filter with a broad one");
        let q = ListQuery { fts: "common".into(), tags_none: vec!["all".into()], ..ListQuery::default() };
        assert!(s.list(&q).unwrap().rows.is_empty());
        let q = ListQuery { fts: "common".into(), limit: 500, ..ListQuery::default() };
        let rows = all_pages(&s, &q);
        assert_eq!(rows.len(), CANDIDATES_MAX, "broad text keeps the newest matches");
        assert_eq!(rows.last().unwrap(), &format!("note {}", n - CANDIDATES_MAX));
    }

    #[test]
    fn list_text_filter_is_safe() {
        let (s, _) = ticking_store();
        s.new_draft("milk and eggs").unwrap();
        for odd in ["\"", "*", "-", "OR", "milk\" OR *", "NOT", "(", "a:b", "\"open phrase"] {
            assert!(s.list(&ListQuery { fts: odd.into(), ..ListQuery::default() }).is_ok(), "{odd}");
        }
        assert_eq!(s.list(&ListQuery { fts: "egg".into(), ..ListQuery::default() }).unwrap().rows.len(), 1);
    }

    #[test]
    fn folders_and_flags() {
        let mut s = store();
        let d = s.new_draft("one").unwrap();
        s.move_drafts(&[d.id], Folder::Archive).unwrap();
        assert_eq!(s.count(Folder::Inbox).unwrap(), 0);
        assert_eq!(s.count(Folder::Archive).unwrap(), 1);
        s.flag_drafts(&[d.id], true).unwrap();
        assert!(s.draft(d.id).unwrap().flagged);
    }

    #[test]
    fn batches_undo_once_and_keep_later_edits() {
        let (mut s, t) = ticking_store();
        let a = s.new_draft("a").unwrap();
        let b = s.new_draft("b").unwrap();
        s.move_drafts(&[b.id], Folder::Archive).unwrap();
        let tok = s.move_drafts(&[a.id, b.id], Folder::Archive).unwrap();
        assert_eq!(tok.count, 1, "b was already archived");
        assert_eq!(s.count(Folder::Archive).unwrap(), 2);
        assert_eq!(s.undo(&tok.token).unwrap(), 1);
        assert_eq!(s.count(Folder::Inbox).unwrap(), 1);
        assert_eq!(s.count(Folder::Archive).unwrap(), 1, "b stays where it was before the batch");
        assert_eq!(s.draft(a.id).unwrap().modified_at, a.modified_at, "the list order comes back too");
        assert!(s.undo(&tok.token).is_err(), "a token works once");

        let flag = s.flag_drafts(&[a.id], true).unwrap();
        t.fetch_add(1000, Ordering::SeqCst);
        s.save(a.id, "a edited", 0).unwrap();
        let edited = s.draft(a.id).unwrap().modified_at;
        s.undo(&flag.token).unwrap();
        let after = s.draft(a.id).unwrap();
        assert!(!after.flagged);
        assert_eq!(after.modified_at, edited, "an edit after the batch keeps its time");
        assert!(s.undo("not-a-token").is_err());
    }

    #[test]
    fn add_tags_keeps_existing_tags_and_undoes() {
        let (mut s, _) = ticking_store();
        let a = s.new_draft("a").unwrap();
        let b = s.new_draft("b").unwrap();
        s.set_tags(a.id, &["work".into()]).unwrap();
        s.set_tags(b.id, &["home".into(), "idea".into()]).unwrap();
        let b_time = s.draft(b.id).unwrap().modified_at;
        let tok = s.add_tags(&[a.id, b.id, 9999], &["Idea".into(), " ".into()]).unwrap();
        assert_eq!(tok.count, 1, "b already had it; 9999 does not exist");
        assert_eq!(s.draft(a.id).unwrap().tags, vec!["idea", "work"]);
        assert_eq!(s.draft(b.id).unwrap().modified_at, b_time, "untouched");
        assert_eq!(s.undo(&tok.token).unwrap(), 1);
        assert_eq!(s.draft(a.id).unwrap().tags, vec!["work"]);
        assert_eq!(s.draft(b.id).unwrap().tags, vec!["home", "idea"]);
    }

    #[test]
    fn undo_restores_only_the_column_the_batch_changed() {
        let (mut s, _) = ticking_store();
        let a = s.new_draft("a").unwrap();
        let tok = s.move_drafts(&[a.id], Folder::Trash).unwrap();
        s.flag_drafts(&[a.id], true).unwrap();
        s.undo(&tok.token).unwrap();
        let d = s.draft(a.id).unwrap();
        assert_eq!(d.folder, Folder::Inbox);
        assert!(d.flagged);
    }

    #[test]
    fn only_the_newest_undo_tokens_are_kept() {
        let (mut s, _) = ticking_store();
        let a = s.new_draft("a").unwrap();
        let first = s.flag_drafts(&[a.id], true).unwrap();
        for i in 0..UNDO_KEPT {
            s.flag_drafts(&[a.id], i % 2 == 0).unwrap();
        }
        assert!(s.undo(&first.token).is_err());
    }

    #[test]
    fn opening_marks_accessed_at_most_once_a_minute() {
        let (s, now) = store_with_clock(10_000_000);
        let d = s.new_draft("x").unwrap();
        now.fetch_add(30_000, Ordering::SeqCst);
        assert_eq!(s.draft(d.id).unwrap().accessed_at, 10_000_000, "within a minute: no write");
        now.fetch_add(40_000, Ordering::SeqCst);
        assert_eq!(s.draft(d.id).unwrap().accessed_at, 10_070_000);
        assert_eq!(s.draft(d.id).unwrap().modified_at, 10_000_000, "opening is not a modification");
    }

    #[test]
    fn tag_counts_rename_and_merge() {
        let (mut s, _) = ticking_store();
        let a = s.new_draft("a").unwrap().id;
        let b = s.new_draft("b").unwrap().id;
        let c = s.new_draft("c").unwrap().id;
        s.set_tags(a, &["work".into(), "todo".into()]).unwrap();
        s.set_tags(b, &["work".into(), "to-do".into()]).unwrap();
        s.set_tags(c, &["work".into()]).unwrap();
        s.move_drafts(&[c], Folder::Archive).unwrap();
        let counts = |s: &Store, f| {
            s.tag_counts(f).unwrap().into_iter().map(|t| (t.name, t.count)).collect::<Vec<(String, i64)>>()
        };
        assert_eq!(
            counts(&s, Some(Folder::Inbox)),
            vec![("to-do".into(), 1), ("todo".into(), 1), ("work".into(), 2)]
        );
        assert_eq!(counts(&s, None)[2], ("work".into(), 3));
        let before = s.draft(a).unwrap().modified_at;
        assert_eq!(s.rename_tag("Work", "Job").unwrap(), 3);
        assert_eq!(s.draft(a).unwrap().tags, vec!["job", "todo"]);
        assert_eq!(s.draft(a).unwrap().modified_at, before, "a rename does not reorder the list");
        assert_eq!(s.merge_tags(&["to-do".into(), "todo".into()], "todo").unwrap(), 1);
        assert_eq!(s.draft(b).unwrap().tags, vec!["job", "todo"]);
        assert_eq!(counts(&s, Some(Folder::Inbox)), vec![("job".into(), 2), ("todo".into(), 2)]);
        // Renaming onto an existing tag merges; a draft with both keeps one.
        assert_eq!(s.rename_tag("todo", "job").unwrap(), 2);
        assert_eq!(s.draft(a).unwrap().tags, vec!["job"]);
        assert!(s.rename_tag("nope", "x").is_err());
        assert!(s.rename_tag("job", "  ").is_err());
    }

    #[test]
    fn search_is_safe_and_matches_prefixes() {
        let mut s = store();
        s.new_draft("Groceries\nmilk, eggs, bread").unwrap();
        s.new_draft("Café plans\nmeet at the café").unwrap();
        let t = s.new_draft("Trashed\nmilk").unwrap();
        s.move_drafts(&[t.id], Folder::Trash).unwrap();
        assert_eq!(s.search("mil", 10).unwrap().len(), 1, "trash is excluded, prefix matches");
        assert_eq!(s.search("cafe", 10).unwrap().len(), 1, "diacritics are folded");
        for odd in ["milk\" OR *", "\"", "*", "-", "OR", "NOT x", "tag:", "is:", "-tag:\"", "\"open phrase"] {
            assert!(s.search(odd, 10).is_ok(), "FTS syntax in input cannot error: {odd}");
        }
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
        s.move_drafts(&[d.id], Folder::Trash).unwrap();
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
        s.move_drafts(&[d.id], Folder::Trash).unwrap();
        assert_eq!(s.empty_trash().unwrap(), 1);
        assert_eq!(s.count(Folder::Trash).unwrap(), 0);
    }

    #[test]
    fn search_filters_by_tag_flag_and_folder() {
        let (mut s, _) = ticking_store();
        let a = s.new_draft("Shopping\nmilk").unwrap().id;
        let b = s.new_draft("Work notes\nmilk the budget").unwrap().id;
        let c = s.new_draft("Old\nmilk").unwrap().id;
        s.set_tags(a, &["home".into()]).unwrap();
        s.set_tags(b, &["work".into()]).unwrap();
        s.flag_drafts(&[b], true).unwrap();
        s.move_drafts(&[c], Folder::Trash).unwrap();
        let ids = |q: &str| s.search(q, 10).unwrap().into_iter().map(|h| h.id).collect::<Vec<_>>();
        assert_eq!(ids("milk"), vec![b, a]);
        assert_eq!(ids("milk tag:home"), vec![a]);
        assert_eq!(ids("milk -tag:home"), vec![b]);
        assert_eq!(ids("is:flagged"), vec![b], "a filter alone lists");
        assert_eq!(ids("milk in:trash"), vec![c]);
        assert_eq!(ids("tag:nosuch milk"), Vec::<i64>::new());
        assert_eq!(ids("\"the budget\""), vec![b]);
        assert_eq!(ids("\"budget the\""), Vec::<i64>::new(), "a phrase is in order");
        let hit = &s.search("tag:work budget", 10).unwrap()[0];
        assert!(hit.snippet.contains("\u{1}budget\u{2}"), "{}", hit.snippet);
        assert_eq!(s.search("tag:home", 10).unwrap()[0].snippet, "milk", "no words: the preview");
    }

    #[test]
    fn sweep_thins_versions_and_save_never_deletes() {
        let (mut s, now) = store_with_clock(1_700_000_000_000);
        let d = s.new_draft("v0").unwrap();
        // A save every 6 minutes for three days: each one takes a version.
        let saves = 3 * 24 * 10;
        for i in 1..=saves {
            now.fetch_add(6 * 60 * 1000, Ordering::SeqCst);
            s.save(d.id, &format!("v{i}"), 0).unwrap();
        }
        assert_eq!(s.versions(d.id).unwrap().len(), saves, "save takes versions and never deletes one");
        s.snapshot(d.id, "before_action:x", now.load(Ordering::SeqCst) - 2 * DAY_MS).unwrap();
        let report = s.sweep().unwrap();
        let left = s.versions(d.id).unwrap();
        assert_eq!(report.versions_thinned, saves + 1 - left.len());
        // About 10 from the last hour, 23 more hourly, two or three daily, and the protected one.
        assert!((34..=40).contains(&left.len()), "{} left", left.len());
        assert!(left.iter().any(|v| v.reason == "before_action:x"));
        assert_eq!(s.sweep().unwrap().versions_thinned, 0, "a second sweep has nothing to do");
        s.set_setting("retention.versionsDailyDays", "1").unwrap();
        assert_eq!(s.retention().unwrap().versions_daily_days, 7, "settings cannot go below their floor");
    }

    #[test]
    fn trash_period_is_a_setting() {
        let (mut s, now) = store_with_clock(1_700_000_000_000);
        let d = s.new_draft("bin me").unwrap();
        s.move_drafts(&[d.id], Folder::Trash).unwrap();
        s.set_setting("retention.trashDays", "3").unwrap();
        now.fetch_add(4 * DAY_MS, Ordering::SeqCst);
        assert_eq!(s.sweep().unwrap().tombstoned, 1);
        let d = s.new_draft("again").unwrap();
        s.move_drafts(&[d.id], Folder::Trash).unwrap();
        s.set_setting("retention.trashDays", "0").unwrap();
        now.fetch_add(DAY_MS / 2, Ordering::SeqCst);
        assert_eq!(s.sweep().unwrap().tombstoned, 0, "the floor is one day");
    }

    /// Writes a v1 database the way a v1 build did, for the migration tests.
    fn v1_fixture(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(
            "INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('device_id', 'fixture'), ('created', '0');
             INSERT INTO drafts (uuid, content, title, preview, created_at, modified_at, accessed_at)
               VALUES ('u1', 'Zebra\nstripes', 'Zebra', 'stripes', 1, 1, 1),
                      ('u2', 'apple\npie', 'apple', 'pie', 2, 2, 2);",
        )
        .unwrap();
    }

    #[test]
    fn a_v1_database_migrates_to_the_current_version_with_a_backup() {
        let dir = std::env::temp_dir().join(format!("petrel-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("petrel.db");
        v1_fixture(&path);
        let s = Store::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
        let backups: Vec<_> =
            std::fs::read_dir(dir.join("backups")).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(backups.len(), 1);
        assert!(backups[0].to_string_lossy().starts_with("petrel-v1-"), "{backups:?}");
        let device: String =
            s.raw().query_row("SELECT value FROM meta WHERE key = 'device_id'", [], |r| r.get(0)).unwrap();
        assert_eq!(device, "fixture", "migration keeps the device id");
        let page = s.list(&ListQuery { sort: Sort::Title, desc: false, ..ListQuery::default() }).unwrap();
        assert_eq!(titles(&page), vec!["apple", "Zebra"]);
        let plan: String = s
            .raw()
            .query_row(
                "EXPLAIN QUERY PLAN SELECT id FROM drafts WHERE +folder = 0 AND deleted_at IS NULL \
                 ORDER BY title COLLATE NOCASE, id LIMIT 5",
                [],
                |r| r.get(3),
            )
            .unwrap();
        assert!(plan.contains("drafts_title"), "{plan}");
        assert_eq!(s.search("stripes", 5).unwrap().len(), 1, "the search index came through");
        assert_eq!(s.count(Folder::Inbox).unwrap(), 2);
        drop(s);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_v2_database_gets_counts_that_match_its_rows() {
        let dir = std::env::temp_dir().join(format!("petrel-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("petrel.db");
        v1_fixture(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA_V2).unwrap();
            conn.execute_batch(
                "UPDATE meta SET value = '2' WHERE key = 'schema_version';
                 INSERT INTO drafts (uuid, content, title, preview, folder, created_at, modified_at, accessed_at)
                   VALUES ('u3', 'old', 'old', '', 1, 3, 3, 3), ('u4', 'bin', 'bin', '', 2, 4, 4, 4);
                 INSERT INTO drafts (uuid, folder, created_at, modified_at, accessed_at, deleted_at)
                   VALUES ('u5', 2, 5, 5, 5, 5);
                 INSERT INTO tags (uuid, name) VALUES ('t1', 'work'), ('t2', 'idea');
                 INSERT INTO draft_tags (draft_id, tag_id) VALUES (1, 1), (2, 1), (3, 1), (3, 2), (5, 2);",
            )
            .unwrap();
        }
        let mut s = Store::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
        assert_counts_match(&s);
        assert_eq!(
            (
                s.count(Folder::Inbox).unwrap(),
                s.count(Folder::Archive).unwrap(),
                s.count(Folder::Trash).unwrap()
            ),
            (2, 1, 1),
            "the tombstone is not counted"
        );
        let tags = |s: &Store, f| -> Vec<(String, i64)> {
            s.tag_counts(f).unwrap().into_iter().map(|t| (t.name, t.count)).collect()
        };
        assert_eq!(tags(&s, None), vec![("idea".into(), 1), ("work".into(), 3)]);
        assert_eq!(tags(&s, Some(Folder::Inbox)), vec![("work".into(), 2)]);
        s.move_drafts(&[3], Folder::Inbox).unwrap();
        assert_eq!(tags(&s, Some(Folder::Inbox)), vec![("idea".into(), 1), ("work".into(), 3)]);
        assert_counts_match(&s);
        drop(s);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The trigger-kept counts against counting the rows.
    fn assert_counts_match(s: &Store) {
        let manual: i64 = s.raw().query_row("SELECT manual FROM count_ctl", [], |r| r.get(0)).unwrap();
        assert_eq!(manual, 0, "a batch left the per-row trigger off");
        let rows = |sql: &str| -> Vec<(i64, i64, i64)> {
            let mut stmt = s.raw().prepare(sql).unwrap();
            let v = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
            v.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(
            rows("SELECT 0, folder, n FROM folder_counts WHERE n != 0 ORDER BY folder"),
            rows("SELECT 0, folder, COUNT(*) FROM drafts WHERE deleted_at IS NULL GROUP BY folder ORDER BY folder"),
            "folder counts"
        );
        assert_eq!(
            rows("SELECT tag_id, folder, n FROM tag_counts WHERE n != 0 ORDER BY tag_id, folder"),
            rows(
                "SELECT dt.tag_id, d.folder, COUNT(*) FROM draft_tags dt JOIN drafts d ON d.id = dt.draft_id \
                 WHERE d.deleted_at IS NULL GROUP BY dt.tag_id, d.folder ORDER BY dt.tag_id, d.folder"
            ),
            "tag counts"
        );
    }

    #[test]
    fn counts_stay_right_through_every_kind_of_change() {
        let (mut s, now) = store_with_clock(1_700_000_000_000);
        let mut rng = crate::gen::Rng::new(11);
        let names = ["a", "b", "c", "d"];
        let mut ids = Vec::new();
        let mut tokens = Vec::new();
        for step in 0..400 {
            now.fetch_add(60_000, Ordering::SeqCst);
            let pick = |rng: &mut crate::gen::Rng, ids: &[i64]| ids[rng.below(ids.len() as u64) as usize];
            match if ids.is_empty() { 0 } else { rng.below(11) } {
                0 | 1 => ids.push(s.new_draft(&format!("draft {step}")).unwrap().id),
                2 => {
                    let tags: Vec<String> =
                        (0..rng.below(3)).map(|_| names[rng.below(4) as usize].to_string()).collect();
                    let _ = s.set_tags(pick(&mut rng, &ids), &tags); // a purged id fails, as it should
                }
                3 => {
                    let batch: Vec<i64> = (0..3).map(|_| pick(&mut rng, &ids)).collect();
                    let folder = [Folder::Inbox, Folder::Archive, Folder::Trash][rng.below(3) as usize];
                    tokens.push(s.move_drafts(&batch, folder).unwrap().token);
                }
                4 => {
                    let batch: Vec<i64> = (0..3).map(|_| pick(&mut rng, &ids)).collect();
                    tokens
                        .push(s.add_tags(&batch, &[names[rng.below(4) as usize].to_string()]).unwrap().token);
                }
                5 => {
                    if let Some(t) = tokens.pop() {
                        let _ = s.undo(&t);
                    }
                }
                6 => {
                    let _ = s.rename_tag(names[rng.below(4) as usize], names[rng.below(4) as usize]);
                }
                7 => {
                    let _ = s.merge_tags(
                        &[names[rng.below(4) as usize].to_string()],
                        names[rng.below(4) as usize],
                    );
                }
                8 => {
                    s.empty_trash().unwrap();
                }
                9 => {
                    now.fetch_add(40 * DAY_MS, Ordering::SeqCst);
                    s.sweep().unwrap();
                }
                _ => {
                    tokens.push(s.flag_drafts(&[pick(&mut rng, &ids)], true).unwrap().token);
                }
            }
            assert_counts_match(&s);
        }
        let (purged, live): (i64, i64) = s
            .raw()
            .query_row(
                "SELECT ?1 - COUNT(*), COUNT(*) FILTER (WHERE deleted_at IS NULL) FROM drafts",
                params![ids.len() as i64],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(purged > 0 && live > 0, "the walk reached purges and kept live drafts: {purged} {live}");
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
