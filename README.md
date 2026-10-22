# Petrel

**Capture text first, act on it later. Fast, local-first, keyboard-first, for Linux and Windows.**

Linux first, then Windows · Rust · Tauri 2 · SolidJS · SQLite · MIT

> **Petrel is in planning (0.0).** There is no build yet. The roadmap, architecture, schema and the action
> engine specification are in [`docs/`](docs/PLAN.md). A sibling of [Tern](https://github.com/nedimperva/tern),
> built on the same stack and conventions.

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

## Project layout (planned)

```
crates/petrel-core/      the engine (Rust, no UI)
  src/store.rs           SQLite schema, migrations, list/search queries, versions, sweep
  src/template.rs        [[tag]] engine
  src/action.rs          actions, steps, the run algorithm
  src/host.rs            Host trait: clipboard, URLs, files, shell, keyring, HTTP, prompts
  src/script.rs          JavaScript runtime and API
  examples/store_bench.rs  timings on a 50,000-draft store
src-tauri/               the desktop shell and CLI: commands, windows, tray, deep links, updater
src/                     the UI (SolidJS): editor, list, action column, command bar
```

## Contributing

Not yet — the first packages are being built. Ideas go to Discussions; once there is code, read
`docs/sprints/README.md` before opening a PR.

## License

[MIT](LICENSE) © Nedim Perva. Petrel is an independent project and is not affiliated with or endorsed by
Agile Tortoise, Inc.; "Drafts" is their trademark.
