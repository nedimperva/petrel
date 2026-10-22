# Sprint 4 — Scripting

**Status:** not started

## Delivery scope

**M2.** The `script` step and the JavaScript API from [actions.md](../design/actions.md) §Scripting, on the runtime
chosen in package 03. Vendor objects are not in scope at any milestone; they belong to actions in the directory (M4).

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Goal

A script written for the familiar `draft` / `editor` / `app` / `Prompt` / `HTTP` shape runs in Petrel unchanged
when it stays inside the documented subset, cannot touch anything the action didn't allow, and cannot hang the app.

## Tasks

### Runtime (`script.rs`)
- [ ] One runtime per run; interrupt handler tied to the cancellation token; memory limit (default 64 MB);
      time limit per step.
- [ ] Host-call bridge: a synchronous-looking call from JS suspends the runtime thread on a channel; the core
      forwards the request to `Host`; the reply resumes. Test with `RecordingHost` and with a fake slow host.
- [ ] `console.*` to the run log; uncaught exception → `Failed` with the message and line.
- [ ] `NotSupported` error class with the object name, thrown by stubs for every name in the "Not provided" list.

### API objects
- [ ] `draft`, `editor` (headless model when no window), `app`, `context`, `console`.
- [ ] `Draft` (create/find/query/tags), `Prompt`, `HTTP` (reqwest, `allowHttp`), `FileManager` (`allowFiles`,
      scope confirm), `Credential` (keyring `petrel/<identifier>`), `Shell` (`allowShell`), `Action`,
      `ActionGroup`, `Workspace`, `Template`, `Base64`, `Markdown`.
- [ ] A test script per object under `crates/petrel-core/tests/scripts/*.js`, run by `cargo test`.
- [ ] `docs/scripting.md`: the user-facing API reference generated from the same tables as actions.md, with examples.

### UI
- [ ] Script field in the action editor: CodeMirror with JavaScript highlighting, run log pane under it, "Test".
- [ ] Prompt dialogs rendered from the `Prompt` description (buttons, fields, select, switch, date).
- [ ] Permission toggles (shell/files/http) on the action with an explanation line each.

## Acceptance (owner)
- [ ] Five scripts from the owner's Drafts library run or fail with a message naming the missing object.
- [ ] An infinite loop script is stopped by `Esc` within a second and the app stays responsive.
- [ ] A script using `Credential` + `HTTP` posts to a test endpoint; the key is visible in `seahorse`, not in SQLite.

## Decisions

## Log
