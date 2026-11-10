# Petrel

**Quick notes and capture, as Markdown files in one folder. Minimal, keyboard-first, for Linux and Windows.**

Rust · Tauri 2 · SolidJS · SQLite (index only) · MIT

Petrel is a personal tool. You press a key, type, and it is saved as a `.md` file. Captures land in `inbox/`;
later you file them into a note or a collection. Collections are just folders (Notes, Prompts, Snippets, Songs,
…) and their notes are easy to find and copy, with `{{blanks}}` you fill in as you copy. Claude can tidy,
shorten, continue or explain your text and answer questions from your notes, but only when you ask.

- **Files are the truth.** Every note is a plain Markdown file in a folder you pick (put it in Google Drive to have
  it everywhere). The SQLite database is only an index and can be rebuilt. If a file changed in another app while
  you were editing, both texts are kept.
- **Capture from anywhere.** `Ctrl Alt Space` (or a compositor keybind on Wayland), the tray,
  `petrel --new "text"`, `echo text | petrel --stdin`.
- **Copy is the action.** `Ctrl K` has Copy, Copy as Markdown and Copy formatted. The quick picker
  (`Ctrl Alt V`) finds a prompt or snippet from any app, fills its blanks and copies it.
- **AI on request.** `Ctrl J` on a note: tidy, shorten, make a list, continue, or a custom ask. The old text is
  shown struck through until you keep or drop the change; a version is taken first. `Ctrl K` then a question asks
  your notes. Needs an Anthropic API key in Settings, kept in the OS keyring.
- **Never loses text.** Autosave, versions (`Ctrl H`), deleted notes go to `.trash/` in the folder, undo with `z`.

## Keys

| Where | Keys |
|---|---|
| Anywhere | `Ctrl K` search, commands or ask · `Ctrl P` find a note · `Ctrl N` new note · `Ctrl 1` home · `Ctrl 2` inbox · `Ctrl ,` settings |
| A note | `Ctrl J` AI · `/` on an empty line for AI · `Ctrl Shift C` copy as Markdown · `Ctrl H` history · `[[` link |
| Inbox | `j` `k` move · `Enter` open · `m` file into a note or collection · `1`–`3` the suggested homes · `d` delete · `z` undo |
| Capture window | `Tab` choose where it goes · `Ctrl Enter` or `Esc` done (an empty capture is dropped) |
| Quick picker | type to find · `Enter` copy and close · `Tab` next blank · `Ctrl O` open in Petrel |

The design: [docs/design/petrel.md](docs/design/petrel.md). Notes rules: [docs/design/notes.md](docs/design/notes.md).
Command line: [docs/cli.md](docs/cli.md).

## Building from source

Linux (Arch, including Omarchy):

```
sudo pacman -S --needed base-devel rustup nodejs npm webkit2gtk-4.1 librsvg libayatana-appindicator libsecret gnome-keyring
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

`Esc` or `Ctrl Enter` saves and closes it; `Tab` picks a note or collection to file it in. The capture window stays on top.
In `npm run dev` the capture window is [http://localhost:1420/?capture](http://localhost:1420/?capture).

Petrel keeps running in the tray: closing the window hides it, and the tray menu has Capture, Quick picker, Show,
Pause hotkeys and Quit. On Linux the tray needs `libayatana-appindicator` and a tray host (Waybar's `tray` module on Omarchy); without
one, closing the window quits as before. On Windows a left click on the icon shows the window.

`Ctrl Alt Space` opens the capture window and `Ctrl Alt V` the quick picker from any app on Windows and X11 (change
them or turn them off in Settings, `Ctrl ,`; pause them from the tray). On Wayland apps can't grab keys, so bind
`petrel --capture` and `petrel --picker` in the compositor as above. In `npm run dev` the picker is
[http://localhost:1420/?picker](http://localhost:1420/?picker). Settings also has "Start at login", which starts Petrel hidden in the tray.

Text from the command line goes straight to `inbox/` without a window ([docs/cli.md](docs/cli.md)):

```
petrel --new "call the bank" --tag errand
git log -1 | petrel --stdin --tag git
```

## Project layout

```
crates/petrel-core/      the engine (Rust, no UI)
  src/notes.rs           the notes folder: scan, index, save with conflict copies, move, merge, trash, versions
  src/links.rs           [[links]] and backlinks
  src/store.rs           SQLite schema, migrations with backup, settings, the old drafts tables
  examples/store_bench.rs  timings on a 50,000-draft store
src-tauri/               the desktop shell and CLI: commands, windows (main, capture, picker), tray, hotkeys, AI
src/                     the UI (SolidJS): home, inbox, collections, the writing page, command bar, picker
```

## License

[MIT](LICENSE) © Nedim Perva.
