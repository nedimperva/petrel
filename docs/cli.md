# Command line

`petrel --help` prints this list. The engine and the app share one database, so a draft written from the command
line shows in a running Petrel's list the next time the list loads.

| Command | What it does |
|---|---|
| `petrel` | Opens Petrel, or brings the running one to the front. |
| `petrel --capture` | Opens the capture window, or focuses it. |
| `petrel --new` | Opens Petrel on a new, empty draft (the open one is saved first). |
| `petrel --new TEXT…` | Saves `TEXT` as a new Inbox draft and exits. No window. The words are joined with spaces. |
| `petrel --hidden` | Starts in the tray without a window (start at login uses it). With no tray it shows the window. |
| `petrel --stdin` | Saves what is piped in as a new Inbox draft and exits. No window. |
| `--tag NAME`, `-t NAME` | With `--new TEXT` or `--stdin`: tags the new draft. Repeat it, or separate names with commas. |
| `--` | Everything after it is text, even if it starts with `-`. |

`--new TEXT` and `--stdin` print the new draft's uuid and exit 0. Empty text is not saved (exit 1); a mistake in
the arguments prints the help (exit 2). Piped input over 16 MB is refused.

`PETREL_DB=path` uses another database. Without it a debug build uses `<app data>/dev/petrel.db` and a release
build `<app data>/petrel.db`, where `<app data>` is `~/.local/share/io.github.nedimperva.petrel` on Linux and
`%APPDATA%\io.github.nedimperva.petrel` on Windows.

On Windows a release build has no console, so the uuid and messages are not printed there; the exit code still
says what happened. A debug build (`npm run tauri dev`) prints them.

## Running an action

| Command | What it does |
|---|---|
| `petrel run ACTION --draft UUID` | Runs the action on that draft, with no window. Quote a name with spaces. |
| `petrel run ACTION --stdin` | Saves what is piped in as a new Inbox draft, then runs the action on it. `--tag` tags it. |

```
petrel run "Save to file" --draft 0193f2c4-…
git log -1 | petrel run "Append to journal" --stdin --tag git
```

The run is the same as from the window: a version is taken first, the draft is only written if every step
worked, after-success (archive, trash) applies, and the run is in the action log as `cli`. The draft's uuid is
printed on success (exit 0). A failed step prints `failed at step N` (exit 1). A dismissed prompt, a preview
step (it needs the window) or an untrusted action with no one to ask stops the run (exit 3).

Questions go to the terminal. The first time an action runs a command or writes outside its folder, Petrel
lists what it will do and asks `[y/N]`; yes trusts it, as in the window. Prompt steps ask one field per line.
With no terminal (cron, a pipe into stdin, a Windows release build) nothing is asked and nothing new is
trusted: run the action once from a terminal or the app first.

Commands get the terminal's `PATH`. On Linux the clipboard steps use `wl-copy`/`wl-paste` on Wayland and
`xclip` on X11, because the copied text has to outlive `petrel run`.

If Petrel is open on the same draft and you type in it while the action runs, the action's text is kept as a
version instead of overwriting yours (exit 1, "the draft was edited while it ran").

## Links

Petrel registers the `petrel://` scheme, so a link in a browser, a note or a script opens Petrel:

| Link | What it does |
| --- | --- |
| `petrel://create?text=TEXT&tag=a&tag=b` | A new Inbox draft with that text and tags, opened in the window. |
| `petrel://open?uuid=UUID` | Opens that draft. |
| `petrel://append?uuid=UUID&text=TEXT` | Adds the text to the end of that draft (`prepend` adds it to the start). |
| `petrel://search?query=QUERY` | Opens the list with that search, e.g. `tag:work milk`. |

Text is URL-encoded (`%20` for a space, `%0A` for a new line), up to 1 MB. `x-success` and `x-error` are
ignored. There is no `run` link: any web page can open a link, and an action can run shell commands. A link
Petrel doesn't know shows a message instead of doing nothing. On Linux try one with
`xdg-open "petrel://create?text=hi"`; on Windows, `start petrel://create?text=hi`.

Not yet (package 07): `petrel open UUID`, `petrel list`, `petrel export`, `petrel log`.
