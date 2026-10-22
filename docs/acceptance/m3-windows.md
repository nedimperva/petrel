# M3 — Windows release checklist

- [ ] `-setup.exe` and `.msi` install on a clean Windows 11; SmartScreen note accurate.
- [ ] Cold start measured; capture via `Ctrl Alt N` while running < 100 ms.
- [ ] IME input (a non-Latin layout) and 150 % scaling.
- [ ] `petrel://` from a browser; "Send to Petrel" on a `.txt` file.
- [ ] Keyring: `Credential` stored in Credential Manager.
- [ ] `runCommand` with PowerShell; a path with spaces.
- [ ] Sleep/resume; tray; notifications; title bar in dark mode.
- [ ] Self-update to the next build.
- [ ] The M1 and M2 checklists re-run on Windows (editor, list, actions, safety sections).
- [ ] Linux CI and the AppImage still green on the same tag.
