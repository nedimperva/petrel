# Petrel UI spec

The single source of truth for how Petrel looks and behaves on screen. Package files say *when* a screen is
built; this file says *what it must look like*. If a package needs something not covered here, add it here
first, then build it. Delivery scope comes from `docs/PLAN.md`.

Direction (owner's decision): **a sibling of Tern.** Same tokens, same keycaps, same quiet density, so the two
apps feel like one family on the owner's desktop. Where Drafts has a strong, good convention (open to a blank
draft; the action list on the right; the first line is the title), keep it.

## 1. Principles

1. **The editor is the app.** It is on screen at launch, focused, empty. Everything else is a panel that `Esc` closes.
2. **Typing is never interrupted.** No modal appears while the user types; autosave, versioning, indexing and
   action runs happen off the input path. If something must be said, it goes in the status strip.
3. **Keyboard first, mouse welcome.** Every control shows its key on hover; nothing needs the mouse.
4. **Quiet.** One accent. Greys do the work. Borders are rare.
5. **Instant.** No spinners under 300 ms. Optimistic everywhere; the store is local so this is mostly true for free.
6. **Text is the interface.** Few icons, all labelled. Action icons are the one place colour and icons carry
   meaning, and they always have a name beside them in the list.

## 2. Tokens

Copy `src/styles/tokens.css` from Tern unchanged (colour, type, space, radius, motion, keycaps, density). Petrel
adds:

