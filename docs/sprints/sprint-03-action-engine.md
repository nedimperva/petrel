# Sprint 3 — Action engine

**Status:** in progress · started 2026-10-23 (engine slice: PR from `claude/project-thread-1p0dru`)

## Delivery scope

**M0:** the template engine with its test table, the scripting-runtime decision gate. **M1:** the run algorithm,
the `Host` trait with Tauri/CLI/recording implementations, all built-in steps except `script`, the action list
and action editor, after-success, per-action shortcuts, the action log. **M2:** `script` (package 04),
`htmlPreview` polish, dry-run "Test" in the editor. Spec: [actions.md](../design/actions.md).

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Goal

One key sends the draft where it belongs. Actions are JSON, run the same from the window and the CLI, never
modify a draft they failed on, and tell you exactly which step broke and why.

## Tasks

### Template engine (M0)
- [x] `template.rs`: tokenizer for `[[…]]`, `\[[`, `{{…}}`, `%%…%%`; `Tags` trait, `TagSource` over a draft.
- [x] All tags in the spec table; strftime via `chrono` (a bad format is an unknown tag, not a panic); relative
      dates (`+N day/week/month/year/hour/minute`, `today`/`tomorrow`/`yesterday`, weekday names); `line|n..m`.
- [x] `template|name` includes with depth limit 5; `env|NAME`.
- [x] 68-case test table plus encoding, includes, selection, month/year/leap-day cases; unknown tags preserved and
      reported.

### Decision gate — scripting runtime (M0)
- [x] Spike in `crates/petrel-core/examples/runtime_spike/`: rquickjs and boa running the same 5 scripts
      (string work, a class, async/await over a host call, an infinite loop interrupted, a 64 MB allocation
      refused). deno_core excluded on size (see Decisions). Measured on Linux; Windows numbers when the owner builds
      the spike there (`cargo run --release --features quickjs` in the spike directory).
- [x] Write up in **Decisions**: numbers, build pain, recommendation. **Owner chose rquickjs (2026-10-22).**

### Engine (M1)
- [x] `action.rs`: `Action`, `Step` enum (serde tagged), the spec's algorithm as `prepare` → `execute` →
      `finish` (and `run` for all three); `RunOutcome { Ok, Stopped, Cancelled, Failed { step, message } }`.
- [x] `host.rs`: `trait Host { clipboard_get/set, open_url, read_file, write_file, run_command, confirm,
      confirm_scope, prompt, preview, message }` with `RecordingHost`, and `host::system` (files; processes with
      stdin, 1 MB output cap, timeout and cancel killing the process group). `keyring_get/set` waits for package 04
      (`Credential`); `CliHost` for package 07's CLI; `TauriHost` in the UI slice.
- [x] Steps: `insertText`, `clipboard`, `url`, `file`, `runCommand`, `runAction`, `prompt`, `htmlPreview`
      (Markdown via pulldown-cmark, user CSS from `css/`), `mail`, `setTags`/`setFlag`/`move`, `openDraft`,
      `unsupported`, `script` stub. Tests against `RecordingHost`, including the failure path leaving the stored
      draft untouched.
- [x] Cancellation token checked between steps; a running command is killed on cancel; 60 s per run, 30 s per
      command.
- [x] `action_runs` logging; `Store::action_log(limit)`.
- [x] Actions mirrored to `<data dir>/actions/<group>/<name>.json` on change (rename moves, delete removes);
      reading back is package 06.
- [x] Default group "Basics", added once on first start (`Store::seed_default_actions`): Copy (`c`), Copy as
      Markdown link, Save to file, Open as URL, Search the web, Send as mail, Append to journal, Copy with
      `wl-copy` / `clip`. Other shortcuts are left for the owner to choose in the editor.

### UI (M1)
- [ ] Action list column: groups, rows with colour/icon/name/keycap, run state, result toast with "Log".
- [ ] Action editor panel: fields from step schemas; drag to reorder steps; shortcut recorder with conflict
      detection; "Test on current draft" with a `DryRunHost` that returns what would happen.
- [ ] Action log panel (`g l`): runs with status, step, message, "Run again".
- [ ] Trust: `trusted_hash` set on save from the action editor; one-time dialog for untrusted actions listing all
      rendered commands and out-of-scope paths; cleared when `steps` change outside the editor. Tests for each path.
- [ ] Login-shell `PATH` resolved once at startup (`$SHELL -lc`), cached in `settings`, exported to every command;
      `sh` default on Linux, PowerShell on Windows, per-step override.

### Later (M2)
- [ ] `htmlPreview` with user CSS and "Continue".
- [ ] Action editor: duplicate, move to group, import/export buttons (package 06).

