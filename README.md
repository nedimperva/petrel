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
  `petrel --new "text"`, `echo text | petrel --stdin`. Text selected in the app you were in comes along as a quote
  with where it came from. `@recipes`, `@today` or a day (`@fri`, `@nov20`) in a capture files it there,
  `@Groceries` adds it to that note (`#` stays a heading). Opened again within two minutes, the window adds to
  the last capture.
- **File it later, one card at a time.** Inbox review (`r` in the library): a number files a capture, the places
  you use most come first. Collections get a colour and a mark of their own (`t`).
- **A page for today.** `Ctrl D` opens `journal/YYYY-MM-DD.md`; `Alt ←` and `Alt →` go through the days. On
  today's page, Enter on an empty line starts the next entry with the time.
- **Pictures.** Paste or drop one into a note: it is saved next to the note in `attachments/` and moves with it.
- **Copy is the action.** `Ctrl K` has Copy, Copy as Markdown and Copy formatted. The quick picker
  (`Ctrl Shift Space`) finds a prompt or snippet from any app, fills its blanks and copies it; what you used in that app
  comes first. Blanks can fill themselves (`{{clipboard}}`, `{{today}}`, `{{selection}}`), offer choices
  (`{{tone: formal / casual}}`) and remember your last answers. `## headings` in a prompt are versions of it.
