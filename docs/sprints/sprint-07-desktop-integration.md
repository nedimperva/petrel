# Sprint 7 — Desktop integration

**Status:** not started

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
- [ ] `--help` and a `docs/cli.md` page.

### URI scheme
- [ ] `petrel://create?text=&tag=&action=`, `open?uuid=`, `append?uuid=&text=`, `prepend`, `search?query=`,
      `run?action=&text=`, `workspace?name=`. No x-callback (`x-success` ignored with a log line).
- [ ] Deep-link plugin registration on Linux (`.desktop` MimeType) and Windows (registry via the installer).

### Tray and lifecycle
- [ ] Tray: New draft, Capture, Show, Pause hotkey, Quit; closing the window keeps the tray (setting).
- [ ] Autostart plugin; "start hidden".
- [ ] Global shortcut plugin on X11/Windows; on Wayland the setting shows the compositor instructions.
- [ ] `.desktop` actions: New draft, Capture. Hyprland `bind` and float rule in the README.
- [ ] Notifications (tauri-plugin-notification) for action results when no window is visible; quiet by default.

## Acceptance (owner)
- [ ] `SUPER+N` bound to `petrel --capture` in Hyprland opens the capture window with focus in < 100 ms (running).
- [ ] `git log -1 | petrel --stdin --tag git` creates a tagged draft; `petrel run Copy --draft …` copies.
- [ ] `xdg-open "petrel://create?text=hi"` works from a browser link.

## Decisions

## Log
