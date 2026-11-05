# Petrel

**Capture text first, act on it later. Fast, local-first, keyboard-first, for Linux and Windows.**

Linux first, then Windows · Rust · Tauri 2 · SolidJS · SQLite · MIT

> **Petrel is at the skeleton stage (0.1, milestone M0).** It compiles, saves what you type, and has a speed
> table, but there is no installer and no actions yet. The roadmap, architecture, schema and the action engine
> specification are in [`docs/`](docs/PLAN.md). A sibling of [Tern](https://github.com/nedimperva/tern), built on
> the same stack and conventions.

## What it will be

Petrel opens to an empty draft with the cursor ready. You type. It is saved. Later — or right away — you send the
text where it belongs with one key: the clipboard, a file, a URL, a shell command, a mail, another draft, or a
script of your own. Drafts live in an inbox you triage with the keyboard, carry tags, and are found by full-text
search in milliseconds. There is no account, no server and no telemetry; everything is a SQLite file on your disk.

If you know Drafts on Mac and iOS, that is the shape. Petrel is not affiliated with Agile Tortoise and shares no
code with Drafts. It reads a documented subset of Drafts action files so you can bring your actions along; see
[the compatibility statement](docs/design/actions.md#compatibility-statement-what-the-readme-may-claim).

- **Capture from anywhere.** A hotkey (or a compositor keybind on Wayland), the tray, `petrel --new "text"`,
  `echo text | petrel --stdin`, `petrel://create?text=…`, a `.desktop` action, Windows "Send to".
- **Keyboard first.** `Ctrl K` command bar, `j`/`k` lists, every action on its own key.
- **Actions.** Ordered steps with `[[template]]` tags: Insert Text, Clipboard, Open URL, Save File, Run Command,
  Prompt, Run Action, HTML Preview, Mail, and JavaScript with `draft`, `editor`, `app`, `Prompt`, `HTTP`,
  `FileManager`, `Credential`. Scripts run in a sandboxed runtime with per-action permissions.
- **Never loses text.** Continuous autosave, version history, a trash that waits 30 days, a database backup
  before every migration.
- **Yours.** Actions are readable JSON on disk; drafts export as Markdown; an optional folder mirror lets
  Syncthing or git carry them. Sync between machines comes later and will be file-based.

## Plan

Delivery: **safe foundation → Linux private alpha → focused Linux beta → Windows release → expansion.**
Milestones, exit criteria and scope boundaries: [docs/PLAN.md](docs/PLAN.md).

| Document | What it holds |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Milestones, gates, performance targets, work-package map, decision record |
| [docs/design/actions.md](docs/design/actions.md) | Action engine, run algorithm, template tags, built-in steps, scripting API, import/export |
| [docs/design/ui.md](docs/design/ui.md) | Layout, screens, keys, tokens (shared with Tern), review checklist |
| [docs/research/data-model.md](docs/research/data-model.md) | SQLite schema v1, migration rules, the queries that must be fast |
| [docs/research/stack.md](docs/research/stack.md) | Stack choices and platform notes |
| [docs/research/drafts-reference.md](docs/research/drafts-reference.md) | What Drafts does, and what Petrel does differently on purpose |
| [docs/sprints/](docs/sprints/README.md) | Work packages and how to work them |
| [docs/acceptance/](docs/acceptance/m1-alpha.md) | Owner checklists per milestone |

## Building from source

Linux (Arch, including Omarchy):

```
sudo pacman -S --needed base-devel rustup nodejs npm webkit2gtk-4.1 librsvg
rustup default stable
```

Linux (Debian/Ubuntu):

```
sudo apt install build-essential curl wget file pkg-config libwebkit2gtk-4.1-dev librsvg2-dev
curl https://sh.rustup.rs -sSf | sh
```

Windows: Rust from [rustup.rs](https://rustup.rs) (MSVC toolchain) and the Visual Studio Build Tools with
"Desktop development with C++". Windows 11 has the WebView2 runtime already.

Then, on any system:

```
npm install
npm run tauri dev       # the app, with hot reload for the UI
npm run tauri build     # an installer: .msi/.exe on Windows, .deb/.rpm/.AppImage on Linux

cargo test --workspace                                        # all tests
cargo run --release -p petrel-core --example store_bench      # the speed table at 50,000 drafts
cargo run --release -p petrel-core --example gen_store -- PATH # a 50,000-draft test library; PETREL_DB=PATH opens it
scripts/kill-test.sh                                          # type, kill -9, see what survived
```

To work on the UI alone, `npm run dev` and open [http://localhost:1420](http://localhost:1420): without Tauri the
UI runs against a fake in-memory store.

Debug builds keep their database at `<app data>/dev/petrel.db`, apart from an installed Petrel's. On Wayland,
Petrel sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` itself (set it to `0` to opt out). On Hyprland the window class is
`petrel`; to float it: `windowrulev2 = float, class:^(petrel)$`.

`petrel --capture` opens the small capture window (or focuses it); a second launch hands the flag to the running
Petrel. On Wayland every Petrel window shares the app id, so Hyprland rules match the capture window by title:

```
bind = SUPER, N, exec, petrel --capture
windowrulev2 = float, title:^(Petrel capture)$
windowrulev2 = size 560 320, title:^(Petrel capture)$
windowrulev2 = center, title:^(Petrel capture)$
```

`Esc` saves and closes it, `Ctrl Enter` runs the default action and closes it. The capture window stays on top.
In `npm run dev` the capture window is [http://localhost:1420/?capture](http://localhost:1420/?capture).

Petrel keeps running in the tray: closing the window hides it, and the tray menu has New draft, Capture, Show and
Quit. On Linux the tray needs `libayatana-appindicator` and a tray host (Waybar's `tray` module on Omarchy); without
one, closing the window quits as before. On Windows a left click on the icon shows the window.

`Ctrl Alt Space` opens the capture window from any app on Windows and X11 (change it or turn it off in Settings,
`Ctrl ,`; pause it from the tray). On Wayland apps can't grab keys, so bind `petrel --capture` in the compositor as
above. Settings also has "Start at login", which starts Petrel hidden in the tray.

Text from the command line goes straight to the Inbox without a window ([docs/cli.md](docs/cli.md)):

```
petrel --new "call the bank" --tag errand
git log -1 | petrel --stdin --tag git
```

## Project layout

```
crates/petrel-core/      the engine (Rust, no UI)
  src/store.rs           SQLite schema, migrations with backup, drafts, tags, versions, search, sweep
  src/title.rs           the first line is the title
  src/gen.rs             a generated test library (Zipf vocabulary)
  src/template.rs        [[tag]] engine                      (package 03)
  src/action.rs          actions, steps, the run algorithm   (package 03)
  src/host.rs            Host trait: clipboard, URLs, files, shell, keyring, HTTP, prompts (package 03)
  src/script.rs          JavaScript runtime and API          (package 04)
  examples/store_bench.rs  timings on a 50,000-draft store
  examples/runtime_spike/  the QuickJS-vs-Boa measurement behind the scripting decision
src-tauri/               the desktop shell and CLI: commands, windows, tray, deep links, updater
src/                     the UI (SolidJS): editor, list, action column, command bar
```

## Contributing

Not yet — the first packages are being built. Ideas go to Discussions; once there is code, read
`docs/sprints/README.md` before opening a PR.

## License

[MIT](LICENSE) © Nedim Perva. Petrel is an independent project and is not affiliated with or endorsed by
Agile Tortoise, Inc.; "Drafts" is their trademark.