| Token | Light | Dark | Use |
|---|---|---|---|
| `--flag` | `#e9b81c` | `#f2c94c` | Flagged (Tern's `--star`) |
| `--editor-max` | `72ch` | | Measure of the editor column; the editor is centred when the window is wider |
| `--action-*` | 8 colours | | Action colours chosen by name: `grey blue green yellow orange red purple teal` — same palette as Tern's account colours |

Editor type: `--t-rd` by default (14/21), a setting for 13–18 px, and a monospace option (JetBrains Mono).

## 3. Layout

```
┌──────────────┬──────────────────────────────────────────┬──────────────┐
│ sidebar      │ editor                                   │ actions      │
│ Inbox    12  │ ┌──────────────────────────────────────┐ │ ▸ Default    │
│ Flagged   3  │ │ # Title of the draft                 │ │  Copy      c │
│ Archive      │ │                                      │ │  Save file s │
│ Trash        │ │ Body…                                │ │  Open URL  o │
│ ──────────   │ │                                      │ │  Run…      r │
│ Tags         │ └──────────────────────────────────────┘ │              │
│  work     8  │ ┌ list (when open) ────────────────────┐ │              │
│  idea    21  │ │ › Title          preview       2 min │ │              │
│ ──────────   │ │   Title          preview       1 hr  │ │              │
│ Workspaces   │ └──────────────────────────────────────┘ │              │
│  Journal     ├──────────────────────────────────────────┴──────────────┤
│  Work        │ status strip: saved · 1,204 drafts · markdown · ⌨ hints │
└──────────────┴──────────────────────────────────────────────────────────┘
```

- **Three columns, two of them optional.** Sidebar (`Ctrl 1`) and action list (`Ctrl 2`) toggle; their state is
  remembered. The default on first run is editor + action list; the sidebar opens when the list is opened.
- **The draft list is a panel over the editor's column**, not a permanent column (`Ctrl L` / `Esc`). This keeps the
  launch screen to one thing. A setting (`layout: list-left`) makes it a permanent left column for people who
  want the Drafts-on-Mac shape; the sidebar then merges into it as a header row of filters.
- **The capture window** (`petrel --capture`, tray, hotkey) is a separate small window: editor only, 560×320
  default, class `petrel-capture`, no sidebar, action list collapsed to a single row of the active group's first
  six actions. `Ctrl Enter` runs the group's default action (or just saves to Inbox); `Esc` saves to Inbox and
  closes. It never shows an empty-state or a dialog.
- Minimum main window 720×480, like Tern.

## 4. Screens

### 4.1 Editor
- CodeMirror 6, soft wrap, no line numbers by default, gutter off. Markdown highlighting with headings in
  `--fg-0` 600 weight, no font-size changes (the first line is the title; it may or may not be a heading).
- Placeholder in an empty new draft: "Type. It's saved. Act on it later." in `--fg-2`.
- Autosave indicator in the status strip only: "saved" (`--fg-2`), "saving…" after 300 ms unsaved, "not saved —
  retrying" in `--warn` on an I/O error (never a dialog).
- Focus mode (`Ctrl Shift F`): hides both side columns and the strip, dims everything but the current paragraph.
- Typewriter scrolling (setting). Link mode (`Ctrl Shift L`): clicks follow links instead of placing the cursor.
- Selection and cursor survive switching drafts (stored `cursor`).

### 4.2 Draft list (`Ctrl L`)
- Rows 36 px dense: title (`--t-md`, 600 if modified in the last hour), preview (`--fg-2`, one line), relative
  time right-aligned (`tnum`), flag dot on the left in `--flag`, tag chips only in comfortable density.
- `j`/`k` move, `Enter` opens, `Esc` back to the editor with the same draft, `x` selects for a batch
  (`e` archive, `#` trash, `f` flag, `t` tag) with one undo token.
- Filters header: Inbox · Flagged · Archive · Trash · All, tag chips, search box (`/`). Workspace name when one is
  applied, with `Esc` clearing it.
- Search results highlight the match in the preview (FTS `snippet()`), sorted by rank then date.

### 4.3 Action list (right column)
- Groups as collapsible sections; the active group expanded. Each row: colour dot, icon, name, keycap.
- `Enter` or click runs on the current draft. Running state: the row shows a thin progress bar after 150 ms and
  "Esc to stop". Result: a 2 s toast in the strip ("Copied", "Saved to ~/notes/…", "Failed at step 2: …" with a
  "Log" link).
- `Ctrl Shift A` opens the action editor as a panel: name, icon/colour pickers, shortcut recorder, steps as a
  vertical list with per-type forms (fields come from the step schema), a "Test on current draft" button that runs
  with a dry-run `Host` and shows what *would* happen (clipboard text, rendered URL, rendered command).

### 4.4 Command bar (`Ctrl K`)
- Same component as Tern's palette: fuzzy match over commands, actions ("Run: Copy"), drafts ("Open: Title"),
  tags ("Tag: work"), workspaces. Recent first. Shows keycaps.

### 4.5 Versions (`Ctrl H`)
- Side panel listing versions newest first with reason and time; selecting one shows a diff against the current
  draft (word-level, inline, `--ok`/`--danger` soft backgrounds); "Restore" makes a new version first.

### 4.6 Preview (`Ctrl Shift P`)
- Sandboxed iframe beside the editor (or over it in narrow windows), scroll-synced roughly by heading. User CSS
  files from `<data dir>/css/`; the default CSS uses the tokens.

### 4.7 Settings (`Ctrl ,`)
- One page, sections on the left like Tern: General (open to new draft: always/after N min/never; capture window
  size; theme), Editor (font, size, typewriter, spell check), Keys (table with recorder; conflicts shown),
  Actions (shell default, confirmation policy, time limits, log retention), Storage (location, backups, trash
  sweep, mirror folder), About (version, log file, open data folder).

### 4.8 Empty and error states
- Empty Inbox: a single line, "Inbox is empty." No illustration; Petrel's empty state is just the editor.
- Database cannot open: a dialog *before* the editor with the file path, the error and buttons "Open backups
  folder" and "Quit". The only modal on the launch path, and only on failure.

## 5. Keys

Chords use `g` as the prefix like Tern. Single letters act only when the editor is **not** focused (in the list
or action column); in the editor everything is `Ctrl`-modified.

| Key | Where | Does |
|---|---|---|
| `Ctrl N` | anywhere | New draft (saves the current one first) |
| `Ctrl L` | anywhere | Toggle the draft list |
| `Ctrl K` | anywhere | Command bar |
| `Ctrl 1` / `Ctrl 2` | anywhere | Toggle sidebar / action list (`Ctrl 2` focuses the list when it is open but not focused, and hides it from inside) |
| `Ctrl Enter` | editor | Run the default action of the active group |
| `Ctrl Shift A` | anywhere | Action editor |
| `Ctrl E` / `Ctrl #` / `Ctrl Shift F` | editor | Archive / trash / flag current draft (`Ctrl Shift F` toggles flag; focus mode is on `Ctrl Shift D`) |
| `Ctrl T` | editor | Tag current draft (chip input) |
| `Ctrl H` | anywhere | Versions |
| `Ctrl Shift P` | anywhere | Preview |
| `Ctrl ,` | anywhere | Settings |
| `/` | list | Search |
| `j` / `k` / `Enter` / `x` / `e` / `#` / `f` / `t` / `z` | list | Move / open / select / archive / trash / flag / tag / undo |
| `g i` / `g f` / `g a` / `g t` / `g d` / `g l` | outside the editor | Inbox / Flagged / Archive / Trash / All drafts / action log |
| `Esc` | anywhere | Close the top panel; in the capture window, save and close |
| `Ctrl Q` | anywhere | Quit (closing the window keeps Petrel in the tray) |
| per action | anywhere | The action's own shortcut; conflicts with the table above are refused in the recorder |

## 6. Review checklist

Before a UI PR: tokens only (no raw colours/sizes); every control has a key on hover; `Esc` closes what you
opened; the editor keeps focus and selection through the change; no modal on the typing path; dark and light
checked; `npm run build` size recorded in the package log; tried on Hyprland (or stated that it was not possible).
