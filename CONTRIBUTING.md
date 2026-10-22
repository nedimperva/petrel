# Contributing to Petrel

Bug reports, ideas and pull requests are welcome. Petrel is early; the plan in `docs/PLAN.md` says what is in
scope for the first release and what waits.

- **Reports:** say what you did, what you expected and what happened, with your OS, desktop (for Linux: the
  compositor) and the Petrel version from Settings → About. Attach `petrel.log` from the data folder if it helps.
- **Ideas:** open a Discussion. New features go to `docs/sprints/sprint-12-plus-backlog.md` first, not into an
  active package.
- **Code:** read `docs/sprints/README.md` for how work packages run, `docs/design/ui.md` before UI changes,
  `docs/design/actions.md` before engine changes, `docs/research/data-model.md` before schema changes. Run
  `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` and
  `npm run build` before pushing; CI runs the same on Linux and Windows. Keep PRs small and write a "How to
  test" section.

By contributing you agree your work is licensed under the MIT license in `LICENSE`.