- **Two notes at once.** `Ctrl \` opens a second note beside the one you write in; `Ctrl Tab` goes back to the
  last one. A note with headings shows them in the margin.
- **The folder is live.** A note changed in Drive reloads where you were; a note changed in two places gets a
  card in the library to settle it side by side. Pasted web pages come in as clean Markdown.
- **AI on request.** `Ctrl J` on a note: tidy, shorten, make a list, continue, or a custom ask. The old text is
  shown struck through until you keep or drop the change; a version is taken first. Your own prompts (the Prompts
  collection) are on `Ctrl J` too. `Ctrl K` then a question asks your notes, and `Tab` asks again. The week, when
  you ask: what you wrote, what is still open, and a few sentences on it. Needs an
  Anthropic API key in Settings, kept in the OS keyring.
- **Never loses text.** Autosave, versions (`Ctrl H`), deleted notes go to `.trash/` in the folder, undo with `z`.

## Keys

| Where | Keys |
|---|---|
| Anywhere | `Ctrl K` search, commands or ask (`in:travel`, `pinned`, `today`, `this week`, `has:link`, `has:picture`, `has:task`) · `Ctrl P` find a note · `Ctrl N` new note · `Ctrl D` today's page · `Ctrl L` library · `Ctrl 0` the sidebar · `Ctrl Tab` the note before (hold `Ctrl` for the last few) · `Ctrl Shift Enter` a note beside · `Ctrl ,` settings |
| Settings | `Ctrl ,` or the sliders in the title bar: General, Writing, Look, Capture, Keys (click a shortcut, press the new keys; on Omarchy the capture and picker show the `bind` line to copy), AI, About |
| Shortcuts | `Ctrl /`, or `?` when not typing: every shortcut on this computer |
| Sidebar | click a collection to open it · `F2` or a double-click renames it · right-click or `⋯`: colour and mark, pages or to copy, a collection inside, show in the folder, the trash · "New collection" makes one |
| Ctrl K | the last row asks your notes · an answer: `Tab` ask again · `Ctrl Enter` save the exchange · "Open tasks in every note": `x` tick · `Enter` open · `Esc` in a panel goes back to Ctrl K |
| Today's page | opens on a new line with the time · `Alt ←` `Alt →` other days · `Enter` on an empty line stamps the time · the week is in `Ctrl K` |
| A note | headings, links and related notes in the right margin · `Ctrl J` or `/` on an empty line: the AI menu (`↑` `↓` choose, type to narrow or to ask; your prompts at the end) · `Ctrl Shift C` copy as Markdown · `Ctrl H` history · `Ctrl M` move it · `[[` link · `Alt Enter` follow it · `Shift Enter` open it beside · `Esc` close the note beside |
| Library | a list beside the item, always open · `↑` `↓` or `j` `k` move · `Enter` copy (in the inbox: file) · `c` copy · `e` edit · `p` pin · `t` look, and pages or things to copy · `/` filter · `m` move, `d` delete, `r` one at a time in the inbox · `z` undo · `Esc` back to writing |
| Inbox review | `1`–`6` file · `/` somewhere else · `Space` keep for later · `e` edit · `d` delete · `s` suggest a home · `z` undo · `Esc` stop |
| An opened card | `Enter` copy (fill the blanks first) · `Tab` next blank · `Alt ←` `Alt →` other versions · `↑` earlier answers · `1`–`9` pick a choice · `e` edit · in the inbox: `m` move · `s` suggest a home · `1`–`3` pick one · `d` delete |
| To settle (a card in the inbox) | `1` keep the note · `2` keep the other text · `3` or `b` keep both · `Esc` later |
| Capture window | `@topic`, `@today`, `@fri`, `@nov20` or `@Note` says where it goes · `Ctrl K` choose from a list · `Esc` done (an empty capture is dropped) · `Ctrl Enter` done, or a new capture when adding to the last one |
| Quick picker | type to find (things to copy; matching notes after them) · `Enter` copy and close · `Alt ←` `Alt →` other versions · `Tab` next blank · `Ctrl O` open in Petrel |

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

`petrel --capture` opens the small capture window (or focuses it), `petrel --picker` the quick picker; a second
launch hands the flag to the running Petrel. Bind them in Hyprland:

```
bind = SUPER, N, exec, petrel --capture
bind = SUPER, V, exec, petrel --picker
```

On Wayland no app can grab a key for itself, so `Ctrl Shift Space` does nothing until it is bound as above
(`bind = CTRL SHIFT, SPACE, exec, petrel --picker` if you want that key). If the picker still tiles, Petrel's log
(`~/.local/share/io.github.nedimperva.petrel/petrel.log`) has a `hyprctl` line with what Hyprland answered.

On Hyprland (Omarchy) Petrel floats both windows, sizes them, centres them and pins them to every workspace
itself, through `hyprctl`, each time they open, so no window rule is needed. If you want rules anyway: every Petrel
window shares the app id, so match by title. Hyprland before 0.48:

```
windowrulev2 = float, title:^(Petrel (capture|picker))$
windowrulev2 = center, title:^(Petrel (capture|picker))$
windowrulev2 = pin, title:^(Petrel (capture|picker))$
```

From 0.48 `windowrulev2` is gone and `windowrule` takes the same arguments (`windowrule = float, title:^(Petrel
(capture|picker))$`, and the same for `center` and `pin`). Hyprland 0.53 changed rules to `match:` fields with
effects (`windowrule = match:title ^(Petrel (capture|picker))$, float on, center on, pin on`); check the Hyprland
wiki for the version you run.

`Esc` or `Ctrl Enter` saves and closes it; `@recipes`, `@today`, `@fri` or `@Groceries` says where it goes, and
`Ctrl K` picks a place from a list. The capture window stays on top.
Opened again within two minutes, it adds to the last capture; `Ctrl Enter` makes the new text its own.
In `npm run dev` the capture window is [http://localhost:1420/?capture](http://localhost:1420/?capture).

Petrel keeps running in the tray: closing the window hides it, and the tray menu has Capture, Quick picker, Show,
Pause hotkeys and Quit. On Linux the tray needs `libayatana-appindicator` and a tray host (Waybar's `tray` module on Omarchy); without
one, closing the window quits as before. On Windows a left click on the icon shows the window.

`Ctrl Alt Space` opens the capture window and `Ctrl Shift Space` the quick picker from any app on Windows and X11 (change
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
src/                     the UI (SolidJS): title bar, card library, the writing page, command bar, picker
```

## License

[MIT](LICENSE) © Nedim Perva.
