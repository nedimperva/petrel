# Actions: engine, templates, scripting

The contract for package 03 (engine, built-in steps) and package 04 (scripting). Read before touching
`crates/petrel-core/src/{template,action,script}.rs`. Changes to this file are decisions and go through the owner.

## Vocabulary

- **Action**: name, icon, color, shortcut, ordered **steps**, *after success* (`nothing | archive | trash | new`),
  tags to add on success, confirm flag. Stored as a row in `actions` with `steps` as JSON; mirrored as
  `<data dir>/actions/<group>/<name>.json` on every change so actions are diffable.
- **Step**: `{ "type": "...", ...fields }`. Every string field is a **template** unless the step says otherwise.
- **Run**: one action against one draft from one **source** (`ui`, `shortcut`, `cli`, `uri`, `action` when chained).
  A run owns a **context**: the draft (a working copy), the editor state if a window is attached (selection,
  cursor), template tags set so far, the clipboard, callback results, a log, a cancellation token.
- **Host**: the trait the engine uses for anything outside the database — clipboard, open URL, filesystem, shell,
  keyring, HTTP, prompts, messages. `src-tauri` implements it with the window; the CLI implements it with the terminal
  and `xdg-open`/`start`; tests implement it with a recorder. **No step may bypass `Host`.**

## Run algorithm

```
run(action, draft, source):
  if action.disabled → Failed("contains unsupported steps: …")
  if action.confirm and source != action → host.confirm(name) or Cancelled
  if action.trusted_hash != hash(steps) and action has shell/out-of-scope file steps → host.confirm_scope(rendered) or Cancelled; on yes store the hash
  versions.insert(draft, reason = "before_action:" + action.uuid)
  ctx = Context::new(draft working copy, editor state, host)
  for (i, step) in steps:
     if ctx.cancelled → Cancelled
     match step.run(&mut ctx):
        Ok(Continue) → next
        Ok(Stop)     → break           // a script called context.cancel() or a Prompt was dismissed
        Err(e)       → record run(status=failed, step=i, message=e); host.error(step name, e); return Failed
  if ctx.draft.content changed and the stored content is no longer what the run started from
     → versions.insert(ctx.draft.content, reason = "action_conflict:" + action.uuid); record run(status=conflict); return Conflict
  commit ctx.draft changes (content/tags/flag/folder) in one transaction
  apply after_success and add_tags
  record run(status=ok)
  if source == ui: host.success(name) unless the action set ctx.quiet
```

Rules:

- The draft in the store is **not touched until the run finishes**. Steps edit `ctx.draft`. A failure leaves the
  stored draft as it was before the run (steps with external effects — a file written, a command run — have
  happened; the log says which). This is why the version is taken first and why the UI shows "step 3 of 5 failed".
- **A run never overwrites a newer save.** The editor is read-only while a run on its draft is going, but the
  text can still be saved between `prepare` and `finish` (a save already queued, another window). Then the stored
  text wins, nothing else is applied, and the action's text is kept as an `action_conflict` version.
