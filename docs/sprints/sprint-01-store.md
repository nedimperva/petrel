# Sprint 1 — Store and drafts

**Status:** in progress · started 2026-10-22

## Delivery scope

**M0:** schema, migrations, versions, FTS, sweep, bench. **M1:** list queries with filters, tags, trash policy,
batch operations with undo. **M2:** links table, user syntaxes, mirror bookkeeping. Sync tables are M4 (package 10).

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Goal

Every question the UI asks is answered from SQLite in under a millisecond per page, every write is tiny, and
no user action can lose text: versions before risk, tombstones instead of deletes, a backup before a migration.

## Tasks

### Schema and migrations (M0)
- [x] v1 `SCHEMA` exactly as in [data-model.md](../research/data-model.md); FTS5 external-content triggers. (package 00)
- [x] `migrate()` numbered steps; fixture databases under `crates/petrel-core/tests/fixtures/vN.db` created by a
      test helper, not committed binaries, where possible (committed if a step needs real old data).
      The helper is `v1_fixture()` in the store tests (in-module, so it can use the v1 `SCHEMA` text); the v2 step
      is tested from it. No committed binaries.
- [x] `backup_before_migrate()` via the SQLite backup API into `<data dir>/backups/`, keep the last 5. (package 00;
      now also exercised by the real v1 → v2 step)
- [x] `meta.device_id` (UUID v4 on first create) for future sync. (package 00; the v2 test checks it survives)

### Versions (M0)
- [x] `version_if_due(draft)` on save: newest 'edit' version older than 5 min → snapshot. Always snapshot before an
      action run (`reason = before_action:<uuid>`) and before `restore`. (package 00; `snapshot()` is what package 03
      calls before a run)
- [x] Age-tiered thinning in `sweep()` (hour: all; day: hourly; 30 days: daily; then weekly; `before_action`/`restore`
      90 days first). Tiers are settings with floors. Test with injected clocks; test that `save` never deletes.
      `retention.rs`; settings and floors under Decisions.
- [x] `restore(version)` → new version of the current text first, then replace content. (package 00)

### Lists, filters, search (M1)
- [x] `list(ListQuery { folder, flagged_only, tags_all, tags_none, fts, sort, desc, flagged_top, cursor, limit })`
      with keyset paging on `(sort_key, id)`; flagged-top as two scans. Tests for every sort and cursor direction.
      `folder: None` is Inbox + Archive (two scans merged). Title sort needed an index (schema v2).
- [x] `search(q)` with FTS5 query sanitising (quote user input per token, support `tag:` and `is:flagged`
      prefixes parsed in Rust, not passed to FTS). `snippet()` for previews. Test odd input: `"`, `*`, `-`, `OR`.
      `query.rs` also parses `-tag:`, `in:` and `"phrases"`, which closes package 05's parser task.
- [x] Tags: `set_tags(draft, names)` normalises (lower-case, trim, dedupe), creates missing tags, removes orphans
      lazily in `sweep()`. `tag_counts(folder)`. Rename and merge tags.
