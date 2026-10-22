# Petrel roadmap

A fast, local-first, keyboard-first text capture and actions app for Linux, then Windows. Inspired by the
workflow of Drafts (Agile Tortoise) — *capture first, act later* — not gated on feature parity with it and not
using its name, icon or code. Rust + SQLite + Tauri 2 + SolidJS, the same foundation as
[Tern](https://github.com/nedimperva/tern). MIT.

## Agreed direction (2026-10-22)

- Deliver in this order: **safe foundation → Linux private alpha → focused Linux beta → Windows release → expansion**.
  Same shape as Tern: the owner uses Omarchy (Arch + Hyprland, Wayland) daily; Windows compiles and is smoke-tested
  from M0 but gets release polish in M3.
- The product is three things, in priority order: **(1) capture** — the app opens to an empty draft with the cursor
  ready, from a hotkey, the tray, the CLI, a URI or stdin, in well under half a second; **(2) a draft list** that
  never waits on anything — Inbox / Flagged / Archive / Trash, tags, workspaces, full-text search; **(3) actions** —
  a draft is sent somewhere by one key: clipboard, file, URL, shell command, another app, or a user script.
- **Text is never lost.** Autosave is continuous, versions are kept, Trash is a holding area, migrations back up the
  database first. Every later feature is judged against this before anything else.
- **No network is required.** Petrel has no account, no server and no telemetry. Actions may reach the network
  (an HTTP step, opening a URL) because the user asked them to. Sync between devices is M4 work and will be built on
  files the user controls (a folder a tool like Syncthing can carry), never a Petrel service.
- **Scripting in Rust-hosted JavaScript**, not in the webview. Scripts must run the same from the window, the CLI and
  a future headless mode, and must not have the UI's privileges. The runtime choice is an M0 decision gate.
- **Drafts compatibility is a convenience, not a promise.** Petrel reads the `[[template]]` tag syntax, the common
  action step kinds and a documented subset of the scripting objects so people can bring their actions over. Anything
  outside that subset fails with a clear message that says what is missing.
- Replace fixed delivery dates with milestone exit criteria and small, reviewable PRs.

This file defines release scope and order. `docs/sprints/sprint-NN-*.md` filenames are **work-package IDs**,
not chronological weeks. A package contributes a selected slice to a milestone and keeps later tasks. Its
**Delivery scope** section says which tasks are in scope; future tasks do not block a milestone. Do not
implement every checkbox in numeric order.

## Current evidence

- 2026-10-22: package 00 is merged. The workspace builds and tests on Linux and Windows CI; the store meets its
  speed table at 50,000 drafts (sandbox and CI runner numbers in the package file); the owner ran the dev build on
  Omarchy. The kill test, the Windows smoke test and the laptop's bench numbers are open acceptance checks.
- The owner has shipped Tern through its Linux beta on the same stack, so the toolchain, CI shape, AppImage/MSI
  packaging, self-update, AUR packaging and Hyprland behaviour are known quantities. Reuse them; do not re-research.
- The design is based on the owner's use of Drafts and on its public documentation
  ([reference notes](research/drafts-reference.md)). No Drafts code or assets were consulted or may be used.

## Milestones and release gates

| Milestone | Required scope | Exit evidence | Status |
|---|---|---|---|
| M0 — Safe foundation | Workspace compiles (core, shell, UI); Linux + Windows CI; Linux boot on Hyprland and a Windows WebView2 smoke test; `drafts`/`tags`/`versions`/FTS schema with forward-only migrations and a backup-before-migrate; autosave that survives kill -9; the template engine with tests; the scripting runtime decision; the `store_bench` harness at 50k drafts | `cargo test --workspace` and `npm run build` pass on both OSes; a draft typed, the process killed, and the text is there on restart; the migration test opens a v1 fixture; the runtime spike is written up and the owner chose | in progress: package 00 merged 2026-10-22 (CI green on Linux and Windows, speed table green, owner booted it on Omarchy, rquickjs chosen); open: kill test, Windows smoke, laptop bench numbers |
| M1 — Linux private alpha | Open-to-new-draft; CodeMirror editor with Markdown; draft list with Inbox/Flagged/Archive/Trash, tags, keyboard navigation, FTS search; `Ctrl K` command bar; actions v1 — built-in steps (Insert Text, Clipboard, Open URL, Save File, Run Command, Run Action, Prompt) with the template engine, action list with per-action keys, after-success behaviour; `petrel --capture`, `--new`, stdin, `petrel://` URI; tray, single instance, start at login; global hotkey where the platform allows; versions kept and restorable | Owner uses Petrel for all quick capture for two weeks with no lost text; common flows (capture → tag → act → archive) work without the mouse; the [M1 checklist](acceptance/m1-alpha.md) passes on Omarchy | not started |
| M2 — Focused Linux beta | JavaScript actions with the documented `draft`/`editor`/`app`/`context`/`Prompt`/`HTTP`/`FileManager`/`Credential` API; action groups, import/export (Petrel JSON and Drafts `.draftsAction` subset); workspaces (tag filters, query, sort, action group); Markdown preview with user CSS; versions UI; syntaxes (Markdown, TaskPaper, plain, simple list); wiki-style `[[links]]` between drafts; "mirror to folder" export for Syncthing users; AppImage/.deb/.rpm/AUR with self-update; CHANGELOG; tester guide; small external tester group | Testers import their own actions; the five most-used Drafts action kinds in the owner's library work or fail with a clear message; the [M2 checklist](acceptance/m2-beta.md) passes; no known text-loss bug; install/recovery documented | not started |
| M3 — Windows release | MSI/NSIS installer and update flow; WebView2 editor behaviour (IME, clipboard, scaling); Credential Manager; tray, notifications, URI registration, "Send to"; global hotkey; sleep/resume; same acceptance suite as Linux | Clean Windows 11 install passes the [M3 checklist](acceptance/m3-windows.md); Linux stays green | not started |
| M4 — Expansion | File-based sync (Syncthing-friendly folder, then optional WebDAV); optional AI steps (off by default, local or user-chosen provider); a shared action directory (a git repo of JSON, not a service); themes; dictation; more syntaxes; a Tern "Send as mail" step; headless `petrel run <action>` for scripts | Separate owner-approved scope and acceptance per feature; no dependency back into M1–M3 | deferred |

**First release** means the capture-list-actions core in M1–M3. Sync, AI, a directory and dictation cannot delay it.

### Scope boundaries

- **Capture speed is the product.** Any change that adds to cold start, to time-to-first-keystroke, or to the
  autosave path needs a measurement in the PR. A feature that cannot be made lazy does not ship.
- **Editor:** CodeMirror 6 with Markdown highlighting, soft wrap, a typewriter/focus option, and a small set of
  editing commands (move lines, toggle list/checkbox, link). Not a rich-text editor; not Vim mode in the first
  release (backlog).
- **Actions:** the built-in steps and the scripting API are the contract. A step may call out to the system
  (shell, URL, file, clipboard, keyring) only through the core's `Host` trait so the same action runs from the CLI.
  Every step is cancellable; a failing step stops the action and shows which step and why; the draft is never
  modified by a failed action except by steps that already ran (and a version is taken before every run).
- **Drafts compatibility:** `[[tags]]` and the step kinds `Insert Text`, `Clipboard`, `URL`, `Callback URL`
  (mapped to URL), `File`, `Script`, `Prompt` (inside scripts), `Run Action`, `HTML Preview`. Apple-only steps
  (Shortcuts, AppleScript, Mail.app, Messages, Reminders, Calendar, Share sheet) import as disabled placeholder
  steps that explain themselves. The scripting subset is listed in [actions.md](design/actions.md); everything else
  throws `NotSupported`.
- **Sync:** the schema is sync-ready from v1 (UUIDs, modified timestamps, tombstones) so M4 can add it without a
  migration of meaning. No sync ships before M4 and nothing in M1–M3 may depend on one.
- **Security:** scripts run in a sandboxed runtime with no filesystem, network or process access except through
  the host API. Actions not written in Petrel's own editor (imported, or changed on disk) confirm their shell
  commands and out-of-scope paths once, then are trusted until they change. Secrets (API keys an action needs) live in the OS keyring via `Credential`, never in action JSON or SQLite.
  Rendered Markdown preview is sandboxed like Tern's mail HTML (no scripts, no remote content by default).
- **Reliability:** text loss, a migration that cannot open an older database, an action that modifies a draft after
  failing, or an import that silently drops steps are release blockers, never "cut first".

### Version numbers

**0.1** foundation (M0), **0.2** Linux private alpha (M1), **0.3** focused Linux beta (M2), **1.0** the Windows
release (M3). A patch number marks a build handed to the owner or testers. Bump `package.json`,
`src-tauri/tauri.conf.json` and both `Cargo.toml` files together.

## Scripting runtime: decide early, implement once

The M0 gate (package 03) compares **rquickjs** (QuickJS bindings), **boa** (pure Rust) and **deno_core** (V8) on:
binary size, cold init time, ES2020+ coverage (classes, async/await, template literals, regex named groups,
`Intl`-free date formatting), interrupt/cancel support, memory limits, and ease of exposing the host API. The
expected answer is rquickjs (small, fast init, mature embedding); the spike exists to confirm it with numbers on
the Omarchy laptop and to record the Windows build story (MSVC) before M1 builds on it.

- Scripts run on a core thread with a time limit (default 10 s, action-configurable) and a memory limit; the
  UI stays responsive and shows a "Running… · Esc to stop" state.
- `Prompt` and other UI calls are **async host requests**: the script awaits, the core sends a request to the shell,
  the shell shows the dialog and replies. From the CLI the same request is answered on the terminal. Scripts never
  touch the DOM.
- `HTTP` uses reqwest with rustls, like Tern. Requests are logged in the action log (URL and status, never bodies).

## Optional AI contract

Deferred to M4 and kept the same as Tern's: fully off by default; no key, model or account needed for normal use;
a tested local endpoint and a user-chosen remote provider with keys in the OS keyring; an exact statement of what
leaves the device; failures never block capture, editing, search or non-AI actions. The natural first slice is an
`AI` action step (prompt template → text back into the draft) because the action system already provides the
confirmation, logging and cancellation.

## Performance evidence

Targets are measured on the Omarchy laptop with release builds and a generated 50,000-draft store
(`cargo run --release -p petrel-core --example gen_store`). Record p50/p95; measure input-to-paint, not just the
signal update. `store_bench` fails CI on a missed target (with a slack factor on shared runners, as in Tern).

| What | Target |
|---|---|
| Packaged cold start to a focused, empty editor | < 300 ms; record the measured number, not `tauri dev` |
| Capture window from the tray/hotkey while running | < 100 ms to first keystroke |
| Autosave write (debounced 300 ms, immediate on blur/close) | < 2 ms store time at 50k drafts |
| One list page (keyset paging) | < 1 ms |
| FTS search across 50k drafts | < 10 ms engine; IPC and render reported separately |
| Open a draft (content + tags + versions count) | < 5 ms |
| Run an action of built-in steps (no shell, no network) | < 20 ms |
| Script runtime init + "hello" script | < 10 ms |
| Moving down the list, per key | < 5 ms handler; no visible lag |
| JS bundle | < 300 kB gzipped including CodeMirror and the Markdown preview |

## Work-package map (IDs are not delivery order)

| ID | Work package | Delivery scope |
|---|---|---|
| 00 | [Compile and boot](sprints/sprint-00-compile-and-boot.md) | M0; both-OS CI, Windows smoke test, kill-test for autosave, bench harness |
| 01 | [Store and drafts](sprints/sprint-01-store.md) | M0 schema/migrations/versions/FTS; M1 list queries, tags, trash policy |
| 02 | [Editor and capture](sprints/sprint-02-editor-and-capture.md) | M1 CodeMirror, open-to-new, autosave, focus mode; M2 syntaxes, links, preview |
| 03 | [Action engine](sprints/sprint-03-action-engine.md) | M0 template engine + runtime gate; M1 built-in steps, Host trait, action list, after-success |
| 04 | [Scripting](sprints/sprint-04-scripting.md) | M2 JS API, Prompt/HTTP/FileManager/Credential, limits, action log |
| 05 | [List, search, workspaces](sprints/sprint-05-list-search-workspaces.md) | M1 folders/tags/search/command bar; M2 workspaces, saved queries |
| 06 | [Import, export, compatibility](sprints/sprint-06-import-export.md) | M2 Petrel JSON, Drafts `.draftsAction` subset, mirror-to-folder, Markdown export |
| 07 | [Desktop integration](sprints/sprint-07-desktop-integration.md) | M1 CLI/URI/tray/hotkey/autostart on Linux; M3 Windows parity |
| 08 | [Windows](sprints/sprint-08-windows.md) | M0 compile + smoke; M3 release |
| 09 | [Distribution and launch](sprints/sprint-09-launch.md) | M0 CI; M2 Linux packages + self-update + tester guide; M3 Windows installers |
| 10 | [Sync](sprints/sprint-10-sync.md) | M4; folder-based, then WebDAV |
| 11 | [Optional AI](sprints/sprint-11-ai.md) | M4; an action step, off by default |
| 12+ | [Backlog](sprints/sprint-12-plus-backlog.md) | Owner-prioritized expansion |

## Working agreement

See [the work-package process](sprints/README.md), the [UI spec](design/ui.md) and the
[action engine spec](design/actions.md).

- Small branches/PRs per tested slice. A milestone completes on evidence and owner acceptance.
- Keep `main` building on Linux and Windows from M0 on. Engine changes require tests; anything on the capture or
  autosave path requires a measurement; schema changes require a migration test from the previous version.
- Record environmental limits honestly (Wayland global shortcuts, Windows SmartScreen, keyring availability).
- Owner decides gates. No acceptance check is marked complete because an agent wrote code.

## Decision record

2026-10-22 — Owner chose the name **Petrel**, the Drafts-style product direction, and the Tern delivery shape
(Linux first on Omarchy, Windows in M3). Identifiers: app id `io.github.nedimperva.petrel`, URI scheme `petrel://`,
CLI `petrel`, window class `petrel`, data directory `petrel/` under the platform data dir (`~/.local/share/petrel`,
`%APPDATA%\petrel`), database `petrel.db`, keyring service `petrel`. This revision records the plan; nothing is
implemented.

2026-10-22 — Owner delegated three engine choices with the brief "speed, convenience, long term"; recorded in
[actions.md](design/actions.md#decisions-owner-2026-10-22-speed-convenience-long-term): `sh` with the login
shell's `PATH`; trust as a per-action hash earned in the editor or once at first run; age-tiered version retention
with no hard cap, thinned only in `sweep()`.

2026-10-22 — Owner chose **rquickjs** as the scripting runtime (package 03 gate; measured against Boa, deno_core
excluded on size) and accepted **newest-first search** for M1 with relevance ranking as a package 05 (M2) task.

Research: [Drafts reference](research/drafts-reference.md), [stack](research/stack.md),
[data model](research/data-model.md). Design: [actions and scripting](design/actions.md), [UI](design/ui.md).
