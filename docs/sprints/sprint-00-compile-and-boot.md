# Sprint 0 — Compile and boot

**Status:** not started

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
- [ ] Cargo workspace: `crates/petrel-core`, `src-tauri`. `rust-toolchain.toml` (stable), `rustfmt.toml`,
      `.editorconfig`, `.gitattributes` copied from Tern. `.gitignore` extended for Node/Tauri/`dist`.
- [ ] `package.json` with Vite + SolidJS + TypeScript, `npm run dev|build|tauri`. `index.html`, `src/App.tsx`.
- [ ] `src-tauri/tauri.conf.json`: identifier `io.github.nedimperva.petrel`, product name Petrel, window class
      `petrel`, min 720×480, `withGlobalTauri` off, CSP set (self only; preview iframe gets its own).
- [ ] App icon: a petrel silhouette in the same style as Tern's icon (`docs/acceptance/app-icon.md` pattern).
      Placeholder is acceptable for M0; the owner approves the final one before M2 packaging.
- [ ] `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` (empty "Unreleased").
- [ ] `.github/workflows/check.yml` from Tern (ubuntu-24.04 + windows-2022; npm build, fmt, clippy `-D warnings`,
      tests, `store_bench` with `PETREL_BENCH_SLACK=3`). `security.yml` (cargo audit / npm audit weekly).

### Core skeleton (`petrel-core`)
- [ ] `store.rs`: open/create at `<data dir>/petrel.db` (debug: `<data dir>/dev/petrel.db`), WAL, `SCHEMA` v1 from
      [data-model.md](../research/data-model.md), `migrate()` with backup-before-migrate and a refusal of newer
      databases. Test: fresh create, reopen, newer-version refusal, backup file exists after a migration.
- [ ] `Store::new_draft()`, `save(id, content, cursor)`, `open(id)`; title/preview derivation with tests
      (empty draft, heading marks, very long first line, CRLF).
- [ ] `examples/gen_store.rs`: N drafts with realistic sizes and tags (Lorem + Markdown), seeded RNG.
- [ ] `examples/store_bench.rs`: the table from PLAN.md "Performance evidence" (list page, search, open, save)
      at 50k; exits non-zero on a missed target × slack.

### Shell skeleton (`src-tauri`)
- [ ] Commands: `new_draft`, `open_draft`, `save_draft`, `app_info`. `Result<T, String>` to the UI, serde camelCase.
- [ ] Single-instance plugin; a second launch focuses the window.
- [ ] Linux: `WEBKIT_DISABLE_DMABUF_RENDERER=1` default in `main.rs` (opt-out with `=0`).
- [ ] Log file at `<data dir>/petrel.log` (tracing, daily rotation, 7 files).

### UI skeleton (`src`)
- [ ] `tokens.css` copied from Tern; dark/light from the system.
- [ ] CodeMirror 6 editor with the Markdown language, soft wrap, placeholder. Measure the bundle (`npm run build`
      prints gzip sizes); record it in Results.
- [ ] Autosave: debounce 300 ms, flush on blur, on window close and on `visibilitychange`; the status strip
      shows saved/saving. **Kill test:** type, `kill -9` the process within 300 ms, restart, at most the last burst
      is missing. Scripted as `scripts/kill-test.sh` for Linux; manual on Windows.
- [ ] Without Tauri (`npm run dev`), the UI runs against a fake store in memory with 50 drafts.

### Windows smoke test (owner)
- [ ] Builds with MSVC; window opens; typing is saved; keyring smoke (`keyring` crate write/read) passes;
      WebView2 IME check with a non-Latin layout; DPI 150 % renders crisply.

### Decision gate — scripting runtime
See [package 03](sprint-03-action-engine.md) task "Runtime spike"; its result is an M0 exit criterion.

## Acceptance (owner)
- [ ] `cargo test --workspace` and `npm run build` green on both CI runners.
- [ ] Hyprland: window opens, tiles, types, saves; floating rule documented in the README.
- [ ] Kill test passes on Omarchy; Windows smoke list above passes.
- [ ] `store_bench` table recorded in Results with the laptop's numbers.

## Results

| What | Target | Measured |
|---|---|---|
| list page @50k | < 1 ms | |
| search @50k | < 10 ms | |
| open | < 5 ms | |
| save | < 2 ms | |
| JS bundle (gz) | < 300 kB | |
| cold start (packaged) | < 300 ms | |

## Decisions

## Log
