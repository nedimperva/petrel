# Sprint 9 — Distribution and launch

**Status:** not started

## Delivery scope

**M0:** `check.yml`, `security.yml`. **M2:** Linux packages (AppImage self-updating, .deb, .rpm, AUR `petrel-bin`),
`release.yml` with signing key, CHANGELOG-driven release notes, tester guide, app icon approval. **M3:** Windows
installers in the same pipeline. The project website and a public announcement are owner tasks after M3.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Tasks

- [ ] Copy Tern's `release.yml`, `update.rs`, `packaging/aur/` and adapt names; a tag without its CHANGELOG
      section fails the release.
- [ ] `docs/beta.md` tester guide: install, first run, where data lives, backups, downgrade, reporting.
- [ ] `docs/acceptance/m1-alpha.md`, `m2-beta.md`, `m3-windows.md` checklists written from each package's
      acceptance lists before the milestone starts.
- [ ] App icon: owner approval recorded in `docs/acceptance/app-icon.md`.
- [ ] README sections: Install, Keys, Actions quick start, Building, Project layout, Compatibility statement
      (verbatim from actions.md), Not affiliated with Agile Tortoise.

## Decisions

## Log
