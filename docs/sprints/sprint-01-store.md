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
branch's dev build once (the dev database migrates to v3 and `<data dir>/dev/backups/petrel-v<old>-*.db` appears),
then the `main` build: it refuses to open with "written by a newer Petrel (schema 3, this build knows 1)".

## Results

`store_bench` at 50,000 generated drafts (88 MB), release build, the agent's sandbox (4 vCPU), 2026-10-22. Package
00's rows are unchanged within noise. Each generated tag is on ~12 % of drafts; `rare` is a 50-draft tag the bench
adds.

| What | Target | p50 (p95) |
|---|---|---|
| list page, Inbox by modified | < 1 ms | 0.077 ms (0.108) |
| list page 200 via cursor | < 1 ms | 0.062 ms (0.111) |
| list by title / by created | < 1 ms | 0.059 / 0.053 ms |
| list, Archive by created / Trash by title (v3, 2026-10-23) | < 1 ms | 0.114 / 0.396 ms |
| list, all folders / flagged first / flagged only | < 1 ms | 0.108 / 0.077 / 0.222 ms |
| list, one common tag / rare tag / without a tag | < 1 ms | 0.295 / 0.109 / 0.087 ms |
| list, two common tags | < 2 ms (see Decisions) | 1.49 ms (1.66); 1.2–1.4 ms on 2026-10-23 |
| list, text filter: stopword / mid word / rare word | < 10 ms | 2.85 / 1.43 / 0.76 ms |
| search, word + `tag:` / `is:flagged` + word | < 10 ms | 3.93 / 4.56 ms; 4.58 / 2.77 ms on 2026-10-23 |
| search, stopword / short prefix (unchanged path) | < 10 ms | 2.14 / 4.41 ms |
| folder count | < 5 ms | 1.93 ms; 0.002 ms on 2026-10-23 (v3 counts) |
| tag counts, Inbox | none in PLAN; guard 50 ms | 30.6 ms (42.8); 0.012 ms on 2026-10-23 (v3 counts) |
| archive 50 + undo | < 5 ms | 4.19 ms (17.8; WAL checkpoints); 1.94 ms (3.13) on 2026-10-23 |

The database is 92.7 MB at 50k with v3 (88.0 before: `drafts_list` carries three more keys).

The owner's Windows machine (`D:\GitHub\petrel`, 2026-10-23, before the v3 changes) missed five rows, p50 (p95):
two common tags 2.01 (2.08) ms, search flagged only 10.5 (12.6) ms, folder count 6.5 (8.3) ms, tag counts 84
(225) ms, archive 50 + undo 19.4 (1,022) ms. Generation took 27 s against 7 s here, so writes there cost ~4× this
sandbox and reads ~1.3–2×. Decisions of 2026-10-23 below are the response; a rerun there is pending.

## Decisions

- 2026-10-23 — **WAL checkpoints run on their own thread.** SQLite's default makes the write that crosses 1,000
  WAL pages copy the WAL into the database and fsync both, inline: the 1,022 ms p95 on Windows. A checkpointer
  thread with its own connection runs a PASSIVE checkpoint every 2 s (no lock a writer waits for; nothing to do
  when the WAL is clean), and the main connection's `wal_autocheckpoint` is raised to 4,000 pages as a backstop.
  Power-cut exposure under `synchronous = NORMAL` drops from up to 1,000 pages of writes to about 2 s; an app crash
  loses nothing either way.
