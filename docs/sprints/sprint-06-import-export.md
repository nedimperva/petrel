# Sprint 6 — Import, export, compatibility

**Status:** not started

## Delivery scope

**M2.** Petrel action/group JSON both ways; Drafts `.draftsAction` / `.draftsActionGroup` import with a report;
draft export (Markdown files, a JSON dump); the mirror-to-folder export for Syncthing users; reading actions
back from the mirrored `actions/` folder. Import of drafts from Drafts' export JSON is here too.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Goal

Nothing in Petrel is trapped. Actions and drafts leave as readable files and come back identical; files from
Drafts come in with an honest report of what did and did not survive.

## Tasks

### Actions
- [ ] `export_action(uuid) → JSON`, `export_group`, `import(JSON) → ImportReport`. Round-trip test.
- [ ] Drafts import: step-type mapping table from [actions.md](../design/actions.md); `data` flattening; template
      fields unchanged; unknown → `unsupported` and the action `disabled`. A fixture folder of representative
      files written by hand from the public format description (no files copied from the Action Directory
      without their licence allowing it). Report shown in a panel and written to the log.
- [ ] Read `<data dir>/actions/**.json` on start when newer than the row (`modified_at` vs mtime): editing an action
      in a text editor or pulling a git repo updates Petrel. Conflicts keep both (the file wins, the row becomes a
      version in the log).

### Drafts (the documents)
- [ ] Export selection / all: one `.md` per draft (`safe_title` + short UUID), a front-matter option (tags,
      dates, uuid) and a single `petrel-drafts.json` dump. Import the same.
- [ ] Import Drafts' JSON export (array of `{uuid, content, tags, flagged, created_at, …}`) mapping fields;
      duplicates by UUID are updated, not doubled.

### Mirror to folder
- [ ] Setting: a folder; Petrel writes every non-trashed draft as `.md` with front matter on save (debounced),
      deletes on trash, renames on title change; `mirror` table tracks path and hash. **One-way** in M2, stated
      plainly in the UI; two-way is package 10.

## Acceptance (owner)
- [ ] Export the owner's full action library from Drafts, import into Petrel: the report matches expectations;
      disabled actions show their original step names.
- [ ] Mirror folder synced by Syncthing to another machine shows the drafts as files within seconds.

## Decisions

## Log