- [x] Folder moves: `move(ids, folder)`, `flag(ids, bool)`, each returning an **undo token** that reverts the batch
      (same shape as Tern's outbox undo, without the outbox). `undo(token)`. `move_drafts`/`flag_drafts`.
- [x] `accessed_at` updated on open, debounced to once per minute per draft. (package 00; tested now)

### Trash and sweep (M1)
- [x] `sweep()` on start and daily: trash > 30 days → tombstone (`deleted_at`, content cleared, versions
      deleted); tombstones > 90 days → row deleted; orphan tags removed. Both periods are settings. Test with
      injected clocks. The shell runs it at start and every 24 h while open.
- [ ] "Empty trash" = tombstone now, with a confirm in the UI and no undo (said in the dialog). The engine half
      (`empty_trash`, the `empty_trash` command) is done; the dialog belongs to package 05's list UI.

### Later (M2)
- [ ] `links` table maintained on save from `[[Title]]`, `[[d:Title]]`, `[[u:UUID]]`; `backlinks(draft)`.
- [ ] `syntaxes` table for user grammars (package 02 decides the grammar format).
- [ ] `mirror` table for package 06.

## Acceptance (owner)
- [ ] 50k generated drafts: list scroll is instant, search for a rare word < 10 ms in the log, tag filter instant.
- [ ] Trash a draft, change the clock 31 days, restart: it is gone from the list, the row is a tombstone.
- [ ] Open the database with an older build: it refuses with a clear message; the backup exists.

How to check these before package 05's list UI exists: the first is `store_bench` (Results below); the second is
`cargo test -p petrel-core sweep_tombstones` (injected clock) until the list shows Trash; for the third, run this
branch's dev build once (the dev database migrates to v2 and `<data dir>/dev/backups/petrel-v1-*.db` appears), then
the `main` build: it refuses to open with "written by a newer Petrel (schema 2, this build knows 1)".

## Results

`store_bench` at 50,000 generated drafts (88 MB), release build, the agent's sandbox (4 vCPU), 2026-10-22. Package
00's rows are unchanged within noise. Each generated tag is on ~12 % of drafts; `rare` is a 50-draft tag the bench
adds.

| What | Target | p50 (p95) |
|---|---|---|
| list page, Inbox by modified | < 1 ms | 0.077 ms (0.108) |
| list page 200 via cursor | < 1 ms | 0.062 ms (0.111) |
| list by title / by created | < 1 ms | 0.059 / 0.053 ms |
| list, all folders / flagged first / flagged only | < 1 ms | 0.108 / 0.077 / 0.222 ms |
| list, one common tag / rare tag / without a tag | < 1 ms | 0.295 / 0.109 / 0.087 ms |
| list, two common tags | < 2 ms (see Decisions) | 1.49 ms (1.66) |
| list, text filter: stopword / mid word / rare word | < 10 ms | 2.85 / 1.43 / 0.76 ms |
| search, word + `tag:` / `is:flagged` + word | < 10 ms | 3.93 / 4.56 ms |
| search, stopword / short prefix (unchanged path) | < 10 ms | 2.14 / 4.41 ms |
| tag counts, Inbox | none in PLAN; guard 50 ms | 30.6 ms (42.8) |
| archive 50 + undo | < 5 ms | 4.19 ms (17.8; WAL checkpoints) |

## Decisions

- 2026-10-22 — **Schema v2 adds one index**, `drafts_title (folder, title COLLATE NOCASE, id)`. Sorting by title
  otherwise sorts a whole folder per page. The migration is the first real step, so it also exercises
  backup-before-migrate on a v1 fixture.
- 2026-10-22 — **Filters become id sets when small.** A tag on at most 2,000 drafts is fetched as ids, intersected
  in Rust, and the page is taken from that set: by rowid lookup and a sort when the set is tiny, by walking the sort
  index and testing membership otherwise (the crossover, `ids² × 25 < limit × drafts`, came from measuring both).
  A broader tag is tested per row with `EXISTS` on `draft_tags`' primary key while walking the sort index.
- 2026-10-22 — **A text filter in `list` is the newest 2,000 matches.** Testing FTS5 per row costs a query parse per
  row (12 ms at 5k drafts for a common word), and materialising every match of a stopword is too slow at 50k. So
  the list's `fts` uses the same newest-first window idea as `search` (owner-accepted for M1), with a 2,000 window.
  Exact for words in at most 2,000 drafts. Search with any filter (`tag:`, `is:flagged`, `in:`) goes through `list`
  and so gets this window, not the 400 one. Package 05's ranking task should revisit both windows together.
- 2026-10-22 — **Two broad tags together are the one list shape over 1 ms** (1.5 ms at 50k when both tags are on
  12 % of drafts: ~3,000 rows walked for a page). Intersecting the two index ranges first measured worse end to end
  (2.2 ms). The bench allows 2 ms for this row. At the owner's library size (a few thousand drafts) it is far under
  1 ms. **Owner:** accept, or ask for a per-tag count table (see the next item) to choose a cheaper plan.
- 2026-10-22 — **`tag_counts` is a GROUP BY, 31 ms at 50k** (1–2 ms at 2,000 drafts). Five query shapes were
  measured (24–63 ms); the cheapest drives from the folder index. It is called once per list change, off the typing
  path, as data-model.md planned. A trigger-maintained `tag_counts (tag_id, folder, n)` table would make it
  microseconds at the cost of triggers on `draft_tags` and on folder changes; not done unless the owner wants it.
- 2026-10-22 — **Undo tokens** live in memory (the newest 50, single use, gone on restart). Undo restores only the
  column the batch changed, and puts `modified_at` back only where it is still the batch's own time, so an edit
  made after the batch keeps its time. Drafts already in the target state are not touched and not counted.
- 2026-10-22 — **Moving and flagging change `modified_at`**, as data-model.md says ("content or metadata"). In the
  default modified sort an archived or flagged draft therefore jumps to the top of its new list. **Owner:** keep, or
  make folder/flag changes leave `modified_at` alone (trash age would then need its own `trashed_at`, a v3 column).
- 2026-10-22 — **Renaming or merging a tag leaves `modified_at` alone**, so a rename does not reshuffle the list.
  Rename keeps the tag's UUID; a merge keeps the target's.
- 2026-10-22 — **Retention settings** (`settings` keys, whole numbers; defaults → floors):
  `retention.trashDays` 30 → 1, `retention.tombstoneDays` 90 → 30, `retention.versionsAllHours` 1 → 1,
  `retention.versionsHourlyDays` 1 → 1, `retention.versionsDailyDays` 30 → 7 (and never less than the hourly tier),
  `retention.versionsProtectedDays` 90 → 30. Buckets are fixed UTC hours/days/weeks and keep the newest version in
  each, so a second sweep deletes nothing.

## Log

- 2026-10-22 — M1 slice on `claude/project-thread-1p0dru` (the session's branch; PR to `main`): `ListQuery` with
  folder/all, flags, tags all/none, text, four sorts both directions, flagged-top, keyset cursors; search filters
  parsed in Rust; tag counts, rename, merge; batch move/flag with undo tokens; version thinning and retention
  settings; schema v2 (title index) with a v1 fixture test; daily sweep in the shell; Tauri commands and `api.ts`
  (fake store too). 45 engine tests (21 before). Clippy `-D warnings` and fmt clean on the workspace. The fake-store
  UI was smoke-tested headless in `npm run dev` (Chromium via Playwright: typing saves, every new API call runs, no
  console errors); there is no list UI yet to try. The first 50k bench run found three slow shapes (text filter
  per row, small id sets walked, two tags); fixed or recorded under Decisions.