- After a run the editor shows the committed result as it is; it never saves the text it held before the run
  over it (the save controller's `discard`, `src/editor/autosave.ts`).
- `Stop` is a clean early exit: nothing is written, no error is shown, `after_success` is **not** applied.
- Steps run on a core worker thread. The editor stops taking keys at once; the UI shows a running state after
  150 ms and lets `Esc` cancel; cancel
  interrupts a script at the next instruction, a shell command with SIGTERM/taskkill, an HTTP request by dropping it.
- Default time limit per run: 60 s; per script step 10 s; per command 30 s. All three are action-level settings.
- Every run gets a row in `action_runs`. `g l` in the UI shows the log; `petrel log` prints it.

## Template engine (`template.rs`)

Syntax: `[[name]]`, `[[name|arg]]`, `[[name|arg1|arg2]]`. `\[[` yields a literal `[[`. Unknown tags are left as
written and the run log notes them (a typo shouldn't silently drop text). Tags are case-insensitive.

| Tag | Value |
|---|---|
| `draft` | full content |
| `title` | first non-empty line, trimmed, Markdown heading marks removed |
| `safe_title` | `title` with `/\:*?"<>|` and control characters replaced by `-`, trimmed, max 120 chars |
| `body` | everything after the first line |
| `trimmed_body` | `body` with leading/trailing blank lines removed |
| `selection` | selected text; whole draft if no editor or no selection |
| `selection_only` | selected text or empty |
| `line` | line at the cursor |
| `line\|n`, `line\|n..m` | 1-based line or inclusive range |
| `clipboard` | current clipboard text (via `Host`) |
| `uuid` | draft UUID |
| `tags` | tag names, comma-separated, sorted |
| `created`, `modified` | ISO 8601 local time; `created\|%Y-%m-%d` with strftime |
| `date` | today, `%Y-%m-%d` by default; `date\|%H:%M`; `date\|+1 day\|%Y-%m-%d` (relative: `+N day/week/month/year/hour/minute`, `monday`…`sunday` next occurrence) |
| `time`, `longdate`, `shortdate` | `%H:%M`, locale long date, `%d/%m/%Y`-style short date |
| `draft_open_url` | `petrel://open?uuid=…` |
| `template\|name` | contents of `<data dir>/templates/name`, itself rendered (depth limit 5) |
| `env\|NAME` | environment variable (Linux/Windows have no share sheet; they do have `$EDITOR`) |
| custom | anything set by `draft.setTemplateTag(name, value)` in a script step earlier in the same run |

Encoding: a URL step encodes every tag value with percent-encoding by default. `{{name}}` forces encoding in any
field; `%%name%%` forces raw in any field. A `File` step's path field never encodes. This matches the shape people
already know and is listed in the compatibility section.

Tests: a table of 60+ cases in `template::tests`, including escapes, nesting, unknown tags, relative dates across
month/year boundaries, `line` ranges out of bounds, and encoding modes.

## Built-in steps (package 03, M1)

Each step has a Rust struct with `serde` (`#[serde(tag = "type", rename_all = "camelCase")]`), a schema used by
the action editor to draw its form, and tests against a recording `Host`.

| `type` | Fields | Behaviour |
|---|---|---|
| `insertText` | `text`, `position: cursor \| start \| end \| replaceSelection \| replaceAll`, `moveCursor` | Edits `ctx.draft`; updates selection like an editor would |
| `clipboard` | `text` (default `[[draft]]`), `mode: replace \| prepend \| append` | Via `Host::clipboard_set` / `clipboard_get` |
| `url` | `url`, `encode: true`, `openIn: browser \| default` | Rendered with URL encoding; `Host::open_url`. `petrel://` URLs are handled internally (so an action can open another draft) |
| `file` | `path`, `text` (default `[[draft]]`), `mode: create \| append \| prepend \| overwrite`, `createDirs` | `path` rendered without encoding; `~` and `$VAR` expanded; relative paths are under `<data dir>/files/`. Writing outside the Petrel folder is part of the one-time trust dialog for untrusted actions (`Host::confirm_scope`) |
| `runCommand` | `command`, `stdin` (default `[[draft]]`), `shell: sh \| bash \| zsh \| fish \| $SHELL \| powershell \| cmd \| none` (default `sh` / `powershell`), `timeoutSecs`, `output: ignore \| insert \| replace \| clipboard \| templateTag:<name>`, `cwd` | `Host::run_command` with the login shell's `PATH`; an **untrusted** action confirms once (see Decisions); stdout captured (1 MB cap), non-zero exit fails the step with stderr in the message |
| `runAction` | `action` (name or UUID), `stopOnFail: true` | Nested run sharing the same `ctx`; depth limit 8; a cycle fails |
| `prompt` | `title`, `message`, `buttons: [..]`, `fields: [{key, kind: text \| textarea \| select \| switch \| date, label, default, options}]`, `cancelButton` | `Host::prompt`; dismiss → `Stop`; results become template tags `prompt_button` and `prompt_<key>` |
| `htmlPreview` | `template` (Markdown by default, `html: true` for raw HTML), `css` (name of a file in `<data dir>/css/`), `continueButton` | Renders in a sandboxed preview window; "Continue" resumes, close → `Stop`. The step after it can therefore be a `file`/`url` step that depends on the user having looked |
| `script` | `script`, `timeoutSecs`, `allowShell`, `allowFiles`, `allowHttp` | Package 04. In M1 this step exists and fails with "scripting arrives in 0.3" so imported actions load |
| `unsupported` | `originalType`, `original` (the raw JSON) | Produced by import for anything not listed; makes the action `disabled` and shows itself in the editor with the original type name |
| `mail` | `to`, `cc`, `bcc`, `subject`, `body` | Builds a `mailto:` and opens it (Tern picks it up on the owner's machine). Cheap and useful; not a mail client |
| `setTags` / `setFlag` / `move` | `tags` add/remove, `flagged`, `folder` | Metadata edits on `ctx.draft` so after-success is not the only way to file a draft |
| `openDraft` | `uuid` or `title`, `newIfMissing` | Switches the editor to another draft after the run commits |

Steps keep their names stable once shipped; new fields get defaults; a removed field becomes ignored, never an error.

## Scripting API (package 04, M2)

ES2020+ JavaScript in the runtime chosen in package 03 (expected rquickjs). One `Context` per run, created fresh,
destroyed at the end; nothing persists between runs except through drafts, files, the keyring or template tags.
Everything the script can reach goes through `Host` or the store, with the action's permission flags
(`allowShell`, `allowFiles`, `allowHttp`) checked at the call, not at parse time, so the error names the call.
The permission flags say what a script *may* do; trust (above) says whether the user has seen it.

Host calls that need the user (`Prompt.show`, `app.openURL` in some sandboxes, confirmations) are asynchronous
on the Rust side but **appear synchronous to the script**: the runtime suspends on a host request, the core awaits
the shell's reply, then resumes. Scripts written in the familiar blocking style therefore port unchanged.

### Globals

| Object | Members (v1 of the API) |
|---|---|
| `draft` | `content`, `title` (ro), `uuid` (ro), `tags` (ro array), `isFlagged`, `isArchived`, `isTrashed`, `syntax`, `createdAt`, `modifiedAt`, `addTag(n)`, `removeTag(n)`, `hasTag(n)`, `update()` (commit now instead of at the end, for scripts that then call `editor.load` another draft), `processTemplate(s)`, `setTemplateTag(k, v)`, `getTemplateTag(k)`, `versions` (array of `{content, createdAt, reason}`), `permalink` (`petrel://open?uuid=`) |
| `editor` | `getText()`, `setText(s)`, `getSelectedText()`, `setSelectedText(s)`, `getSelectedRange()` → `[start, len]`, `setSelectedRange(start, len)`, `getSelectedLineRange()`, `getTextInRange(start, len)`, `setTextInRange(start, len, s)`, `insertTextAtCursor(s)`, `activate()`, `focus()`, `new()`, `load(draft)`, `save()`, `preview()`. Without a window (CLI) the editor is a headless model over `draft.content`; selection is empty |
| `app` | `getClipboard()`, `setClipboard(s)`, `openURL(url)`, `displayInfoMessage(s)`, `displaySuccessMessage(s)`, `displayWarningMessage(s)`, `displayErrorMessage(s)`, `currentWorkspace`, `applyWorkspace(w)`, `queueAction(action, draft)` (runs after this one commits), `themeMode` (`light`/`dark`), `platform` (`linux`/`windows`), `version` |
| `context` | `cancel(msg?)` → `Stop`, `fail(msg)` → `Failed`, `previewValues`, `callbackResponses` (empty; no x-callback on desktop), `source` |
| `console` | `log/info/warn/error` → run log (8 kB tail kept) |

### Classes

| Class | Members |
|---|---|
| `Draft` | `new Draft()`, `Draft.create()`, `Draft.find(uuid)`, `Draft.query(queryString, folder: 'inbox' \| 'archive' \| 'all' \| 'trash' \| 'flagged', tags = [], omitTags = [], sort = 'modified', descending = true, flaggedToTop = false)` → array; `Draft.recentTags()`, `Draft.allTags()` |
| `Prompt` | `title`, `message`, `isCancellable`, `addButton(name, value?, isDefault?)`, `addTextField(key, label, default, opts)`, `addTextView(key, label, default)`, `addSelect(key, label, options, defaults, allowMultiple)`, `addSwitch(key, label, default)`, `addDatePicker(key, label, default, {mode})`, `addPicker(key, label, columns, defaults)`, `show()` → bool, `buttonPressed`, `fieldValues` |
| `HTTP` | `HTTP.create()`, `request({url, method, headers, parameters, data, encoding: 'json' \| 'form' \| 'raw', timeout})` → `{success, statusCode, headers, responseText, responseData, error}`. Needs `allowHttp` |
| `FileManager` | `FileManager.createLocal()` → the Petrel `files/` folder; `FileManager.create(path)` → any folder (needs `allowFiles` and the once-per-action scope confirm); `readString(p)`, `writeString(p, s)`, `appendString(p, s)`, `exists(p)`, `listContents(p)`, `createDirectory(p)`, `moveItem(a, b)`, `copyItem(a, b)`, `baseURL` |
| `Credential` | `Credential.create(identifier, description)`, `addTextField(key, label)`, `addPasswordField(key, label)`, `authorize()` (prompts once, stores in the keyring under `petrel/<identifier>`), `getValue(key)`, `forget()` |
| `Shell` | **Petrel-specific.** `Shell.run(command, {stdin, shell, timeout, cwd})` → `{status, stdout, stderr}`. Needs `allowShell`; a script with `allowShell` makes the action untrusted until confirmed, like a `runCommand` step |
| `Action` | `Action.find(name)`, `.name`, `.uuid`, `.run(draft?)` (queued) |
| `ActionGroup` | `find(name)`, `getAll()` |
| `Workspace` | `find(name)`, `getAll()`, `.name`, `.tagFilter`, `.queryString`, `.apply()` |
| `Template` | `Template.render(templateString, tags)`; `[[…]]` engine exposed |
| `Base64` | `encode(s)`, `decode(s)` |
| `Markdown` | **Petrel-specific.** `Markdown.render(s)` → HTML via pulldown-cmark |

### Not provided (throws `NotSupported: <name> is not available in Petrel`)

`Mail` (use the `mail` step or `mailto:`), `Message`, `Share`, `Shortcuts`, `AppleScript`, `Reminder`, `Event`,
`Dictation`, `Speech`, `MultiMarkdown`, `XMLRPC`, `WordPress`, `Medium`, `Dropbox`, `GoogleDrive`, `OneDrive`,
`Box`, `OneNote`, `Evernote`, `Todoist`, `Things`, `Bear`, `DayOne`, `OmniFocus`, `Airtable`, `Notion`, `Microsoft
To Do`, `GitHubMarkdown`, `Alarm`, `Calendar`, `Contacts`. Vendor APIs are a few lines of `HTTP` plus `Credential`
each; the shared action directory (M4) is the place for them, not the runtime.

### Compatibility statement (what the README may claim)

"Petrel reads Drafts action files and runs actions built from Insert Text, Clipboard, URL, File, Prompt, Run Action,
HTML Preview and Script steps whose scripts use `draft`, `editor`, `app`, `context`, `Draft`, `Prompt`, `HTTP`,
`FileManager`, `Credential`, `Template` and `Base64`. Other steps import as disabled with their original name shown.
Scripts that reach Apple-only or vendor objects fail with a message naming the object." Nothing more.

## Import and export (package 06)

- **Petrel JSON** (`.petrel-action`, `.petrel-group`): `{ "format": "petrel-action", "version": 1, "action": {…} }`
  with the row's fields and `steps` verbatim. Groups bundle actions. Exports strip `id`, keep `uuid`.
- **Drafts** `.draftsAction` / `.draftsActionGroup`: JSON. Map `type` names case-insensitively onto the table above;
  `Callback URL` → `url`; `data` sub-objects are flattened to the step's fields; unknown → `unsupported`. An
  import report lists per action: imported / imported with N disabled steps / skipped, and never silently drops.
- Round trip: export → import yields identical rows except `id`, `modified_at`.

## Decisions (owner, 2026-10-22: "speed, convenience, long term")

### Shell: `sh`, with the login shell's `PATH`

`runCommand` and `Shell.run` default to `sh -c` on Linux (`/bin/sh`) and PowerShell on Windows. Interactive shells
load rc files (50–300 ms) and differ in syntax (fish), so an action would be slow and would break on another
machine. What people want from `$SHELL` is their `PATH`: on startup Petrel runs `$SHELL -lc 'printf %s "$PATH"'`
once (cached in `settings`, refreshed daily and from Settings → Actions) and exports that `PATH` to every command.
A step may set `shell: sh | bash | zsh | fish | $SHELL | powershell | cmd | none` to opt out.

### Trust: a property of the action, earned once, lost on change

- An action created or edited in Petrel's action editor is **trusted when saved**: the user just wrote the command.
- An action that arrives any other way — import, a file in `actions/` changed outside Petrel, a URI — is
  **untrusted**. Its first run shows the rendered commands and out-of-scope paths of all its shell/file steps in one
  dialog; "Run and trust" records `trusted_hash = sha256(steps JSON)`. Any later change to `steps` that did not come
  through the editor clears trust, so a pulled git change re-prompts.
- No per-run prompts for trusted actions (speed), no global "trust everything" (one click would make shared
  actions dangerous). `action_runs` stays the audit log for both.
- Schema: `actions.trusted_hash TEXT` (NULL = untrusted). `Host::confirm_scope` is called only for untrusted actions.

### Versions: age-tiered, no hard cap

Drafts are small; the cost of history is finding the right version, not disk. Keep every `edit` snapshot from the
last hour, one per hour for 24 hours, one per day for 30 days, one per week after that. `before_action`,
`action_conflict` and `restore` versions are kept 90 days then follow the weekly tier. Thinning happens in `sweep()` (start-up and daily),
**never on the save path**, so autosave stays a single UPDATE plus at most one INSERT. Trashing a draft keeps its
versions until the tombstone; "Empty trash" removes them. A setting can shorten every tier; none can disable the
hour tier.
