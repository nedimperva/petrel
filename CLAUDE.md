# Petrel: notes for agent sessions

Petrel is a local-first, keyboard-first text capture and actions app for Linux and Windows, in the shape of
Drafts (capture first, act later) and built like Tern (`github.com/nedimperva/tern`): a Rust engine
(`crates/petrel-core`), a Tauri 2 shell (`src-tauri`) and a SolidJS UI (`src`). The README covers layout, setup
and keys; this file covers state and decisions that aren't visible from the code.

## Where things stand (2026-10-22, package 00 merged)

- The workspace compiles: `petrel-core` (schema v1, migrations with backup-before-migrate, drafts, tags, versions,
  FTS search, sweep; 21 tests; `gen_store` and `store_bench` examples), `src-tauri` (five commands, single instance,
  logging, hidden-then-shown window), and the SolidJS UI (CodeMirror 6 Markdown editor, 300 ms autosave with flush on
  blur/hide/close, status strip, fake store for `npm run dev`). CI (`check.yml`) runs both OSes. Clippy
  `-D warnings` and fmt are clean. The speed table passes at 50k (package 00 Results).
- **Search is newest-first** (400 newest matches by rowid, then `modified_at`), not bm25-ranked; see package 00
  Decisions for the numbers. Snippets are made in Rust (`store::snippet`).
- **rquickjs is the scripting runtime** (owner decision 2026-10-22, package 03 Decisions); `bindgen` feature off.
  Newest-first search is accepted for M1; relevance ranking is a package 05 (M2) task.
  The spike is a standalone crate under `crates/petrel-core/examples/runtime_spike/`, not a workspace member.
- Not yet done by anyone: a boot on Hyprland, the Windows smoke test, the kill test, a packaged cold-start number.
  The agent's sandbox has no display and 3.9 GB of disk; it can run `cargo check`/clippy/tests but not the window.
- The owner has shipped Tern through its Linux beta on this stack. Reuse Tern's `check.yml`, `release.yml`,
  `update.rs`, `packaging/aur`, `tokens.css`, the palette and virtual list components, and the Linux/Windows
  notes. Do not copy anything from Drafts (Agile Tortoise); it is closed source and its name is a trademark.
  The design is from the owner's use and the public documentation; see `docs/research/drafts-reference.md`.

## Planning decisions (2026-10-22)

The owner approved `docs/PLAN.md`: safe foundation → Linux private alpha → focused Linux beta → Windows release →
expansion. Sprint numbers are work-package IDs, not weeks; read each package's Delivery scope first. The capture
path (launch → typing → saved) is the product; anything that slows it needs a measurement in the PR. Text is
never lost: versions before risk, tombstones instead of deletes, backup before migration. Scripting runs in a
Rust-hosted JavaScript runtime chosen by the M0 gate (expected rquickjs), never in the webview. Drafts
compatibility is the documented subset in `docs/design/actions.md`, nothing more.

## First steps for the next session

1. Read `docs/PLAN.md`, `docs/sprints/README.md`, then `docs/sprints/sprint-00-compile-and-boot.md` (Log first).
2. Package 01's M1 slice (list filters, tags, undo tokens, version tiers) on `sprint/01-list-and-tags`, then
   package 02 (editor commands, open-to-new-draft, capture window) and package 05's list UI.
3. Owner, when convenient: `scripts/kill-test.sh`, the Windows smoke list, laptop `store_bench` numbers.

## Design decisions to keep

- **Local-first, no service.** The UI reads SQLite only. No account, no telemetry, no sync before M4, and sync will
  be files the user controls.
- **The stored draft is untouched by a failed action.** Steps edit a working copy; commit happens after the last
  step; a version is taken before every run. See the run algorithm in `docs/design/actions.md`.
- **Everything outside the database goes through `Host`.** Clipboard, URLs, files, shell, keyring, HTTP, prompts.
  The same action runs from the window (`TauriHost`), the CLI (`CliHost`) and tests (`RecordingHost`).
- **Permissions are per action and checked at the call.** `allowShell`, `allowFiles`, `allowHttp`; first shell or
  out-of-scope file use confirms with the rendered command/path. Secrets in the keyring (service `petrel`) only.
- **Templates are the user's language.** `[[tag]]`, `[[tag|arg]]`, `\[[`; unknown tags are preserved and logged.
- **Keyset paging, never OFFSET.** `title` and `preview` are stored at save time; list queries never derive them.
- **An empty new draft is not a row.** The row is created on the first keystroke.
- **Debug builds use `<data dir>/dev/petrel.db`**, never the installed database (migrations are forward-only).
- **Markdown preview is untrusted HTML** in a sandboxed iframe with a CSP, as Tern treats mail.

## Linux / Omarchy notes

Same as Tern's: Arch packages (`webkit2gtk-4.1 libayatana-appindicator librsvg gnome-keyring libsecret`),
`WEBKIT_DISABLE_DMABUF_RENDERER=1` default on Linux, Hyprland tiles new windows (float rule for `petrel-capture`
documented in the README), global shortcuts are the compositor's job on Wayland (`bind = SUPER, N, exec, petrel
--capture`), a keyring must be running for `Credential`.

## Conventions

- Rust: `anyhow::Result` in the engine; commands return `Result<T, String>`; serde `camelCase` on the wire; store
  methods synchronous behind a `Mutex`, `spawn_blocking` when slow.
- UI: SolidJS signals, no state library; keyboard handling in `App.tsx`; tokens only; JS bundle budget 300 kB gz
  including CodeMirror (lazy-load languages and the preview).
- Comments explain why, not what. Short, plain sentences in docs and UI text.

## Roadmap

`docs/PLAN.md` (milestones), `docs/sprints/` (work packages), `docs/research/` (reference, stack, data model),
`docs/design/` (actions and scripting spec, UI spec), `docs/acceptance/` (owner checklists). Work on a
`sprint/NN-name` branch and open a PR to `main`; `main` must always build.
