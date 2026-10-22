# M1 — Linux private alpha checklist

Ticked by the owner on Omarchy. Agent prepares steps; owner verifies. A failed line reopens the gate.

## Capture
- [ ] Cold launch to a focused empty editor; measured cold-start recorded in `sprint-00` Results.
- [ ] Hyprland keybind → capture window → type → `Esc`: the draft is in Inbox.
- [ ] `echo hi | petrel --stdin --tag test` → tagged draft appears without the window being touched.
- [ ] `xdg-open "petrel://create?text=hello"` creates a draft.
- [ ] Type for a minute, `kill -9` Petrel, relaunch: at most the last 300 ms missing.

## Editor
- [ ] Markdown highlighting, list continuation, checkbox toggle, move line, link insert work.
- [ ] Cursor returns to where it was when reopening a draft.
- [ ] Focus mode hides everything but the text.

## List and search
- [ ] `Ctrl L`, `j`/`k`, `Enter`, `Esc`; Inbox/Flagged/Archive/Trash; tag chips; `/` search instant on the owner's library.
- [ ] Batch `x` then `e`: archived; `z` brings them back.
- [ ] `Ctrl K` finds a draft by a word in its body.

## Actions
- [ ] Default group: Copy, Save to file, Append to journal, Open as URL, Send as mail (Tern opens), Run command.
- [ ] Each from its shortcut; after-success archive works; toast and log entry.
- [ ] A broken command: "Failed at step N" and the draft unchanged; version exists from before the run.
- [ ] `petrel run "Save to file" --draft UUID` from a terminal.

## Safety
- [ ] Trash → 30 days (clock change) → tombstone. Empty trash confirms.
- [ ] Versions panel: restore an older version; the current text became a version first.
- [ ] Database backup exists under `backups/` after a migration.

## Two weeks
- [ ] Owner used Petrel for all quick capture for two weeks. Nothing lost. Notes:
