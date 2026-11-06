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

Not yet (package 07): `petrel open UUID`, `petrel run ACTION`, `petrel list`, `petrel export`, `petrel log`, and
the `petrel://` URI scheme.
