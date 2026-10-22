# M2 — Focused Linux beta checklist

## Scripting
- [ ] Five scripts from the owner's library run, or fail naming the missing object.
- [ ] Infinite loop stopped with `Esc` in < 1 s.
- [ ] `Credential` + `HTTP` against a test endpoint; key in the keyring only.

## Import / export
- [ ] Owner's full Drafts action library imported; report reviewed; disabled actions explain themselves.
- [ ] Export all drafts as `.md`; import them into a fresh database; counts match.
- [ ] Mirror folder + Syncthing to a second machine.

## Workspaces, links, preview
- [ ] A workspace switches filters, sort and action group in one command.
- [ ] `[[Title]]` completes and opens; missing target offers to create.
- [ ] Preview with the owner's CSS.

## Distribution
- [ ] AppImage installs and self-updates to the next build; `.deb` on a Debian VM; AUR `petrel-bin` builds.
- [ ] `docs/beta.md` followed by a tester on a clean machine without help.
- [ ] Tester group used Petrel for several weeks; no text-loss report open.
