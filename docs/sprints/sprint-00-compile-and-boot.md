# Sprint 0 — Compile and boot

**Status:** review · PR #1 · started 2026-10-22

## Delivery scope

**M0.** Everything here is required for the foundation gate: a workspace that builds and tests on Linux and
Windows CI, boots on Hyprland, passes a WebView2 smoke test, never loses typed text, and has a bench harness.
No product UI beyond "a window with an editor that saves".

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Goal

`npm run tauri dev` opens a window with a CodeMirror editor; what you type is in `petrel.db` within 300 ms;
`kill -9` loses at most the last 300 ms; CI is green on both OSes; `store_bench` prints the speed table.

## Tasks

### Repository
- [x] Cargo workspace: `crates/petrel-core`, `src-tauri`. `rust-toolchain.toml` (stable), `rustfmt.toml`,
      `.editorconfig`, `.gitattributes` copied from Tern. `.gitignore` extended for Node/Tauri/`dist`.
- [x] `package.json` with Vite + SolidJS + TypeScript, `npm run dev|build|tauri`. `index.html`, `src/App.tsx`.
- [x] `src-tauri/tauri.conf.json`: identifier `io.github.nedimperva.petrel`, product name Petrel, window class
      `petrel`, min 720×480, `withGlobalTauri` off, CSP set (self only; preview iframe gets its own).
- [x] App icon: a petrel silhouette in the same style as Tern's icon (`docs/acceptance/app-icon.md` pattern).
      Placeholder is acceptable for M0; the owner approves the final one before M2 packaging.
- [x] `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` (empty "Unreleased").
- [x] `.github/workflows/check.yml` from Tern (ubuntu-24.04 + windows-2022; npm build, fmt, clippy `-D warnings`,
      tests, `store_bench` with `PETREL_BENCH_SLACK=3`). `security.yml` (cargo audit / npm audit weekly).

### Core skeleton (`petrel-core`)
- [x] `store.rs`: open/create at `<data dir>/petrel.db` (debug: `<data dir>/dev/petrel.db`), WAL, `SCHEMA` v1 from
      [data-model.md](../research/data-model.md), `migrate()` with backup-before-migrate and a refusal of newer
      databases. Test: fresh create, reopen, newer-version refusal, backup file exists after a migration.
- [x] `Store::new_draft()`, `save(id, content, cursor)`, `open(id)`; title/preview derivation with tests
      (empty draft, heading marks, very long first line, CRLF).
- [x] `examples/gen_store.rs`: N drafts with realistic sizes and tags (Lorem + Markdown), seeded RNG.
- [x] `examples/store_bench.rs`: the table from PLAN.md "Performance evidence" (list page, search, open, save)
      at 50k; exits non-zero on a missed target × slack.

### Shell skeleton (`src-tauri`)
- [x] Commands: `new_draft`, `open_draft`, `save_draft`, `app_info`. `Result<T, String>` to the UI, serde camelCase.
- [x] Single-instance plugin; a second launch focuses the window.
- [x] Linux: `WEBKIT_DISABLE_DMABUF_RENDERER=1` default in `main.rs` (opt-out with `=0`).
- [x] Log file at `<data dir>/petrel.log` (env_logger to stderr and the file; truncated past 5 MB — rotation is a
      backlog line, not an M0 need).

### UI skeleton (`src`)
- [x] `tokens.css` copied from Tern; dark/light from the system.
- [x] CodeMirror 6 editor with the Markdown language, soft wrap, placeholder. Measure the bundle (`npm run build`
      prints gzip sizes); record it in Results.
- [x] Autosave: debounce 300 ms, flush on blur, on window close and on `visibilitychange`; the status strip
      shows saved/saving. Built; the UI was tried against the fake store in `npm run dev` only (the agent's sandbox
      has no display). **Kill test:** `scripts/kill-test.sh` is written; the owner runs it on Omarchy (acceptance).
- [x] Without Tauri (`npm run dev`), the UI runs against a fake store in memory with 50 drafts.

### Windows smoke test (owner)
- [ ] Builds with MSVC; window opens; typing is saved; keyring smoke (`keyring` crate write/read) passes;
      WebView2 IME check with a non-Latin layout; DPI 150 % renders crisply.

