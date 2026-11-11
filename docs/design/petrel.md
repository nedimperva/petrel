# Petrel: the design (2026-11-09)

Decided by the owner on 2026-11-09 and 2026-11-10. Canvas: https://claude.ai/artifact/2iMBXDeW8F2UVV1tLguc7g.
This replaces the Drafts-shaped plan (`docs/PLAN.md`, `docs/design/actions.md`, `docs/design/ui.md`).

## What Petrel is

A personal tool for quick notes and for keeping the things you copy often. Minimal, quick and good to look at.
It is not for sale; it may be open source later.

- **Capture.** A hotkey opens a small window; you type; `Esc` and it is saved to `inbox/`.
- **Open on a page.** The app opens on an empty writing page (or the note you left less than ten minutes ago).
  There is no home screen and no sidebar. Everything else is called: `Ctrl L` library, `Ctrl K` find or ask,
  `Ctrl J` AI.
- **The library is index cards.** `Ctrl L` shows a shelf: a row of Inbox cards, then a row per collection. The
  tabs in the title bar open one collection as a grid. A card looks like what it holds: a prompt shows its
  blanks as chips, a snippet is code, a song is lyrics. `Enter` opens a card on a sheet; blanks become fields on
  the right and `Enter` copies the filled text.
- **File it later.** An inbox card opened on the sheet has Move to (`m`), Suggest a home (`s`, Claude, only when
  pressed) and Delete (`d`). Moving files it into a note (added to the end) or a collection (as its own note).
- **Collections are folders.** Notes, Prompts, Snippets, Songs, a topic: any top-level folder except `inbox/`.
  The most copied come first.
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

Tern's colours: near-white paper `#fcfbf9`, warm greys, ink `#1f1e1b`, one blue accent `#2f4f9a`. Literata for
writing, Inter for the interface. Light and dark follow the system unless set in Settings. On Windows Petrel
draws its own 40 px title bar, as Tern does: library and new note on the left, the note's title (or the
library's tabs) in the middle, find and the window buttons on the right. On Linux the window manager draws the
frame. The writing page is the text alone; its footer (collection, words, saved) fades while you type. Tokens
are in `src/styles/tokens.css`.

## Windows

| Window | What it is |
|---|---|
| Main | The writing page, or the library (`Ctrl L`) over it. No home, no sidebar. |
| Capture | `Ctrl Alt Space`, `petrel --capture`. No frame. One line of footer: where it goes, `Tab` to choose, `Esc` done. |
| Quick picker | `Ctrl Alt V`, `petrel --picker`. No frame. Search, a peek pane, blanks filled inline, `Enter` copies and closes. |

On Wayland the compositor binds the keys: `bind = SUPER, N, exec, petrel --capture` and
`bind = SUPER, V, exec, petrel --picker`.

## Not yet

A local model as a second AI provider. A file watcher (the folder is rescanned when the window comes to the
front instead). A real-window check on Windows of this design.
