# Sprint 1 — Store and drafts

**Status:** not started

## Delivery scope

**M0:** schema, migrations, versions, FTS, sweep, bench. **M1:** list queries with filters, tags, trash policy,
batch operations with undo. **M2:** links table, user syntaxes, mirror bookkeeping. Sync tables are M4 (package 10).

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Goal

Every question the UI asks is answered from SQLite in under a millisecond per page, every write is tiny, and
no user action can lose text: versions before risk, tombstones instead of deletes, a backup before a migration.

## Tasks

### Schema and migrations (M0)
- [ ] v1 `SCHEMA` exactly as in [data-model.md](../research/data-model.md); FTS5 external-content triggers.
- [ ] `migrate()` numbered steps; fixture databases under `crates/petrel-core/tests/fixtures/vN.db` created by a
      test helper, not committed binaries, where possible (committed if a step needs real old data).
- [ ] `backup_before_migrate()` via the SQLite backup API into `<data dir>/backups/`, keep the last 5.
- [ ] `meta.device_id` (UUID v4 on first create) for future sync.

### Versions (M0)
- [ ] `version_if_due(draft)` on save: newest 'edit' version older than 5 min → snapshot. Always snapshot before an
      action run (`reason = before_action:<uuid>`) and before `restore`.
- [ ] Cap 50 per draft (setting), oldest 'edit' versions trimmed first, `before_action` kept longer. Test the trim.
- [ ] `restore(version)` → new version of the current text first, then replace content.

### Lists, filters, search (M1)
- [ ] `list(ListQuery { folder, flagged_only, tags_all, tags_none, fts, sort, desc, flagged_top, cursor, limit })`
      with keyset paging on `(sort_key, id)`; flagged-top as two scans. Tests for every sort and cursor direction.
- [ ] `search(q)` with FTS5 query sanitising (quote user input per token, support `tag:` and `is:flagged`
      prefixes parsed in Rust, not passed to FTS). `snippet()` for previews. Test odd input: `"`, `*`, `-`, `OR`.
- [ ] Tags: `set_tags(draft, names)` normalises (lower-case, trim, dedupe), creates missing tags, removes orphans
      lazily in `sweep()`. `tag_counts(folder)`. Rename and merge tags.
- [ ] Folder moves: `move(ids, folder)`, `flag(ids, bool)`, each returning an **undo token** that reverts the batch
      (same shape as Tern's outbox undo, without the outbox). `undo(token)`.
- [ ] `accessed_at` updated on open, debounced to once per minute per draft.

### Trash and sweep (M1)
- [ ] `sweep()` on start and daily: trash > 30 days → tombstone (`deleted_at`, content cleared, versions
      deleted); tombstones > 90 days → row deleted; orphan tags removed. Both periods are settings. Test with
      injected clocks.
- [ ] "Empty trash" = tombstone now, with a confirm in the UI and no undo (said in the dialog).

### Later (M2)
- [ ] `links` table maintained on save from `[[Title]]`, `[[d:Title]]`, `[[u:UUID]]`; `backlinks(draft)`.
- [ ] `syntaxes` table for user grammars (package 02 decides the grammar format).
- [ ] `mirror` table for package 06.

## Acceptance (owner)
- [ ] 50k generated drafts: list scroll is instant, search for a rare word < 10 ms in the log, tag filter instant.
- [ ] Trash a draft, change the clock 31 days, restart: it is gone from the list, the row is a tombstone.
- [ ] Open the database with an older build: it refuses with a clear message; the backup exists.

## Decisions

## Log
