# Data model

Schema v1 lives in `crates/petrel-core/src/store.rs` as `SCHEMA`; later versions are numbered steps in
`store::migrate()`, forward-only, each in its own transaction, each with a test that opens a v(n-1) fixture.
`migrate()` refuses a database from a newer Petrel and **copies the file to `backups/petrel-vN-YYYYMMDD.db`
before the first step runs** (SQLite backup API). Debug builds open `<data dir>/dev/petrel.db`.

Design rules, fixed before any code:

- **UUIDs on everything a user can see or sync** (drafts, tags, actions, groups, workspaces, versions). Integer
  row ids stay internal for joins. M4 sync merges on UUID.
- **Timestamps are integer Unix milliseconds, UTC.** `modified_at` changes on content or metadata change;
  `accessed_at` changes when a draft is opened. All three exist so workspaces can sort by any.
- **Nothing is hard-deleted on a user action.** Trash is `folder = 2`. Emptying trash or the 30-day sweep sets
  `deleted_at` and clears `content` (a tombstone row stays for sync and for "this UUID existed"). Tombstones are
  purged after 90 days by the same sweep.
- **Keyset paging** on `(sort_key, id)`, never OFFSET. Content is in the same row (drafts are small, typically
  < 10 kB) but list queries select only the columns they show; `title` and `preview` are stored, not computed.
- **Writes are tiny and frequent** (autosave). One `UPDATE drafts SET content, title, preview, modified_at, cursor
  WHERE id` per debounced keystroke burst; the FTS external-content table updates by trigger. Measured in
  `store_bench`.
- Versions are **snapshots, not diffs**, thinned by age in `sweep()` (all from the last hour, hourly for a day,
  daily for 30 days, weekly after; `before_action`/`restore` kept 90 days first). No hard cap; never thinned on the
  save path. Simplicity over space; drafts are small.

## v1

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);     -- 'schema_version', 'device_id', 'created'

