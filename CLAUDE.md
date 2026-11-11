# Petrel: notes for agent sessions

Petrel is a personal, local-first, keyboard-first notes and quick-capture app for Linux and Windows. Notes are
Markdown files in one folder; a Rust engine (`crates/petrel-core`) indexes them in SQLite, a Tauri 2 shell
(`src-tauri`) adds windows, tray, hotkeys and AI, and a SolidJS UI (`src`) draws it. The README covers setup and
keys; `docs/design/petrel.md` is the design; this file covers state and decisions that aren't visible from the code.

## Where things stand (2026-11-11)

- **Redesign implemented (owner decisions 2026-11-09/10, canvas https://claude.ai/artifact/2iMBXDeW8F2UVV1tLguc7g),
  on a PR based on the notes PR (#9).** No actions, no drafts UI, no `petrel://` links, no `petrel run`: those
  modules were deleted (`action.rs`, `host.rs`, `template.rs`, `store_actions.rs`, `src/actions/`, `src/list/`,
  the deep-link plugin). Captures are notes in `inbox/` (`capture_note`); collections are top-level folders; copy
  with `{{blanks}}`; quick picker window (`Ctrl Alt V`, `petrel --picker`, `src/Picker.tsx`); AI in
  `src-tauri/src/ai.rs` (Messages API over `ureq`, key in the keyring) with the rewrite preview in
  `src/note/aiPreview.ts`. Old drafts are exported once to `inbox/` and `drafts/` at start (`export_drafts_once`).
- **Second look (2026-11-11, owner rejected the first one as not minimal enough):** frameless windows with
  Petrel's own title bar on Windows (`src/TitleBar.tsx`; Linux gets the WM frame back in `main.rs` setup);
  the app opens on a writing page in `inbox/` (or the last note if left under 10 min ago, setting `last.note`);
  no Home, Inbox or Collection pages; the library is cards on `Ctrl L` (`src/library/`: shelf, collection
  grid, `Sheet.tsx` for an opened card with blank fields). Tern's colours in `tokens.css`.
- Tried headless: the debug build boots under `xvfb-run -a dbus-run-session` (capture, `--new`, `--stdin` and the
  picker work); the UI was driven with Playwright against the fake store (`src/fake.ts`). Not tried: a real
  window on Windows (title bar dragging, window buttons, frameless capture), AI with a real key.
- The drafts tables (schema up to v4) stay in the database so old data can be exported; nothing new writes them.
- Open owner questions: light or dark by default (both exist, system default), whether the warm look is right,
  whether `Ctrl Alt V` suits him, a local model.

## Design decisions to keep

- **Files are the truth.** The UI never treats SQLite as the source; it can be rebuilt from the folder. Atomic
  writes, conflict copies when the file changed on disk, `.trash/` instead of deletes, a version before risk.
  Rules in `docs/design/notes.md`.
- **AI runs only when the owner asks.** No background calls, no suggestions he did not press a key for. A
  rewrite is shown beside the old text and changes nothing until Keep; a version (`ai`) is taken first.
- **AI calls go from Rust, never the webview.** Key in the keyring (service `petrel`, user
  `anthropic-api-key`); debug builds may read `ANTHROPIC_API_KEY`. Never log or store the key elsewhere.
- **Copy is the only action.** Plain, Markdown, formatted (HTML). Blanks are `{{name}}`, `{{name|default}}`, `\{{`.
- **Local-first, no service.** No account, no telemetry. Sync is the folder (Google Drive or similar).
- **Debug builds use `<data dir>/dev/petrel.db`** and `<data dir>/dev/notes`, never the installed ones.
- **Markdown never becomes trusted HTML in the app.** Answers are escaped before formatting (`answerHtml`).

## Linux / Omarchy notes

Same as Tern's: Arch packages (`webkit2gtk-4.1 libayatana-appindicator librsvg gnome-keyring libsecret`),
`WEBKIT_DISABLE_DMABUF_RENDERER=1` default on Linux, Hyprland tiles new windows (float rule for `petrel-capture`
documented in the README), global shortcuts are the compositor's job on Wayland (`bind = SUPER, N, exec, petrel
--capture`, the same for `--picker`), a keyring must be running for the AI key.

## Conventions

- Rust: `anyhow::Result` in the engine; commands return `Result<T, String>`; serde `camelCase` on the wire; store
  methods synchronous behind a `Mutex`, `spawn_blocking` when slow.
- UI: SolidJS signals, no state library; keyboard handling in `App.tsx`; tokens only; JS bundle budget 300 kB gz
  including CodeMirror (225 kB on 2026-11-10).
- Comments explain why, not what. Short, plain sentences in docs and UI text.

## Roadmap

`docs/design/petrel.md` is the current design. `docs/PLAN.md`, `docs/sprints/` and `docs/design/actions.md` are
the old Drafts-shaped plan, kept for history. Work on a branch and open a PR to `main`; `main` must always build.
