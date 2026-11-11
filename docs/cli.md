# Command line

`petrel --help` prints this list. A capture written from the command line is a new file in the notes folder's
`inbox/`, so a running Petrel shows it the next time its window comes to the front.

| Command | What it does |
|---|---|
| `petrel` | Opens Petrel, or brings the running one to the front. |
| `petrel --capture` | Opens the capture window, or focuses it. |
| `petrel --picker` | Opens the quick picker: find a prompt or snippet, fill its blanks, copy it. |
| `petrel --new TEXT…` | Saves `TEXT` as a new capture in `inbox/` and exits. No window. The words are joined with spaces. |
| `petrel --hidden` | Starts in the tray without a window (start at login uses it). With no tray it shows the window. |
| `petrel --stdin` | Saves what is piped in as a new capture in `inbox/` and exits. No window. |
| `--tag NAME`, `-t NAME` | With `--new TEXT` or `--stdin`: tags the capture. Repeat it, or separate names with commas. |
| `--` | Everything after it is text, even if it starts with `-`. |

`--new TEXT` and `--stdin` print the new file's path and exit 0. Empty text is not saved (exit 1); a mistake in
the arguments prints the help (exit 2). Piped input over 16 MB is refused.

`PETREL_DB=path` uses another database. Without it a debug build uses `<app data>/dev/petrel.db` and a release
build `<app data>/petrel.db`, where `<app data>` is `~/.local/share/io.github.nedimperva.petrel` on Linux and
`%APPDATA%\io.github.nedimperva.petrel` on Windows. Notes go to the folder picked in Settings; until one is picked,
a release build uses `Documents/Petrel Notes`, and a debug build or one with `PETREL_DB` a `notes` folder next to
the database.

On Windows a release build has no console, so the path and messages are not printed there; the exit code still
says what happened. A debug build (`npm run tauri dev`) prints them.

There is no `petrel run` and no `petrel://` scheme any more: Petrel has no actions (decided 2026-11-09).