CREATE TABLE drafts (
  id          INTEGER PRIMARY KEY,
  uuid        TEXT NOT NULL UNIQUE,
  content     TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',      -- first non-empty line, trimmed, max 200 chars
  preview     TEXT NOT NULL DEFAULT '',      -- next ~160 chars after the title, whitespace collapsed
  folder      INTEGER NOT NULL DEFAULT 0,    -- 0 inbox, 1 archive, 2 trash
  flagged     INTEGER NOT NULL DEFAULT 0,
  syntax      TEXT NOT NULL DEFAULT 'markdown',  -- 'markdown' | 'plain' | 'taskpaper' | 'list' | user id
  cursor      INTEGER NOT NULL DEFAULT 0,    -- last cursor offset (UTF-16 units, what the editor uses)
  created_at  INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL,
  deleted_at  INTEGER                        -- tombstone; content is '' once set
);
CREATE INDEX drafts_list     ON drafts (folder, modified_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX drafts_created  ON drafts (folder, created_at  DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX drafts_accessed ON drafts (folder, accessed_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX drafts_flagged  ON drafts (flagged, modified_at DESC) WHERE flagged = 1 AND deleted_at IS NULL;
CREATE INDEX drafts_trash    ON drafts (modified_at) WHERE folder = 2 AND deleted_at IS NULL;  -- the sweep

CREATE VIRTUAL TABLE drafts_fts USING fts5 (
  content, title,
  content = 'drafts', content_rowid = 'id',
  tokenize = "unicode61 remove_diacritics 2"
);
-- external-content FTS: triggers keep it in step with drafts (insert, delete, update of content/title)

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE   -- stored lower-case, shown as typed first
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
  reason     TEXT NOT NULL,                  -- 'edit' | 'before_action:<uuid>' | 'restore' | 'import'
  created_at INTEGER NOT NULL
);
CREATE INDEX versions_draft ON versions (draft_id, created_at DESC);

CREATE TABLE action_groups (
  id       INTEGER PRIMARY KEY,
  uuid     TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE actions (
  id            INTEGER PRIMARY KEY,
  uuid          TEXT NOT NULL UNIQUE,
  group_id      INTEGER REFERENCES action_groups(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  icon          TEXT NOT NULL DEFAULT '',    -- a name from the bundled icon set
  color         TEXT NOT NULL DEFAULT '',    -- token name from ui.md, not a hex value
  shortcut      TEXT,                        -- 'Ctrl+Shift+C' in the normalized form used by the UI
  position      INTEGER NOT NULL,
  steps         TEXT NOT NULL,               -- JSON array, see design/actions.md
  after_success TEXT NOT NULL DEFAULT 'nothing',  -- 'nothing' | 'archive' | 'trash' | 'new'
  add_tags      TEXT NOT NULL DEFAULT '',    -- comma-separated tag names applied after success
  confirm       INTEGER NOT NULL DEFAULT 0,  -- ask before running
  disabled      INTEGER NOT NULL DEFAULT 0,  -- imported but not runnable (unsupported steps)
  hidden        INTEGER NOT NULL DEFAULT 0,  -- not in the list, still callable by name/shortcut
  trusted_hash  TEXT,                        -- sha256 of steps when the user saw/wrote them; NULL = untrusted
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
  status     TEXT NOT NULL,                  -- 'ok' | 'cancelled' | 'failed' | 'running'
  step       INTEGER,                        -- failing step index
  message    TEXT NOT NULL DEFAULT '',       -- error or script log tail, capped at 8 kB
  source     TEXT NOT NULL                   -- 'ui' | 'shortcut' | 'cli' | 'uri' | 'action'
);
CREATE INDEX action_runs_time ON action_runs (started_at DESC);

CREATE TABLE workspaces (
  id            INTEGER PRIMARY KEY,
  uuid          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  position      INTEGER NOT NULL,
  folder        INTEGER,                     -- NULL = inbox + archive ("all")
  query         TEXT NOT NULL DEFAULT '',    -- FTS query string
  tags_include  TEXT NOT NULL DEFAULT '',    -- comma-separated, all must match
  tags_exclude  TEXT NOT NULL DEFAULT '',
  flagged_only  INTEGER NOT NULL DEFAULT 0,
  sort          TEXT NOT NULL DEFAULT 'modified',  -- 'modified' | 'created' | 'accessed' | 'title'
  sort_desc     INTEGER NOT NULL DEFAULT 1,
  flagged_top   INTEGER NOT NULL DEFAULT 1,
  group_id      INTEGER REFERENCES action_groups(id) ON DELETE SET NULL,
  deleted_at    INTEGER
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- JSON values; UI prefs, hotkey, paths
```

## v2

```sql
CREATE INDEX drafts_title ON drafts (folder, title COLLATE NOCASE, id) WHERE deleted_at IS NULL;
```

Title sort walks this index instead of sorting a folder. (Replaced in v3.)

## v3

```sql
DROP INDEX drafts_list; DROP INDEX drafts_title; DROP INDEX drafts_created; DROP INDEX drafts_accessed;
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
-- filled by counting in the migration, then kept by triggers on drafts (insert, folder/deleted_at change,
-- delete of a live row) and draft_tags (insert, delete). Live drafts only.
```

Only `drafts_list` (modified) still leads with the folder. A move used to rewrite the draft's entry in every
sort index (330 pages for 50 scattered drafts, 19 ms on Windows for archive + undo); now it touches the row and
its `drafts_list` entry. The other sorts check the folder per row, or sort a small folder whole from
`drafts_list`, which carries their keys so the sort never reads the table. Counts come from
the two tables instead of counting rows (84 ms for tag counts on Windows at 50k). Tests:
`a_v2_database_gets_counts_that_match_its_rows`, `counts_stay_right_through_every_kind_of_change`,
`a_v1_database_migrates_to_the_current_version_with_a_backup`.

## Connections

The store has one connection behind a `Mutex`, and a checkpointer thread with its own connection runs
`PRAGMA wal_checkpoint(PASSIVE)` every 2 s. `wal_autocheckpoint` on the main connection is 4,000 pages, a
backstop only. With SQLite's default (1,000 pages), the write that crossed the limit did the checkpoint and its
fsyncs inline: a one-second write on Windows.

## Settings the engine reads

`retention.trashDays` (30, floor 1), `retention.tombstoneDays` (90, floor 30), `retention.versionsAllHours` (1),
`retention.versionsHourlyDays` (1), `retention.versionsDailyDays` (30, floor 7), `retention.versionsProtectedDays`
(90, floor 30). Whole numbers; a missing or non-numeric value means the default. See `retention.rs`.

## Queries the store must answer fast (all in `store_bench`)

| Name | Shape |
|---|---|
| `list(ListQuery)` | Index scan on `drafts_list` (or created/accessed/title, checking the folder per row; a folder under `√(8 × page × drafts)` is sorted whole from `drafts_list`'s keys) with a row-value keyset bound; "All" merges the Inbox and Archive scans; flagged-top is two ordered scans concatenated, not `ORDER BY flagged DESC`. Filters on at most 2,000 drafts become an id set (`rarray`), fetched by rowid when tiny, else tested while walking; broader tags are `EXISTS` on `draft_tags` per row; text is the newest 2,000 FTS matches (package 01 Decisions) |
| `search(query, scope)` | `SELECT rowid FROM drafts_fts WHERE MATCH ? ORDER BY rowid DESC LIMIT 400` (FTS5 stops early: microseconds for any term), then the drafts rows by `modified_at DESC`; snippets made in Rust. Exact under 400 matches; newest-first above. `bm25` was 21 ms for a stopword at 50k and is not used (package 00 Decisions) |
| `open(id)` | Row + tags + `COUNT(versions)` in one statement with subqueries |
| `save(id, content, cursor)` | One UPDATE; title/preview computed in Rust; FTS by trigger |
| `version_if_due(id)` | Insert a version when the newest `edit` one is older than 5 min; no trimming here |
| `tag_counts(folder)`, `count(folder)` | Read from `tag_counts` / `folder_counts` (v3, trigger-kept): 0.01 ms at 50k |
| `move_drafts`/`flag_drafts`/`undo` | One UPDATE over an id set; the old values are kept in memory for the undo token |
| `sweep()` | Trash > `trashDays` → tombstone; tombstones > `tombstoneDays` → delete; versions thinned by the age tiers (newest per UTC hour/day/week bucket); orphan tags removed. At start and every 24 h |

## Candidate later versions (allocate numbers when a slice is implemented)

- **Links** (package 02, M2): `links (from_draft, to_draft, kind)` maintained on save by scanning `[[…]]`, so backlinks are a lookup.
- **Syntaxes** (package 02, M2): `syntaxes (id, name, grammar JSON)` for user-defined highlighting.
- **Mirror export** (package 06, M2): `mirror (draft_id, path, written_at, hash)` so the folder mirror is incremental.
- **Sync** (package 10, M4): `changes (seq, table, uuid, field, value, ts, device)` or a per-row `vclock`; decide in M4.
- **AI** (package 11, M4): nothing in SQLite beyond `settings`; keys in the keyring.
