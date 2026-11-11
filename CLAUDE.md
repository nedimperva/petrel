# Petrel: notes for agent sessions

Petrel is a personal, local-first, keyboard-first notes and quick-capture app for Linux and Windows. Notes are
Markdown files in one folder; a Rust engine (`crates/petrel-core`) indexes them in SQLite, a Tauri 2 shell
(`src-tauri`) adds windows, tray, hotkeys and AI, and a SolidJS UI (`src`) draws it. The README covers setup and
keys; `docs/design/petrel.md` is the design; this file covers state and decisions that aren't visible from the code.

## Where things stand (2026-11-11, night)

- **Coherence pass (owner asked 2026-11-11), branch `claude/project-thread-4an9hg`, PR to `main`:** the model and
  the key grammar are at the top of `docs/design/petrel.md` (write, find, copy; three kinds of screen; one meaning
  per key). Collections are pages or things to copy (`copy: yes|no` in `.petrel`, `toCopy` in
  `src/library/faces.ts`); the library's cards and the picker show only things to copy. `@` is the only capture
  routing sign. Ctrl J and `/` open one AI menu. Review is a mode of the library (`reviewing`), the week and history
  are panels like Ctrl K, Esc from a panel goes back to Ctrl K, conflicts are inbox cards. `KeyHints` in `ui.tsx`
  is the key line on every screen. On Hyprland `src-tauri/src/hypr.rs` floats, sizes, centres and pins the capture
  window and the picker through `hyprctl` (not tried on Linux).
- **The next look (owner approved 2026-11-11, canvas https://claude.ai/artifact/6YTYsvgRztVuzNvHvFP2GS, margin
  wider than drawn), same branch:** the sidebar (`src/Sidebar.tsx`: collections made, renamed, trashed through
  `Store::create_folder`/`rename_folder`/`trash_folder` in `crates/petrel-core/src/notes/folders.rs`), the right
  margin (`.note-margin`, a container query on `.page`), Ctrl L as a list and an inline `Sheet`, a quieter AI menu
  that scrolls, today's page opening on a timed new line. The picker's hotkey is `Ctrl Shift Space` (Ctrl Alt V
  was AltGr V, `@` on the owner's Bosnian keyboard); the note beside is `Ctrl Shift Enter`.

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
- **Next ideas (owner picks 2026-11-11, canvas https://claude.ai/artifact/Sw6CPjnpGXY6Vz9LnVCQ5d), branch
  `next-ideas`:** capture routing (`#topic`, `#today`, `>Note`, `src/inbox/route.ts`), the selection as a quote
  (`src-tauri/src/context.rs`: UI Automation on Windows, primary selection + hyprctl on Linux), pictures in
  `<folder>/attachments/` carried on move and merge, inbox review (`src/inbox/Review.tsx`), collection looks in
  `<top>/.petrel`, `p` pins, Ctrl K filters, today's page (`journal/`, `src/journal/`), Linen and clock paper, a
  writing font, the petrel, an optional typing sound, the week on Ctrl J (`ai_week`). Left out by the owner: one line
  from a terminal, the greeting page. Not tried: the selection quote and the browser address in a real window on
  either OS. The owner chose to keep this work on `main` (no PR), 2026-11-11.
- **Twenty more (owner picks 2026-11-11, page https://claude.ai/artifact/Kan675aYKsn9pvSgDMGRqq), on `main`:**
  1, 2, 4–12, 14, 16–19 built; 3, 13, 15, 20 left out. Capture for a day (`dayWord`), keep going
  (`ui.capture.last`), clean paste (`src/editor/paste.ts`), headings in the margin (`src/note/outline.ts`), a note
  beside (`src/note/Beside.tsx`, `Ctrl \`), Back (`Ctrl Tab`, `ui.recent`), paragraph focus (`ui.focus`), blanks
  that fill themselves, choose and remember (`src/blanks.ts`, `src/collection/BlankFields.tsx`, `ui.blanks`),
  versions on one card (`src/collection/versions.ts`, `ui.versions`), picker counts per app (`copied_in.` settings,
  `picker_context`), your prompts on Ctrl J (AI task `prompt`), ask again (`ai_ask` with `earlier` and `notes`),
  the live folder (`src-tauri/src/watch.rs`, `Store::scan_paths`, event `petrel-folder`), settle a conflict
  (`Store::conflicts`/`settle_conflict`, `src/library/Settle.tsx`), open tasks (`Store::open_tasks`/`tick_task`,
  `src/palette/Tasks.tsx`). Engine submodules live in `crates/petrel-core/src/notes/`. Tried in a browser against
  the fake store; not tried: the watcher with Drive for desktop, `Ctrl \` on a Bosnian keyboard (it also matches
  the physical Backslash key), the picker's app ranking and `{{selection}}` in a real window.
- Resources read under App's `<Suspense>` suspend the whole page (focus leaves the editor): new screens use signals.
- Tried headless: the debug build boots under `xvfb-run -a dbus-run-session` (capture, `--new`, `--stdin` and the
  picker work); the UI was driven with Playwright against the fake store (`src/fake.ts`). Not tried: a real
  window on Windows (title bar dragging, window buttons, frameless capture), AI with a real key.
- The drafts tables (schema up to v4) stay in the database so old data can be exported; nothing new writes them.
- Open owner questions: light or dark by default (both exist, system default), whether the warm look is right,
  a local model.

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
  including CodeMirror (225 kB on 2026-11-10, 270 kB on 2026-11-11 after the twenty more, 276 kB with the fake store).
- Comments explain why, not what. Short, plain sentences in docs and UI text.

## Roadmap

`docs/design/petrel.md` is the current design. `docs/PLAN.md`, `docs/sprints/` and `docs/design/actions.md` are
the old Drafts-shaped plan, kept for history. Work on a branch and open a PR to `main`; `main` must always build.
