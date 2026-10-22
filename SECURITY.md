# Security

Petrel keeps your text in a SQLite file on your disk and talks to nothing unless an action you run asks it to.
Actions can run shell commands, write files and make HTTP requests; the design that limits this is in
`docs/design/actions.md` (per-action permissions, one-time trust for actions you did not write, secrets only in
the OS keyring, scripts in a sandboxed runtime).

**Found a vulnerability?** Please report it privately through GitHub's "Report a vulnerability" button on the
Security tab rather than a public issue. You will get an answer within a week. Supported version: the latest
release.