## Acceptance (owner)
- [ ] Copy, Save to file, Append to journal and Run command work on Omarchy from the keyboard; the file and the
      journal appear where expected; a deliberately broken command shows "Failed at step 1: …" and the draft is unchanged.
- [ ] `petrel run "Save to file" --draft <uuid>` from a terminal does the same as the window.

## Decisions

- 2026-10-23 — **A run is three phases** so the store lock is never held while a step waits on a person or a
  process: `prepare` (store: load, `before_action` version), `execute` (no store; steps edit a working copy through
  `Host`), `finish` (store: one transaction for content, tags, flag, folder, after-success and `add_tags`, then
  trust and the log row). `finish` writes only fields that differ from what `prepare` read, so a run that only
  copies text does not touch `modified_at`.
- 2026-10-23 — **Editor positions are UTF-16 code units**, as CodeMirror reports them and as `drafts.cursor`
  already stores them. The engine converts at the edges.
- 2026-10-23 — **Trust is checked per action, nested ones included,** before its first step: every rendered
  `runCommand` and every `file` path outside the data folder, in one `confirm_scope`. Yes records
  `sha256(steps JSON)`; `Action.trusted` is "the stored hash matches the steps", so any change outside the editor
  untrusts it. Paths inside the data folder (`files/`, the journal) never ask.
- 2026-10-23 — **Small choices made while the owner was away** (each easy to change):
  - `[[tags]]` joins with `, `.
  - `[[longdate]]` is English (`Saturday, January 31, 2026`). chrono's locales would add a large table.
  - `[[[title]]](url)` reads as `[` + `[[title]]`, so a Markdown link around a tag works.
  - `$5` is text (a variable name starts with a letter or `_`).
  - A first `date` argument starting with `+`/`-` that does not parse is an unknown tag, not a format.
  - A nested action's `add_tags` apply; its after-success does not (only the action you ran decides that).
  - `runCommand` output loses one trailing newline.
  - "Save to file" overwrites (it is the latest copy of the draft); "Append to journal" writes under
    `<data dir>/files/journal/`.
  - Windows paths in templates use `/`: `\[[` is the template escape, so `C:\notes\[[title]].md` would not
    render. Windows accepts `/`.

- 2026-10-22 — **Decision gate: scripting runtime. Recommendation: rquickjs (QuickJS).** Measured in the sandbox
  (4 vCPU, release, LTO, stripped), same scripts:

  | | rquickjs 0.9 | boa 0.20 |
  |---|---|---|
  | binary (whole spike) | 1.37 MB | 5.87 MB |
  | runtime + context init | 0.19 ms | 0.75 ms |
  | string work (20k concatenations, regex named groups, JSON) | 93 ms | 464 ms |
  | classes, private fields, destructuring, `?.`/`??`, template literals | 0.13 ms, correct | 0.29 ms, correct |
  | `await host.clipboard()` twice (Rust function, job queue) | works | works |
  | infinite loop | **interrupt handler**: stopped at 100.1 ms, "interrupted" | no interrupt API; only a loop-iteration cap (10 M iterations took 530 ms, and time-based cancel is impossible) |
  | 64 MB allocation with a 32 MB limit | **refused**: "out of memory" | no memory-limit API; allocated 64 MB in 336 ms |
  | build | C via `cc`, no libclang needed when the `bindgen` feature is off (pre-generated bindings exist for x86_64/aarch64 Linux, Windows MSVC, macOS) | pure Rust, longest compile of the three |

  deno_core was not built: rusty_v8 downloads a ~100 MB prebuilt V8 and adds ~30 MB to the binary. For an app
  whose point is a 300 ms cold start that is disqualifying before any measurement; V8's speed is not needed for
  scripts that mostly call the host. Boa fails two hard requirements (`Esc` must stop a script within a second;
  a script must not be able to take the machine's memory). QuickJS meets every requirement with a 1.4 MB cost.
  Risks to note: QuickJS string concatenation in loops is slow (93 ms for 20k) — fine for action scripts, and
  `Array.join` is the idiom anyway; `bindgen` off means a new target triple needs bindings generated once.
  **Owner decided 2026-10-22: rquickjs.** Package 04 builds on `rquickjs` with features `futures`, `macro`; the
  `bindgen` feature stays off (pre-generated bindings cover Linux, Windows MSVC and macOS).

## Log

- 2026-10-23 — Engine slice: `template.rs`, `host.rs`, `action.rs`, `store_actions.rs` (actions CRUD, mirror,
  trust, commit, run log, default group). 76 engine tests (48 before). `store_bench` has two action rows (PLAN:
  < 20 ms): Copy 0.21 ms, three steps + archive 0.55 ms at 50k drafts. Tauri commands, `TauriHost` and the action
  list and editor UI are the next PR.