- 2026-10-23 — **Schema v3: only `drafts_list` leads with the folder.** A folder change moved a draft's entry in
  the title, created and accessed indexes to another part of each tree, so archiving 50 scattered drafts wrote 234
  pages (and 330 with v2's title index scattered too) and the undo as many. Without the folder in those indexes a
  move writes ~58 pages. The three sorts check the folder per row while walking (~1.6 µs a row), or, for a
  folder smaller than `√(8 × page × drafts)` (~4,500 at 50k), sort it whole from `drafts_list`, which now also
  carries title, created and accessed so that sort reads no table rows (~0.2 µs a draft; a page of Trash by
  title went 1.5 → 0.2 ms with it). Its entry is rewritten on every save and move anyway, so the extra columns
  cost index bytes, not writes. Worst case is a folder near the crossover: ~1 ms at 50k.
- 2026-10-23 — **Schema v3: trigger-kept `folder_counts` and `tag_counts (tag_id, folder, n)`.** Counting rows was
  6.5 ms (folder) and 84 ms (tags) on Windows. The triggers fire only on what changes counts (insert, folder or
  `deleted_at` change, delete of a live row, tag link insert/delete), so autosave does not pay for them. The
  migration counts once. Tag counts also let `list` know a tag is broad without fetching its ids, and check the
  rarest broad tag first.
- 2026-10-23 — **Flagged-only with another filter adds the flagged ids to the intersection** (an index-only read
  of `drafts_flagged`). Walking the sort index tested every row of a folder when few of the set were flagged.

- 2026-10-22 — **Schema v2 adds one index**, `drafts_title (folder, title COLLATE NOCASE, id)` (v3 drops the folder). Sorting by title
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
  1 ms. Accepted as the default while the owner is away (2026-10-22). With v3's counts it is 1.2–1.4 ms here.
- 2026-10-22 (superseded by v3 on 2026-10-23) — **`tag_counts` is a GROUP BY, 31 ms at 50k** (1–2 ms at 2,000 drafts). Five query shapes were
  measured (24–63 ms); the cheapest drives from the folder index. It is called once per list change, off the typing
  path, as data-model.md planned. A trigger-maintained `tag_counts (tag_id, folder, n)` table would make it
  microseconds at the cost of triggers on `draft_tags` and on folder changes; not done unless the owner wants it.
- 2026-10-22 — **Undo tokens** live in memory (the newest 50, single use, gone on restart). Undo restores only the
  column the batch changed, and puts `modified_at` back only where it is still the batch's own time, so an edit
  made after the batch keeps its time. Drafts already in the target state are not touched and not counted.
- 2026-10-22 — **Moving and flagging change `modified_at`**, as data-model.md says ("content or metadata"). In the
  default modified sort an archived or flagged draft therefore jumps to the top of its new list. Kept for now (owner
  away; coordinator relayed "take the defaults", 2026-10-22); the alternative needs a v3 `trashed_at` column.
- 2026-10-22 — **Renaming or merging a tag leaves `modified_at` alone**, so a rename does not reshuffle the list.
  Rename keeps the tag's UUID; a merge keeps the target's.
- 2026-10-22 — **Retention settings** (`settings` keys, whole numbers; defaults → floors):
  `retention.trashDays` 30 → 1, `retention.tombstoneDays` 90 → 30, `retention.versionsAllHours` 1 → 1,
  `retention.versionsHourlyDays` 1 → 1, `retention.versionsDailyDays` 30 → 7 (and never less than the hourly tier),
  `retention.versionsProtectedDays` 90 → 30. Buckets are fixed UTC hours/days/weeks and keep the newest version in
  each, so a second sweep deletes nothing.

## Log

- 2026-10-23 — The owner's Windows bench missed five rows (Results). Schema v3 (folder-free title/created/accessed
  indexes, trigger-kept counts), the checkpointer thread, flagged-only intersection and count-based tag ordering
  fix all five here. 48 tests (two new: counts against row counts after a random walk of every write path, and a
  v2 database migrated to v3).

- 2026-10-22 — `add_tags(ids, names)` with undo for the list's `t` (46 tests). The list panel and editor keys
  (packages 05 and 02) went onto the same PR, since the session can push only one branch.
- 2026-10-22 — M1 slice on `claude/project-thread-1p0dru` (the session's branch; PR to `main`): `ListQuery` with
  folder/all, flags, tags all/none, text, four sorts both directions, flagged-top, keyset cursors; search filters
  parsed in Rust; tag counts, rename, merge; batch move/flag with undo tokens; version thinning and retention
  settings; schema v2 (title index) with a v1 fixture test; daily sweep in the shell; Tauri commands and `api.ts`
  (fake store too). 45 engine tests (21 before). Clippy `-D warnings` and fmt clean on the workspace. The fake-store
  UI was smoke-tested headless in `npm run dev` (Chromium via Playwright: typing saves, every new API call runs, no
  console errors); there is no list UI yet to try. The first 50k bench run found three slow shapes (text filter
  per row, small id sets walked, two tags); fixed or recorded under Decisions.
