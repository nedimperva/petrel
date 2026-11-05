# Sprint 7 — Desktop integration

**Status:** in progress · started 2026-11-05 (tray and `--new`/`--stdin`)

## Delivery scope

**M1 (Linux):** CLI, stdin, URI scheme, tray, single instance, start at login, global hotkey where possible,
`.desktop` actions, notifications for action results when the window is hidden. **M3:** Windows parity
(package 08 tracks acceptance). Dictation is backlog.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Goal

Text reaches Petrel from anywhere on the desktop in one gesture, and Petrel gives it back to the desktop in one key.

## Tasks

### CLI (`clap` in `src-tauri`)
- [ ] `petrel` (focus/open), `petrel --capture`, `petrel --new [TEXT]`, `echo … | petrel --stdin [--tag t]`,
      `petrel open UUID`, `petrel run ACTION [--draft UUID | --stdin]`, `petrel list [--folder] [--tag] [--json]`,
      `petrel export …`, `petrel log`. The second instance forwards to the first; with no instance, `run`/`list`/
      `export` work headless against the store with `CliHost`.
      Done: `petrel`, `--capture`, `--new` (a new draft in the running window), `--new TEXT` and `--stdin` with
      `--tag` (`src-tauri/src/cli.rs`). These two write the draft from the calling process, before Tauri starts,
      and exit: no window, nothing to forward. Not yet: `open`, `run`, `list`, `export`, `log` (`run` needs `CliHost`).
- [x] `--help` and a `docs/cli.md` page.

### URI scheme
- [ ] `petrel://create?text=&tag=&action=`, `open?uuid=`, `append?uuid=&text=`, `prepend`, `search?query=`,
      `run?action=&text=`, `workspace?name=`. No x-callback (`x-success` ignored with a log line).
- [ ] Deep-link plugin registration on Linux (`.desktop` MimeType) and Windows (registry via the installer).

### Tray and lifecycle
- [ ] Tray: New draft, Capture, Show, Pause hotkey, Quit; closing the window keeps the tray (setting).
      `src-tauri/src/tray.rs`: New draft, Capture, Show, Quit; left click shows the window (Windows). Closing the
      main window hides it; closing a capture window leaves Petrel in the tray. Quit asks each window to save and
      close (`petrel-quit`), the last one ends the process; Quit again exits at once. Without a tray (no
      appindicator library on Linux) closing quits, as before. Not yet: Pause hotkey (no hotkey yet), the setting.
- [ ] Autostart plugin; "start hidden".
- [ ] Global shortcut plugin on X11/Windows; on Wayland the setting shows the compositor instructions.
- [ ] `.desktop` actions: New draft, Capture. Hyprland `bind` and float rule in the README.
- [ ] Notifications (tauri-plugin-notification) for action results when no window is visible; quiet by default.

## Acceptance (owner)
- [ ] `SUPER+N` bound to `petrel --capture` in Hyprland opens the capture window with focus in < 100 ms (running).
- [ ] `git log -1 | petrel --stdin --tag git` creates a tagged draft; `petrel run Copy --draft …` copies.
- [ ] `xdg-open "petrel://create?text=hi"` works from a browser link.

## Decisions

- 2026-11-05 — The CLI is parsed by hand, not with `clap`: six flags do not earn a dependency on the launch path.
  Revisit when `run`/`list`/`export` arrive with subcommands.
- 2026-11-05 — `--new TEXT` and `--stdin` open the database from the calling process (SQLite WAL, 5 s busy
  timeout) instead of forwarding the text to the running Petrel: the single-instance plugin forwards arguments but
  not stdin, and this also works when Petrel is not running. The path rule is duplicated in `cli::db_path`; the app
  logs a warning at start if the two ever disagree.

## Log

- 2026-11-05 — Tray, close-to-tray, Quit, `--new`, `--new TEXT`, `--stdin --tag`, `--help`, `docs/cli.md`, capture
  window always on top (package 02). Booted the debug build under Xvfb on Linux: the tray builds, a second
  `petrel --new` / `--capture` is forwarded, `--stdin` while it runs saves the draft. Not tried: the tray menu
  itself (no tray host in the sandbox), Windows.
