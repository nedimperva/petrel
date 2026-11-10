# Security

Petrel keeps your notes as Markdown files in a folder you pick and an index in a SQLite file on your disk. It
talks to the network only when you ask Claude something (tidy, continue, ask my notes, …): then the text of that
note, or the notes that match your question, go to the Anthropic API with your key. The key is kept in the OS
keyring (service `petrel`), never in a file. Without a key nothing is sent.

**Found a vulnerability?** Please report it privately through GitHub's "Report a vulnerability" button on the
Security tab rather than a public issue. You will get an answer within a week. Supported version: the latest
release.
