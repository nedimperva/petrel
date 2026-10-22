# Backlog (owner-prioritized)

New ideas go here, not into an active package. Each entry: one line, the milestone it could fit, why it waits.

- Arrange mode (drag lines/blocks) — M4+; needs a design that works with the keyboard.
- Vim keybindings (CodeMirror `@replit/codemirror-vim`) — bundle cost; after M3 behind a lazy import.
- Dictation (Linux: whisper.cpp local; Windows: platform speech) — M4; local-only.
- Shared action directory: a git repo of Petrel action JSON with a browse/install panel — M4.
- Themes beyond light/dark (tokens file per theme) — M4.
- Markdown export to HTML/PDF via the preview — M2 if trivial, else M4.
- Draft templates (new draft from a template, `[[template|…]]` as a starting point) — M2 candidate.
- Scheduled actions (run an action on a workspace daily) — M4; timers run only while Petrel runs.
- Per-draft syntax auto-detection — low priority.
- Append-to-draft from the capture window (choose a target draft) — M2 candidate.
- Encryption at rest (SQLCipher) — only if asked; keyring-held key.
- Tern integration beyond `mailto:` (`tern --compose --body-file`) — when Tern exposes it.
- A `petrel-core` C ABI or Node binding for third-party tooling — not planned.
