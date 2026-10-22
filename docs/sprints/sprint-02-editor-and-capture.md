# Sprint 2 — Editor and capture

**Status:** in progress · started 2026-10-22 (editor keys on PR #2)

## Delivery scope

**M1:** the editor people live in, open-to-new-draft behaviour, the capture window, focus mode, tags and flag
from the keyboard. **M2:** syntaxes beyond Markdown, wiki links and backlinks, Markdown preview with user CSS,
link mode, typewriter scrolling. Arrange mode, Vim keys and dictation are backlog.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Goal

Launch, type, done. The editor is on screen with the cursor blinking before you can think about it, what you
type is kept, and the first line is the title. Everything else stays out of the way.

## Tasks

### Editor (M1)
- [ ] CodeMirror 6 setup in `src/editor/`: Markdown (GFM tables, task lists, strikethrough), soft wrap, bracket
      matching off, history, search (`Ctrl F`), spell check through the webview's native checker (setting).
- [x] Editing commands: move line up/down (`Alt ↑/↓`), duplicate line, toggle `- [ ]` (`Ctrl Shift X`), toggle
      list, continue lists on Enter, indent/outdent lists with `Tab`, insert link (`Ctrl Shift K`), bold/italic.
      `src/editor/commands.ts`; toggle list is `Ctrl Shift 8`, duplicate line is CodeMirror's `Shift Alt ↓`; `Ctrl F`
      search came with it (`@codemirror/search`). Tried headless in `npm run dev`.
- [ ] Cursor and selection persistence per draft (`cursor` column; selection in UI state only).
- [ ] Font family/size settings; monospace option; measure `--editor-max`.
- [ ] Focus mode (`Ctrl Shift D`) and typewriter scrolling (setting).
- [ ] Paste: plain text always; a setting to convert pasted URLs to Markdown links when text is selected.

### Open-to-new-draft (M1)
- [ ] Setting: always / after N minutes away (default 10) / never. "Away" = window hidden or unfocused.
      The 10-minute behaviour is in (`NEW_AFTER_AWAY_MS` in `App.tsx`); the setting and its UI are not.
- [ ] An empty untouched new draft is **not** saved as a row; the row is created on the first keystroke. Closing
      with an empty new draft leaves nothing behind. Test in the store (no empty rows after N open/close cycles).
- [ ] `Ctrl N` saves the current draft (flushes autosave) then creates the new one; the previous draft stays in Inbox.

### Capture window (M1)
- [ ] Separate Tauri window `capture`, class `petrel-capture`, 560×320, always-on-top (setting), remembers size.
- [ ] `petrel --capture` and the tray "New draft" open it (or focus it) via the single-instance plugin.
- [ ] `Ctrl Enter` runs the active group's default action; `Esc` saves and closes; close button saves.
- [ ] Hyprland float rule and Windows behaviour documented in the README.

### Tags, flag, folder from the editor (M1)
- [x] `Ctrl T` chip input with autocomplete from `tags`; `Ctrl Shift F` flag; `Ctrl E` archive (opens the next draft
      in the current list or a new draft, setting); `Ctrl #` trash with a 5 s undo toast.
      A comma-separated input with a datalist rather than chips; archive/trash open a new draft (no setting yet);
      Undo in the toast (or `z` in the list) reopens the draft. Tried headless in `npm run dev`.

### Syntaxes (M2)
- [ ] Plain text, Simple List (`- `/`* `/`1. ` recognition, checkbox toggling), TaskPaper (projects, tasks,
      `@tags`, `@done` greys the line). Each a CodeMirror `StreamLanguage` or small Lezer grammar, lazy-loaded.
- [ ] User syntaxes: **decision gate** — ship a small JSON "patterns → token class" format, or CodeMirror legacy
      mode definitions? Spike, measure, propose.

### Links and preview (M2)
- [ ] `[[Title]]` completes from draft titles; `Ctrl Click` / Link mode opens the target; missing target offers
      "Create draft 'Title'". `[[d:Title]]`, `[[u:UUID]]`, `[[w:Workspace]]`, `[[s:query]]`.
- [ ] Backlinks panel section in versions/info panel (`links` table from package 01).
- [ ] Preview (`Ctrl Shift P`): `pulldown-cmark` in core → HTML; sandboxed iframe with CSP; CSS from
      `<data dir>/css/*.css`, default uses tokens; rough heading scroll sync.

## Acceptance (owner)
- [ ] Two weeks of all quick capture in Petrel; nothing lost (versions and the log confirm).
- [ ] Capture from a Hyprland keybind to first keystroke feels instant; measured in the log < 100 ms when running.
- [ ] A TaskPaper list and a Markdown note each look right; preview matches the owner's CSS.

## Decisions

## Log

- 2026-10-22 — Editor keys and open-to-new after 10 minutes away, on PR #2 with the package 05 list panel. Tried
  headless against the fake store only.
