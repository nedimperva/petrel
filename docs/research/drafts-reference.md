# Drafts reference

What Drafts (Agile Tortoise, iOS/macOS) does, as the owner uses it and as its public documentation describes it.
This is the behaviour Petrel takes its *shape* from. It is a reference for design, not a compatibility target;
the subset Petrel reads is fixed in [actions.md](../design/actions.md). No Drafts code or assets were consulted.

## The model

- **A draft is plain text.** No title field: the first line is the title. No file, no folder tree. A draft has a
  UUID, created/modified/accessed timestamps, tags, a flag, a syntax (Markdown, TaskPaper, …) and lives in one of
  Inbox, Archive or Trash. Drafts remembers each draft's cursor position.
- **Capture first.** The app opens to a new blank draft (configurable: always, after N minutes away, never). On
  Mac there is a separate floating *Quick Capture* window on a global shortcut, and a menu-bar item. Text also
  arrives through the share sheet, Services, the URL scheme and Shortcuts. The point is that the decision about
  *where this text goes* is postponed.
- **Act later.** An **action** is a named, ordered list of **steps**. The action bar above the keyboard, the
  action list (a sidebar on the right) and keyboard shortcuts run them. Actions live in **action groups**; a
  group can be the active one shown in the bar. After an action succeeds, the draft can stay, be archived,
  trashed or have tags added ("after success"). Actions and groups are shared as JSON files and through the
  public **Action Directory**.
- **Workspaces** are saved list configurations: tag filters (include/exclude), a search string, sort order, flagged
  on top, which folder, plus the action group and the editor settings to switch to. The left sidebar shows the
  folders, flags, tags and workspaces.

## Steps that exist (public documentation)

Insert Text · Clipboard (replace, prepend, append) · Script (JavaScript) · Prompt (as script object) · URL ·
Callback URL (x-callback-url with results back) · File (create/append/prepend in the sandbox or an iCloud folder)
· HTML Preview · Run Action · Run Shortcut · Run AppleScript (Mac) · Mail · Message · Share · Export · Open In ·
Reminder · Event · Dropbox · Google Drive · OneDrive · OneNote · Evernote · Todoist · WordPress · Medium · Day One
· Bear · Things · OmniFocus (and more, most of them thin wrappers over a URL or an API with stored credentials).

Petrel's view: the first eight are the engine. Everything else is either a URL/HTTP action a script can write in
ten lines, or Apple-only.

## Template tags (the `[[tag]]` syntax)

Every text field in a step is a template. Documented tags include:

`[[draft]]` whole text · `[[title]]` first line · `[[safe_title]]` filename-safe title · `[[body]]` everything after
the first line · `[[trimmed_body]]` · `[[selection]]` selected text, or the whole draft when nothing is selected ·
`[[selection_only]]` · `[[line]]` current line · `[[line|n]]`, `[[line|n..m]]` lines by number/range ·
`[[clipboard]]` · `[[uuid]]` · `[[tags]]` comma-separated · `[[created]]`, `[[modified]]` · `[[date]]` (default
`%Y-%m-%d`), `[[date|%H:%M]]` with strftime format, relative forms like `[[date|+1 day|%Y-%m-%d]]` · `[[time]]`,
`[[longdate]]`, `[[shortdate]]` · `[[draft_open_url]]` a URL that reopens the draft · `[[template|name.txt]]`
includes a template file · custom tags set by scripts (`draft.setTemplateTag`). `\[[` escapes. Fields may also be
URL-encoded automatically depending on the step (URL steps encode tag values; a `{{ }}` form forces encoding and
`%% %%` forces none). A newer Mustache mode exists alongside.

## Scripting API (public documentation, the parts in common use)

Global objects: `draft` (`content`, `title`, `uuid`, `tags`, `isFlagged`, `isArchived`, `isTrashed`, `createdAt`,
`modifiedAt`, `addTag`, `removeTag`, `hasTag`, `update`, `processTemplate`, `setTemplateTag`, `getTemplateTag`,
`versions`), `editor` (`getText`, `setText`, `getSelectedText`, `setSelectedText`, `getSelectedRange`,
`setSelectedRange`, `getSelectedLineRange`, `getTextInRange`, `setTextInRange`, `insertTextAtCursor`, `activate`,
`focus`, `new`, `load`, `save`, `arrange`, `preview`), `app` (`getClipboard`, `setClipboard`, `openURL`,
`displayInfoMessage`, `displaySuccessMessage`, `displayErrorMessage`, `displayWarningMessage`, `currentWorkspace`,
`applyWorkspace`, `queueAction`, `themeMode`), `context` (`cancel`, `fail`, `callbackResponses`, `previewValues`).
Classes: `Draft` (`create`, `find`, `query(queryString, filter, tags, omitTags, sort, descending, flaggedToTop)`),
`Prompt` (`title`, `message`, `addButton`, `addTextField`, `addTextView`, `addSelect`, `addSwitch`, `addDatePicker`,
`show()`, `buttonPressed`, `fieldValues`), `HTTP` (`request({url, method, headers, data, encoding})`), `HTML`,
`FileManager` (`createLocal`, `createCloud`, `readString`, `writeString`, `listContents`, `exists`, `createDirectory`),
`Credential` (`create`, `addTextField`, `addPasswordField`, `authorize`, `getValue`), `Action` (`find`), `ActionGroup`,
`Workspace` (`find`, `getAll`), `Base64`, `Template`, plus vendor clients (`Todoist`, `Dropbox`, `GoogleDrive`, …)
and `Mail`, `Message`, `Share`, `Shortcuts`, `AppleScript`.

## Editor features (public documentation)

Syntaxes: Markdown (several dialects), TaskPaper, JavaScript, Simple List, Plain Text, user-defined syntaxes
(JSON grammars). Focus mode, typewriter scrolling, Link mode (tap links instead of editing), Arrange mode
(drag lines/blocks), Markdown preview with user CSS, version history, cross-linking with `[[Title]]`, `[[d:Title]]`,
`[[w:Workspace]]`, `[[s:search]]`, `[[u:UUID]]`, backlinks, `(( ))` for a navigation marker, dictation.

## URL scheme (x-callback-url)

`drafts://x-callback-url/create?text=…&tag=…&action=…`, `/open?uuid=`, `/get?uuid=`, `/prepend`, `/append`,
`/replaceRange`, `/search?query=&tag=`, `/runAction?text=&action=`, `/workspace?name=`, `/loadActionGroup`,
`/dictate`, `/arrange`, `/capture`. Results go back through `x-success` with `uuid` and, for `/get`, `text`.

## Things Petrel will do differently on purpose

- Linux/Windows have no share sheet, Shortcuts or Services. Replacement surfaces: a CLI (`petrel --new`, stdin),
  a URI scheme, a `.desktop` action, Windows "Send to", a tray menu and a global hotkey (X11/Windows; a compositor
  keybind on Wayland).
- No iCloud. Sync (M4) is file-based and the user picks the folder.
- Scripts run in a Rust-hosted JavaScript runtime with explicit host permissions, not in a privileged context.
- The `Run Command` step (shell) is first-class because on Linux it *is* the automation layer.
- Actions are stored as readable JSON in the database and mirrored to the data folder so they are diffable and
  git-friendly; the action directory, when it exists, is a git repo.
