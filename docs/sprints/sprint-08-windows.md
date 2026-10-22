# Sprint 8 — Windows

**Status:** not started

## Delivery scope

**M0:** compile with MSVC, WebView2 and keyring smoke test. **M3:** public Windows release: installers, update,
tray, URI registration, "Send to", global hotkey, scaling, sleep/resume, IME, the full acceptance suite.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Tasks

### M0
- [ ] CI windows-2022 job green; owner runs the dev build once; keyring write/read; IME smoke; 150 % DPI.

### M3
- [ ] NSIS `-setup.exe` and `.msi`; updater as in Tern; SmartScreen note in the README until signing.
- [ ] `petrel://` registered by the installer; `Send to` shortcut (`petrel --stdin` from a file: `petrel --file PATH`).
- [ ] Global hotkey default `Ctrl Alt N` (configurable); conflicts detected.
- [ ] `runCommand` defaults to PowerShell on Windows; `cmd` selectable; paths with spaces tested.
- [ ] Tray, notifications with actions, title-bar theme, no browser keys/menus (Tern's package 13 list).
- [ ] Sleep/resume: the database handle survives; the capture hotkey still fires.
- [ ] Clipboard with CRLF text; editor line endings normalised to LF on save (setting to keep CRLF in `file` steps).

## Acceptance (owner)
- [ ] [M3 checklist](../acceptance/m3-windows.md).

## Decisions

## Log
