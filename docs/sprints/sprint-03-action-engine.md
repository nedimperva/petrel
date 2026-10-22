# Sprint 3 — Action engine

**Status:** not started

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
- [ ] `template.rs`: tokenizer for `[[…]]`, `\[[`, `{{…}}`, `%%…%%`; `Tags` trait resolved against a `Context`.
- [ ] All tags in the spec table; strftime via `chrono`; relative date parser (`+1 day`, `monday`); `line|n..m`.
- [ ] `template|name` includes with depth limit; `env|NAME`.
- [ ] 60+ case test table; unknown tags preserved and reported.

### Decision gate — scripting runtime (M0)
- [ ] Spike in `crates/petrel-core/examples/runtime_spike/`: rquickjs, boa, deno_core each running the same 5
      scripts (string work, a class, async/await over a host call, a 10 s infinite loop interrupted, a 64 MB
      allocation refused). Measure binary delta, init time, run time, on Linux and Windows CI.
- [ ] Write up in **Decisions**: numbers, build pain, recommendation. Owner picks. Expected: rquickjs.

### Engine (M1)
- [ ] `action.rs`: `Action`, `Step` enum (serde tagged), `Context`, `run()` exactly as the spec's algorithm;
      `RunOutcome { Ok, Stopped, Cancelled, Failed { step, message } }`.
- [ ] `host.rs`: `trait Host { clipboard_get/set, open_url, read/write/append file, run_command, confirm,
      confirm_scope, prompt, message, preview, keyring_get/set }` with `RecordingHost` for tests, `CliHost` for the
      binary without a window, `TauriHost` in `src-tauri`.
- [ ] Steps: `insertText`, `clipboard`, `url`, `file`, `runCommand`, `runAction`, `prompt`, `htmlPreview`
      (minimal), `mail`, `setTags`/`setFlag`/`move`, `openDraft`, `unsupported`, `script` stub. Each with tests
      against `RecordingHost`, including the failure path leaving the stored draft untouched.
- [ ] Cancellation token checked between steps; shell killed on cancel; time limits per spec.
- [ ] `action_runs` logging; `Store::action_log(limit)`.
- [ ] Actions mirrored to `<data dir>/actions/<group>/<name>.json` on change; reading back is package 06.
- [ ] Default action group shipped on first run: Copy (`c`), Copy as Markdown link, Save to file (`~/Documents/
      Petrel/[[safe_title]].md`), Open as URL, Search the web, Send as mail, Append to journal
      (`journal/[[date]].md`), Run command (`wl-copy`/`clip` example). Shortcuts per [ui.md](../design/ui.md).

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

## Log
