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

## Queries the store must answer fast (all in `store_bench`)

| Name | Shape |
|---|---|
| `list(folder, filter, sort, cursor, limit)` | Index scan on `drafts_list` (or created/accessed/title); tag filters join `draft_tags`; FTS filter joins `drafts_fts`; flagged-top is two ordered scans concatenated, not `ORDER BY flagged DESC` |
| `search(query, scope)` | `drafts_fts MATCH ?` with `bm25`, limited to 200, then page; snippets via `snippet()` on `content` |
| `open(id)` | Row + tags + `COUNT(versions)` in one statement with subqueries |
| `save(id, content, cursor)` | One UPDATE; title/preview computed in Rust; FTS by trigger |
| `version_if_due(id)` | Insert a version when the newest `edit` one is older than 5 min; no trimming here |
| `tag_counts(folder)` | Group by on `draft_tags` joined to visible drafts; cached by the UI per list change |
| `sweep()` | Trash > 30 days → tombstone; tombstones > 90 days → delete; versions thinned by the age tiers; orphan tags removed |

## Candidate later versions (allocate numbers when a slice is implemented)

- **Links** (package 02, M2): `links (from_draft, to_draft, kind)` maintained on save by scanning `[[…]]`, so backlinks are a lookup.
- **Syntaxes** (package 02, M2): `syntaxes (id, name, grammar JSON)` for user-defined highlighting.
- **Mirror export** (package 06, M2): `mirror (draft_id, path, written_at, hash)` so the folder mirror is incremental.
- **Sync** (package 10, M4): `changes (seq, table, uuid, field, value, ts, device)` or a per-row `vclock`; decide in M4.
- **AI** (package 11, M4): nothing in SQLite beyond `settings`; keys in the keyring.
