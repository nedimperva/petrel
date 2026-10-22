# Sprint 5 — List, search, workspaces

**Status:** in progress · started 2026-10-22 (list panel on PR #2)

## Delivery scope

**M1:** the draft list panel, folders, flag, tags, FTS search, batch select with undo, the command bar.
**M2:** workspaces (saved filters with sort and action group), tag management, saved searches. The permanent
left-list layout option is M2 if cheap, else backlog.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Goal

Find any draft in two keystrokes and a word. Triage a week of captures in a minute without the mouse.

## Tasks

### List (M1)
- [ ] Virtualised list over `Store::list` with keyset paging (reuse Tern's list component shape).
      Started: keyset paging loads 100 rows at a time as you scroll or move near the end; the rows are plain DOM,
      not virtualised. Fine for a few thousand drafts; Tern's component is still to port.
- [x] Filters header: Inbox / Flagged / Archive / Trash / All; tag chips with counts; `/` search box.
      Tabs also by `g i/f/a/t/l`; a chip toggles a tag filter; tab and chip are added to the search as `in:`/`tag:`.
- [x] `j k Enter x e # f t z`; batch operations with one undo token; `Esc` returns to the editor on the same draft.
      In Archive `e` moves back to Inbox, in Trash `#` restores. `t` adds tags (`Store::add_tags`, undoable). `Del` in
      Trash asks to empty it (inline bar, no undo, said in the bar). Tried in `npm run dev` only (headless Chromium).
- [ ] Relative times (`tnum`), flag dot, preview snippet; density setting. All but the density setting.
- [ ] Sidebar (`Ctrl 1`): folders with counts, tags, workspaces.

### Search (M1)
- [x] Query parser: free words → FTS, `tag:x`, `-tag:x`, `is:flagged`, `in:archive`, `"exact phrase"`; the rest
      quoted token by token so FTS syntax errors cannot happen. Tests. Done in package 01
      (`crates/petrel-core/src/query.rs`, `Store::search`).
- [ ] Results ranked by `bm25` then `modified_at`; snippet highlight; `Enter` opens and places the cursor at
      the first match.
- [ ] Search is live (debounced 80 ms) and measured in the status strip in debug builds. Live and debounced; not
      measured in the strip yet. Search hits show no flag dot (`SearchHit` has no flag).

### Command bar (M1)
- [ ] Tern's palette component: commands, actions, drafts (by title, FTS-backed), tags, workspaces; recents.

### Relevance ranking (M2, owner request 2026-10-22)
- [ ] A ranked mode for search that keeps the 10 ms target: `bm25` only over a bounded window (the newest N matches,
      N tuned by measurement) or only when a term has fewer than N matches, with the newest-first order otherwise.
      Decide the default (newest vs. ranked) with the owner after trying both on a real library.

### Workspaces (M2)
- [ ] CRUD in the sidebar; fields per the schema; applying one sets filters, sort, flagged-top and the active action
      group; `Esc` clears; `[[w:Name]]` links apply one.
- [ ] Tag management panel: rename, merge, delete (with counts and a confirm).
- [ ] `layout: list-left` setting if the component split allows it within the bundle budget.

## Acceptance (owner)
- [ ] With 2,000 real drafts, every filter and search feels instant; the strip's measured time agrees.
- [ ] A "Journal" workspace (tag `journal`, sort created, group "Journal") switches everything with one command.

## Decisions

## Log

- 2026-10-22 — List panel (`src/list/DraftList.tsx`) on PR #2 while the owner is away: tabs, chips, live search,
  keyboard triage with undo, empty trash. Tried headless against the fake store (`npm run dev`, Chromium via
  Playwright): every key path ran, no console errors. Not tried in the Tauri window (no display in the sandbox).
  Bundle 197.6 kB gz (was 183.5; `@codemirror/search` and the list).
