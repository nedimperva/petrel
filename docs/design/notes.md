# Notes

Notes are all of Petrel's text: captures are notes in `inbox/` until they are filed (2026-11-09, see `petrel.md`).
Decided by the owner on 2026-11-06. Design doc and canvas: https://claude.ai/artifact/V31DtPgjUWXkcxBzapRSzq.

## Files are the truth

- A note is a `.md` file in a folder the person picks. The default is `Documents/Petrel Notes`. A debug build or
  `PETREL_DB` uses `<db dir>/notes`. Sub-folders make the tree, and the title is the file name without `.md`.
- Tags and the pin live in front matter (`tags: [a, b]`, `pinned: true`). Front matter lines Petrel does not know
  are kept as they are.
- SQLite only indexes the files (`notes`, `notes_fts`, schema v5), and it can always be rebuilt from them.
  `scan_notes` runs when the notes open and when the window gets focus. There is no file watcher yet.
- Every write goes to a temp file and is then renamed into place, with a retry on Windows. A save carries the hash
  the editor started from. If the file changed on disk in the meantime, the other version is kept as
  `Title (conflict YYYY-MM-DD HHMM).md`, and nothing is overwritten.
- Trash moves the file to `<root>/.trash/`. Folders that start with `.` are never scanned.
- Pictures live in `<folder>/attachments/` next to the notes that link them (`![](attachments/name.png)`); only
  png, jpg, gif and webp, 20 MB at most, names cleaned to letters, digits, `.`, `_` and `-`. A move or merge into
  another folder moves the pictures the note links and fixes the links, and undo moves them back.
- A collection's look is `<top folder>/.petrel` (`color: teal`, `mark: plane`); other lines in it are kept.
- A day's page is `journal/YYYY-MM-DD.md`. Filing a capture there adds `HH:MM text` at the end, with a
  `_from capture_` line under it.
- Versions of a note are in `note_versions`, keyed by the note's uuid. A rename made in another app starts a new
  history.

## Links

- `[[Title]]`, `[[Folder/Title]]`, `[[d:Draft title]]`, `[[u:UUID]]`, plus `#heading` and `|label`. Links inside code
  spans, fenced code and `\[[` are left alone. The parser is `crates/petrel-core/src/links.rs`, and
  `src/notes/parse.ts` mirrors it.
- A bare `[[Title]]` goes to a note first, then to a draft. A missing target has a dotted underline, and following it makes
  the note.
- There is no links table. Backlinks use an FTS phrase search for the title, and the `[[links]]` are then parsed in
  Rust. "Mentioned in" is the same search without a link, and it has a "Link it" button.
- Renaming a note rewrites the links to it in notes and drafts. A version of each text is taken first, and one Undo
  puts everything back.

## Promote

- `Ctrl Shift N` on a draft either makes a new note or adds the draft to the end of a note, under a dated line.
- The draft keeps its text, goes to the Archive, and shows a banner pointing at the note (`promotions` table).
  Links to the draft are rewritten to point at the note. Undo restores the file, the draft and the links.

## Keys

`Ctrl 3` notes home (cards and the folder tree), `Ctrl P` find a note, `Ctrl N` new note while notes are open,
`Esc` back to drafts. `[[` autocompletes, `Ctrl Click` or `Alt Enter` follows a link, and hovering shows a card.

## Not yet

A file watcher, action steps for promote and append, the History panel for notes, an "in notes" chip in the drafts
list, moving a note between folders from the UI, and a separate notes window.