### Decision gate — scripting runtime
- [x] Spike built and measured (`crates/petrel-core/examples/runtime_spike/`); write-up under Decisions in
      [package 03](sprint-03-action-engine.md). Owner's answer pending.

## Acceptance (owner)
- [ ] `cargo test --workspace` and `npm run build` green on both CI runners.
- [ ] Hyprland: window opens, tiles, types, saves; floating rule documented in the README.
- [ ] Kill test passes on Omarchy; Windows smoke list above passes.
- [ ] `store_bench` table recorded in Results with the laptop's numbers.

## Results

Measured 2026-10-22 in the agent's sandbox (4 vCPU, Ubuntu 24.04, release build, 50,000 generated drafts,
85 MB database). The laptop's numbers replace these when the owner runs `store_bench`.

| What | Target | Measured p50 (p95) |
|---|---|---|
| list page (50 rows) @50k | < 1 ms | 0.040 ms (0.043) |
| list page 2 via cursor | < 1 ms | 0.081 ms (0.085) |
| search, stopword (in ~98 % of drafts) | < 10 ms | 2.4 ms (2.7) |
| search, two common words | < 10 ms | 2.1 ms (2.2) |
| search, rare word | < 10 ms | 1.0 ms (1.1) |
| search, two-letter prefix | < 10 ms | 4.0 ms (4.2) |
| open a draft | < 5 ms | 0.036 ms (0.056) |
| autosave write | < 2 ms | 0.087 ms (0.308) |
| folder count | < 5 ms | 0.85 ms (0.90) |
| JS bundle (gz) | < 300 kB | 183.5 kB JS + 9.1 kB CSS (CodeMirror + Markdown grammar is ~170 kB of it) |
| cold start (packaged) | < 300 ms | not measurable in the sandbox; owner |

## Decisions

- 2026-10-22 — **Search is newest-first, not relevance-ranked.** FTS5 walks a term's matches in descending rowid
  order and stops early (microseconds for any word), while `bm25` costs ~0.5 µs per match and reached 21 ms for a
  word in most drafts; per-row `snippet()` cost 0.9 ms each. `Store::search` takes the 400 most recently created
  matches, orders them by `modified_at`, and makes snippets in Rust. Exact for terms in fewer than 400 drafts;
  "the newest drafts with that word" for more common ones. Relevance ranking can be an option in package 05 if
  wanted. Recorded in `docs/research/data-model.md`.
- 2026-10-22 — **A backup is one file.** The SQLite backup API copies the WAL header flag, so the copy was in WAL
  mode and left `-wal`/`-shm` sidecars; the copy is switched to `journal_mode=DELETE` after the backup.
- 2026-10-22 — **The agent's sandbox cannot run the window.** 3.9 GB of disk, no display. `cargo check`/clippy of
  the shell pass locally; the Tauri build and the kill test run in CI and on the owner's machines respectively.
- 2026-10-22 — Tauri's `tauri icon` also emits Android/iOS sets; they are deleted (mobile is not a target).

- 2026-10-22 — **Windows CI found two things Linux hides.** `remove_dir_all` fails while a `Store` is alive
  (Windows will not delete an open file), and deleting a just-written backup can hit a sharing violation (the
  indexer or Defender has it) — the prune now retries five times with backoff. CodeQL needs Advanced Security on a
  private repository; the job is skipped until Petrel is public.

## Log

- 2026-10-22 — Skeleton built: workspace, core with schema v1 + migrations + backup, 21 tests, `gen_store`,
  `store_bench` green, Vite/SolidJS/CodeMirror UI with autosave and the fake store, Tauri shell with five
  commands, single instance, logging; CI workflows; runtime spike measured (QuickJS vs Boa). Search needed a
  redesign to meet its target (Decisions). Clippy `-D warnings` and fmt clean on the whole workspace. Open: owner's
  Hyprland boot, Windows smoke, kill test, runtime decision.
- 2026-10-22 — First CI run: Linux green; Windows failed two tests (file handles, Decisions); CodeQL cannot run on a
  private repo. All three fixed. Third run: **both OSes green** (Linux and Windows: frontend build, fmt, clippy
  `-D warnings`, 21 tests, `store_bench` within slack on the shared runner). The second Windows failure was the test
  itself holding a backup open.
