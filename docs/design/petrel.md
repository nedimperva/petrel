# Petrel: the design (2026-11-09)

Decided by the owner on 2026-11-09 and 2026-11-10. Canvas: https://claude.ai/artifact/2iMBXDeW8F2UVV1tLguc7g.
This replaces the Drafts-shaped plan (`docs/PLAN.md`, `docs/design/actions.md`, `docs/design/ui.md`).

## The model (2026-11-11, the coherence pass)

Everything is a page. You do three things: **write**, **find**, **copy**. Every feature sits under one of them;
anything that does not stays hidden until asked for.

- **Write**: the page (which can split in two: a note beside), capture, today's page, paragraph focus, headings in
  the margin, clean paste, and AI on the text (`Ctrl J`, the one AI door; `/` on an empty line opens the same menu).
- **Find**: `Ctrl K`, the one door. Notes, commands, a question for your notes, the recent notes (Back), open tasks,
  the week. `Ctrl P` is `Ctrl K` on notes only. Panels it opens (tasks, the week, history, an answer) look and move
  the same, and `Esc` goes back to `Ctrl K`.
- **Where you are**: the sidebar (as in Tern): New note, Today, Inbox, Open tasks, then the collections to copy
  and the pages. Collections are made, renamed (`F2`), given a look, set to pages or to copy, and trashed there.
  Docked from 1000 px, over the page below; `Ctrl 0` hides it. The right margin (320 px) holds what is about the
  note: its headings, what links to it, related notes, the month on a day's page.
