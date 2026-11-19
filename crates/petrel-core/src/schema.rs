//! The database's schema steps, kept as they shipped: a database made by any earlier Petrel is brought forward
//! through each of them, so none can change or go. v1 to v4 are the old drafts store (drafts, tags, versions,
//! and the actions that are long gone); the app no longer reads or writes those tables, but they stay, so an
//! old database opens and its drafts can still be exported (`Store::export_drafts_once`). v5 is the notes index
//! (`notes::SCHEMA_V5`).

pub(crate) const SCHEMA: &str = r#"
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
pub(crate) const SCHEMA_V2: &str = r#"
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
pub(crate) const SCHEMA_V3: &str = r#"
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
pub(crate) const SCHEMA_V4: &str = r#"
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
