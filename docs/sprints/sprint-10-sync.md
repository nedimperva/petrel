# Sprint 10 — Sync

**Status:** deferred (M4)

## Delivery scope

**M4 only.** Nothing in M1–M3 depends on this package; the schema's UUIDs, timestamps and tombstones are its
preparation. Owner-approved scope and acceptance before any code.

## Direction

1. **Folder sync first.** Turn the one-way mirror (package 06) into two-way: Petrel watches the folder, reads
   changed `.md` files (front matter carries uuid, tags, flag, folder, modified), writes its own changes, resolves
   conflicts by keeping both versions (the file copy becomes a version, the newer text wins, the status strip says
   so). Any file-sync tool (Syncthing, Dropbox, a git repo) then carries Petrel between machines.
2. **WebDAV second**, only if folder sync proves insufficient: the same file format over a user's WebDAV server.
3. **Never a Petrel service.**

## Open questions
- Conflict UI; actions/workspaces in the same folder (`actions/`, `workspaces.json`); whether versions sync (no).

## Decisions

## Log
