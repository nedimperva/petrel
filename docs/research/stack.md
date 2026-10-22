# Stack

Petrel reuses Tern's proven stack. Decisions here are inherited unless marked **gate**.

| Layer | Choice | Why / notes |
|---|---|---|
| Engine | Rust 2021, `crates/petrel-core` (no UI, no Tauri) | Same split as `tern-core`; the CLI and tests use it directly |
| Storage | SQLite via rusqlite (bundled), WAL, FTS5 | One file, fast, FTS5 for search. Bundled so Windows needs nothing |
| Shell | Tauri 2 (`src-tauri`) | Plugins: single-instance, deep-link, global-shortcut, autostart, tray, notification, clipboard-manager, opener, dialog, fs (scoped), updater, process, cli |
| UI | SolidJS + Vite, no state library | Signals only, keyboard handling in `App.tsx`, same conventions as Tern |
| Editor | CodeMirror 6 (`@codemirror/state`, `view`, `commands`, `lang-markdown`, `search`) | Modular, keyboard-first, good IME support on WebView2 and WebKitGTK; language packages loaded lazily. Bundle budget 300 kB gz |
| Markdown preview | `pulldown-cmark` in Rust → sandboxed `<iframe>` with CSP | Rendering in core keeps the JS bundle small and lets `petrel export` share the code. Sandbox rules from Tern |
| Templates | Own engine in core (`template.rs`), ~300 lines, tested | `[[tag]]`, `[[tag|arg]]`, `\[[` escape, strftime dates via `chrono`, custom tags from scripts |
| Scripting | **gate** rquickjs vs boa vs deno_core (package 03, M0) | Expected: rquickjs. Needs: interrupt handler, memory limit, async host calls, MSVC build |
| HTTP (scripts) | reqwest + rustls (platform verifier) | No OpenSSL, same as Tern |
| Secrets | `keyring` crate (Secret Service / Credential Manager / Keychain), service `petrel` | Same gotchas as Tern: a keyring must be running and unlocked on Linux |
| Shell step | `std::process::Command` via `Host::run_command`, `sh -c` / `cmd /C` or PowerShell per setting | Confirmation on first use per action; output captured with a size cap and a timeout |
| CLI | `clap` in `src-tauri` (same binary) | `petrel`, `petrel --capture`, `petrel --new [TEXT]`, `petrel --stdin`, `petrel run ACTION [--draft UUID]`, `petrel export`. The second instance forwards to the first through the single-instance plugin |
| Packaging | Tauri bundler: AppImage, .deb, .rpm, MSI, NSIS; AUR `petrel-bin`; self-update for AppImage/Windows | Copy Tern's `release.yml`, `update.rs`, `packaging/aur` |
| CI | `check.yml` on ubuntu-24.04 + windows-2022: npm build, fmt, clippy `-D warnings`, tests, `store_bench` | Copy from Tern |

## Platform notes carried over from Tern

- Wayland/WebKitGTK: set `WEBKIT_DISABLE_DMABUF_RENDERER=1` in `main.rs` on Linux unless the user sets it to `0`.
- Hyprland tiles new windows; the capture window should be a separate, small, floating-friendly window with its own
  class (`petrel-capture`) so a window rule can float it; document the rule.
- Global shortcuts do not work from an app on Wayland. Document `bind = SUPER, N, exec, petrel --capture` for
  Hyprland and the equivalent for other compositors; the in-app setting shows "managed by your compositor" on Wayland.
- Windows: SmartScreen warning until signed; WebView2 is present on Windows 11; Credential Manager via `keyring`.
- Debug builds use `<data dir>/dev/petrel.db`, never the installed database (forward-only migrations).

## Not chosen

- Electron: bundle size and startup; Tauri already proven.
- A rich-text editor (TipTap/ProseMirror): the product is plain text.
- Running scripts in the webview: UI privileges, no CLI path, no limits.
- A sync service of our own: cost, trust, and not the product. Files first.
