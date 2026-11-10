# Petrel: the minimal plan (draft, 2026-11-10)

The owner's feedback on the redesign build (2026-11-10): it works but is not what he wanted. He wants Petrel more
minimal, with the main window feeling like the first capture screen. The quick capture window should have no
Windows title bar. The main window should have a modern title bar of its own, as Tern has. Above all it should be
pleasant to use. This draft replaces the window and screen parts of `petrel.md`. Files, AI on request, copy with
blanks and the picker stay as they are. Nothing here is built yet.

## The idea in one line

Petrel opens to the text. Everything else (other notes, the inbox, collections, AI) is one key away and out of
sight until you ask for it.

## 1. Main window: a page to write on

- **Launch opens a writing page.** It is the same as the capture window, only bigger: an empty page with the
  cursor in it. The note you were on comes back if you left less than 10 minutes ago (the old drafts rule). There
  is no Home dashboard, greeting, cards or chips.
- **Nothing on screen but the text and the bar.** The text column is about 68ch wide and centred, in Literata. No
  footer of hints: `?` and `Ctrl K` hold the keys.
- **While you type the bar goes quiet.** The title and buttons fade to the background colour after the first
  keystroke and come back when the mouse moves or a key with Ctrl is pressed. Tern's writing mode does the same.

## 2. Title bar, done as Tern does it

- `decorations: false` on Windows, so Petrel draws its own 40 px bar (`src/components/TitleBar.tsx`, ported from
  Tern's). Linux keeps the window manager's frame, as Tern does (`set_decorations(true)` at start), because tiling
  window managers draw none anyway and GNOME draws its own.
- Left: the sidebar button (`Ctrl \`). Middle: the note's title and a save dot (no words unless saving fails).
  Right: a quiet ✦ button for search or ask (`Ctrl K`), then minimize, maximize and close in Tern's thin style
  (close is red on hover). The rest of the bar drags the window, and a double click maximizes it.
- Close hides to the tray, as now.

## 3. Browsing notes, prompts and collections (reopened)

The owner does not want the inbox, notes and collections in one sidebar (2026-11-10). This needs a better way to
look through them. Three directions to choose from:

- **A. A Library, apart from writing.** `Ctrl L` switches the whole window from the page to a Library. Its
  collections are tabs in the title bar (Inbox, Notes, Prompts, Snippets, …), as Tern puts its list tabs there.
  Below them is a list on the left and a live preview on the right. In Prompts and Snippets the preview shows the
  blanks to fill and Copy. `Esc` or `Enter` goes back to writing. The writing page never shows any of it.
- **B. Each kind gets its own view.** The bar has three quiet words: Write · Inbox · Library. The Inbox is a
  triage view (one capture at a time, `m` to file and `Del`). The Library is a grid of collections, and a
  collection opens to a list and preview, as in A.
- **C. Only the command bar.** No browsing screen at all. `Ctrl K` lists collections first and then their notes
  as you type, with a preview beside the results. The inbox is reached by `Ctrl K` then `inbox`. It is the most
  minimal, but the hardest way to just look around.

The old sidebar plan is below for reference.

## 3a. (superseded) The sidebar replaces Home, the Inbox page and collection pages

- `Ctrl \` or the bar button opens it. It is hidden by default and docks beside the page from 1100 px wide; below
  that it floats over the page.
- It has three groups: **Inbox** (its count, then the captures newest first, each one line), **Collections** (the
  top-level folders), and **Recent** (the last 10 notes). `j k` move through it, `Enter` opens a note, `m` files
  an inbox item and `Esc` goes back to the page.
- The sticky-note inbox and the card grids go. Filing (`m`, and `s` for Claude's suggestion) stays the same,
  but it is done from the sidebar or from the open capture.

## 4. One command bar

- `Ctrl K` does it all: type to find a note, `>` for a command (copy formats, move, new collection, settings),
  and a question to ask your notes (the answer shows in the bar, with the notes it used). The search field on Home
  goes.
- `Ctrl J` on a note does AI on that note, as now. The rewrite preview stays as it is.

## 5. Quick capture: no system frame

- A frameless window (`decorations(false)`, `transparent(true)`, `shadow(true)`) with a 12 px radius, shown at
  the top third of the screen the mouse is on. It is 600 px wide, starts about 180 px high and grows with the text
  up to 420 px.
- It looks like the main window's page: the same font, background and padding. It has no bar. A thin footer line
  shows where the capture goes, `Tab` to choose and `Esc` done, and it fades while you type. You drag the window by
  the footer or the empty space around the text.
- Same on Linux. The Hyprland float rule stays in the README.
- The quick picker gets the same frame, radius and shadow, so the two small windows look alike.

## 6. Look and feel

- Take Tern's tokens and motion: fewer borders, spacing on a 4 px scale, one accent, and 120 ms fades with no
  sliding.
- Warm paper and ink stay unless the owner says otherwise. Light or dark follows the system.
- Every window shows only once it has rendered, so it never flashes white. This already holds for main and
  capture, and the picker gets the same.

## Order of work

1. **Frames.** Tern's title bar in the main window (Windows), and frameless rounded capture and picker windows.
   This is small and is the part most visible on Windows.
2. **Writing first.** The launch page and the bar fading while you type. Home is removed.
3. **Sidebar.** Inbox, collections and recent notes, with filing. The Inbox and collection pages are removed.
4. **Command bar.** Search, commands and ask, all in `Ctrl K`.
5. **Polish.** Tokens, motion, empty states and a real-window check on Windows.

Each step is a PR on its own and leaves `main` building. The capture path (hotkey, typing, saved) gets a timing
in the PR that touches it.

## Questions for the owner

1. On launch: always a blank page, or the last note when you left less than 10 minutes ago?
2. Should the inbox be sticky notes, or one line per capture in the sidebar (this plan)?
3. On Linux: the system frame, as Tern does, or Petrel's own bar there too?
4. Do you want a canvas with these screens before I build step 1?
