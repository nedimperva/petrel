# Petrel: the design (2026-11-09)

Decided by the owner on 2026-11-09 and 2026-11-10. Canvas: https://claude.ai/artifact/2iMBXDeW8F2UVV1tLguc7g.
This replaces the Drafts-shaped plan (`docs/PLAN.md`, `docs/design/actions.md`, `docs/design/ui.md`).

## What Petrel is

A personal tool for quick notes and for keeping the things you copy often. Minimal, quick and good to look at.
It is not for sale; it may be open source later.

- **Capture.** A hotkey opens a small window; you type; `Esc` and it is saved to `inbox/`.
- **File it later.** The inbox shows captures as sticky notes. `m` files one into a note (added to the end) or a
  collection (as its own note). Claude can suggest homes, but only after you press `s`.
- **Collections are folders.** Notes, Prompts, Snippets, Songs, a topic: any top-level folder except `inbox/`.
  A collection page shows its notes as cards; the most copied come first.
- **Copy is the action.** There are no actions. Copy, Copy as Markdown and Copy formatted (HTML for mail and
  docs) are `Ctrl K` commands. `{{name}}` and `{{name|default}}` in a note are blanks filled in as you copy;
  `\{{` is a literal. The quick picker (`Ctrl Alt V`) does the same from any app and closes, so the paste goes
  where you were.
- **AI only when asked.** Nothing is sent until you press a key for it. On a note, `Ctrl J` (or `/` on an empty
  line): tidy, shorten, make a list, a checklist, continue, or a custom ask. Select text and pick Explain for a
  popover. `Ctrl K` with a question answers from your notes and shows the notes it used. Also: summarize, a title,
  related notes, where to file a capture.

## Rules

- **Files are the truth.** Every note is a `.md` file in one folder the owner picks, ideally inside Google
  Drive. SQLite (`notes`, `notes_fts`) is only an index and can be rebuilt. Writes are atomic. If the file
  changed on disk since it was opened, the other text is kept as a conflict copy next to it. See `notes.md`.
- **A rewrite never replaces text silently.** The AI result is shown next to the old text, struck through. The
  editor is read-only until Keep (`Enter`), Drop (`Esc`) or Try again (`R`). On Keep a version (`ai`) is taken
  first.
- **Text is never lost.** Autosave (300 ms, flushed on blur, hide and close), versions (`Ctrl H`), deletes go
  to `.trash/` in the folder, undo with `z` or the toast.
- **The key is the owner's.** An Anthropic API key in Settings, kept in the OS keyring (service `petrel`, user
  `anthropic-api-key`). A debug build also reads `ANTHROPIC_API_KEY`. Calls go from Rust (`src-tauri/src/ai.rs`)
  straight to the Messages API, never from the webview. The model can be changed with the `ai.model` setting.
- **Old drafts are not dropped.** On first start the drafts in the database are written once to `inbox/`
  (Inbox) and `drafts/` (archive). Trash is not exported.

## Look

Warm paper, an ink colour for text, indigo `#5b5bd6` as the one accent. Literata for writing, Inter for the
interface. Light and dark follow the system unless set in Settings. The writing page is the text alone, with a
quiet footer of hints. Tokens are in `src/styles/tokens.css`.

## Windows

| Window | What it is |
|---|---|
| Main | Home (ask field, inbox strip, collections, recent notes), Inbox, a collection, a note. |
| Capture | `Ctrl Alt Space`, `petrel --capture`. One line of footer: where it goes, `Tab` to choose, `Esc` done. |
| Quick picker | `Ctrl Alt V`, `petrel --picker`. Search, a peek pane, blanks filled inline, `Enter` copies and closes. |

On Wayland the compositor binds the keys: `bind = SUPER, N, exec, petrel --capture` and
`bind = SUPER, V, exec, petrel --picker`.

## Not yet

A local model as a second AI provider. A file watcher (the folder is rescanned when the window comes to the
front instead). A real-window check on Windows of this design.