- **Copy**: the library and the quick picker are the same thing: what you copy. The library is a list beside the
  item, always open (canvas https://claude.ai/artifact/6YTYsvgRztVuzNvHvFP2GS). A collection is either
  **pages** (Travel, Journal: found with `Ctrl K`) or **to copy** (Prompts, Snippets: cards in the library and the
  picker). Set once per collection (`t`), kept in its `.petrel` file (`copy: yes`). The inbox is cards too, until filed.

Three kinds of screen, no more: the **page** (one or two notes), **one overlay** that grows into a panel (`Ctrl K`
and what it opens), and **the card sheet** (shared with the picker). No dialog opens on top of another; when
something closes, the focus goes back where it was; every overlay comes and goes with the same motion.

### The key grammar

| Key | Means, everywhere |
|---|---|
| `Enter` | do it (open, copy, keep, run, file) |
| `Esc` | back one step (close the panel, then the overlay, then the note beside) |
| `Tab` | the next field, and only that (`Shift Tab` the one before) |
| `Alt ←` `Alt →` | the sibling before or after: another day, another version |
| `↑` `↓` | move through a list |
| `1`–`9` | pick from a short numbered list (a place, a choice, a side to keep) |
| `Ctrl K` | find; `Ctrl P` notes only; `Ctrl J` AI; `Ctrl L` the library; `Ctrl 0` the sidebar; `Ctrl Tab` back |

No global hotkey is Ctrl Alt with a key: that is AltGr on many keyboards (AltGr V is `@` in Bosnian), so it would
take a character from every app. The picker is `Ctrl Shift Space`, the note beside `Ctrl Shift Enter`.

Every screen ends with the same one-line footer of its keys (`src/ui.tsx`, `KeyHints`). Every shortcut is listed in
`src/keys.ts`; Settings › Keys changes the app's own for this computer, `Ctrl /` (or `?` outside text) shows them all.

In the capture window `@` says where a capture goes: `@recipes` (a collection), `@today`, `@fri`, `@nov20` (a day),
`@Groceries` (a note). `#` is only ever a heading and `>` only a quote. Old `#word` and `>Note` routing is gone.

On Hyprland (Omarchy) Petrel makes the capture window and the picker float, centred and pinned to every
workspace itself, through `hyprctl`, when they open.

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
  `\{{` is a literal. The quick picker (`Ctrl Shift Space`) does the same from any app and closes, so the paste goes
  where you were.
- **AI only when asked.** Nothing is sent until you press a key for it. On a note, `Ctrl J` (or `/` on an empty
  line): tidy, shorten, make a list, a checklist, continue, or a custom ask. Select text and pick Explain for a
  popover. `Ctrl K` with a question answers from your notes and shows the notes it used. Also: summarize, a title,
  related notes, where to file a capture.

## Next ideas (chosen 2026-11-11)

Canvas: https://claude.ai/artifact/Sw6CPjnpGXY6Vz9LnVCQ5d. Out for now: one line from a terminal, the greeting page.

- **Capture with a word** (now `@`, see the model). `@recipes` (a top folder), `@today` or `@Groceries` (a note) in the capture window says
  where it goes; the list offers places as you type, the word is taken out, and a word left in the text still
  routes it when you press Esc (`src/inbox/route.ts`).
- **The quote comes along.** Text selected in the app in front when the capture key is pressed starts the capture
  as a quote, with the app and window title under it. Windows reads it through UI Automation (no faked key
  presses, the clipboard untouched, password fields skipped) and, in a browser, the page's address from its address
  bar; Linux reads the primary selection and asks Hyprland for the window, and an old selection is not brought in
  twice (`src-tauri/src/context.rs`). Off in Settings.
- **Pictures** pasted or dropped into a note go to `<folder>/attachments/` and are linked `![](attachments/x.png)`.
  Moving or merging a note into another folder takes its pictures along (one undo). Photos wider than 2000 px are
  made smaller unless Shift is held.
- **Inbox review**: one capture at a time, oldest first, numbers file it in the six places used most and lately
  (`ui.filed`), Space keeps it until the next day (`ui.review.later`), `s` asks Claude. Ends with "Inbox clear."
  and the petrel.
- **A look per collection**: a colour and a mark, kept in the folder's `.petrel` file so it syncs. `p` pins.
- **Ctrl K filters**: `in:`, `pinned`, `today`, `this week`, `has:link`, `has:picture`, `has:task`.
- **Today's page**: `Ctrl D`, `journal/YYYY-MM-DD.md`, made only when written on. Entries start with the time
  (`21:14 text`); captures filed there get it too, with `_from capture_` under them. The month sits beside the
  text on a wide window.
- **Small joys**: paper tones (Paper, Linen, Night, or follow the clock), a writing font (Literata, iA Writer
  Quattro, Charter, Inter, JetBrains Mono), a fading saved tick, filed cards slide away, a copied card flashes in its
  colour, an optional pencil sound. No streaks, no badges.
- **The week, when you ask**: counts and open tasks from the files, then a few sentences from Claude after Enter,
  which says first how many notes and words it will read. Enter keeps it as `journal/YYYY-Www.md`.

## Twenty more (chosen 2026-11-11)

Page: https://claude.ai/artifact/Kan675aYKsn9pvSgDMGRqq. Built: 1, 2, 4–12, 14, 16–19. Not now: 3, 13, 15, 20.

- **Capture for a day.** `@fri`, `@tomorrow`, `@nov20` (also `20nov`, `2026-11-20`, weekday names) file the
  capture on that day's page, under the time; offered as you type beside the folders. A weekday is the next one,
  not today; a date more than a month gone is next year's. A collection named like a day wins, except over
  `@today` (`dayWord` in `src/journal/days.ts`).
- **Keep going.** The capture window opened again within two minutes of the last capture shows it faded and adds
  the new text under it, in the same file (`ui.capture.last`). `Ctrl Enter` makes the new text its own capture.
- **Paste that stays clean.** Pasted HTML becomes Markdown: headings, lists, links (http, https, mailto), bold,
  italic, code, quotes; the rest is dropped to its words. Parsed with `DOMParser` (inert, nothing runs or loads),
  inserted as text only. The plain text goes in first, so `Ctrl Z` gives it back (`src/editor/paste.ts`).
- **Headings in the margin.** Three or more headings show in the right margin on a wide window, the current one
  marked; a click jumps; the list steps back while you type (`src/note/outline.ts`).
- **A note beside.** `Ctrl \` or `Shift Enter` on a `[[link]]`: a second note on the right, read-only until
  clicked, one at a time, `Esc` closes, "Open here" swaps. Never the same note on both sides (`src/note/Beside.tsx`).
- **Back.** `Ctrl Tab` goes to the note before; held, the last few to step through. The same list is `Ctrl K`'s
  empty state (`ui.recent`).
- **Paragraph focus.** A Settings switch and a `Ctrl K` line: the other paragraphs fade to about a third while the
  editor has the focus (`ui.focus`).
- **Blanks that fill themselves.** `{{clipboard}}`, `{{today}}`, `{{selection}}` (from the picker: what was
  selected in the app in front) start filled. `{{tone: formal / casual / blunt}}` is a choice, picked with the
  number keys. `{{name|default}}` and `\{{` as before (`src/blanks.ts`).
- **Blanks remember.** The last five answers per blank name, in the database's UI settings (`ui.blanks`), never in
  the notes. A field starts with the last; `Up` steps back; the answers are chips (`src/collection/BlankFields.tsx`).
- **Versions on one card.** In a Prompts or Snippets note, each `## heading` starts a version (two or more make
  versions). The card says "N versions"; `Tab` steps through them on the sheet (after the last blank) and in the
  picker; the one copied last comes first (`ui.versions`, `src/collection/versions.ts`).
- **The picker knows where you are.** Copies from the picker are counted per app in front (`copied_in.<app>|<path>`
  in settings); what was used there comes first, with "N× here". Local only.
- **Your prompts on a note.** `Ctrl J` lists the Prompts collection under the built-in tasks (`↓` to choose). A
  prompt runs on the selection, or the whole note when nothing is selected; `{{text}}`, `{{code}}`, `{{selection}}`
  and `{{note}}` are that text, other blanks are asked. The result is shown beside the old text with Keep and Drop,
  like Tidy (AI task `prompt`; a version first).
- **Ask again.** After an answer in `Ctrl K`, `Tab` opens a follow-up: the earlier turns and the same notes go with
  it. `Ctrl Enter` keeps the whole exchange and its sources as one note.
- **The live folder.** The folder is watched from Rust (`notify`, 600 ms debounce, `src-tauri/src/watch.rs`); only
  the changed files are read again (`Store::scan_paths`). The open note reloads where you were, with "Updated from
  Drive" in the footer, when nothing typed is waiting to be saved; otherwise the conflict-copy rule holds. The rescan
  on focus stays for folders that send no events.
- **Settle a conflict.** A "To settle" card in the library for each note with a conflict copy; both texts side by
  side with the differences marked (`src/versions/diff.ts`); keep left, keep right, or keep both (the copy renamed
  `Title (other)`). The side not kept goes to `.trash/`; one undo (`Store::settle_conflict`).
- **Open tasks.** A `Ctrl K` page with every unticked `- [ ]` in every note (from the engine, `Store::open_tasks`),
  grouped by note, newest first. `x` ticks it in the file (`Store::tick_task`, one undo), `Enter` opens the note.

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
| Quick picker | `Ctrl Shift Space`, `petrel --picker`. No frame. Search, a peek pane, blanks filled inline, `Enter` copies and closes. |

On Wayland the compositor binds the keys: `bind = SUPER, N, exec, petrel --capture` and
`bind = SUPER, V, exec, petrel --picker`.

## Not yet

A local model as a second AI provider. The page's link in a capture's quote on Linux. A real-window check on
Windows of this design. The note beside does not reload when its file changes on disk (the main note does).
