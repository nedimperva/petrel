# Changelog

Release notes for Petrel. The release workflow takes a version's notes from its section here; a tag without a
section fails. Keep entries short and in the user's language: what changed for them, not which file moved.

## 0.3.0

- Faster: Petrel starts quicker, screens are lighter, sync and AI answer sooner.
- Finding: Bosnian letters match without their marks (c finds č and ć), best matches come first, small typos are
  forgiven.
- Writing: Markdown marks stay out of sight off the line you are on (quotes, bullets, rules, links, pictures too);
  code blocks and tables look like themselves; a pasted link takes the selected words; templates; task days;
  Ctrl + and Ctrl - size the text.
- The picker can paste for you. AI reads the part of a long note that matters, can ask within a filter or one
  note, shows similar notes and what an answer cost, and remembers your asks.
- Sync merges edits that do not touch each other instead of making a conflict copy, syncs one last time on Quit,
  and Settings › Sync shows what it did lately.
- The trash, opened from Ctrl K: look at what went, put it back, empty what is older than a month.
- Narrow windows fit: today's times stay whole, the margin waits at the right as a line per heading and opens on
  hover, the key hints keep to one line.
- Enter and Esc work again on an AI suggestion once it is done.

## 0.2.0

- Google Drive sync, built in: sign in from Settings › Sync, notes go to `My Drive/Petrel`, file by file, with a
  conflict copy when both sides changed. The sidebar foot shows how sync is doing.
- Each note's history lives in the folder, so versions sync too.
- The capture window and the picker open at once: they stay ready in the background.
- Quick capture is a quiet bar with an "Adding to" line; Ctrl D sends the new words to today's page, and
  Settings › Capture sets how long the window keeps adding to the last capture.
- Today's page shows its tasks.
- Ctrl K opens on notes; every key label matches the key list; `Ctrl /` shows all the shortcuts.
- A quieter margin, lighter Markdown marks, one type scale, a search line in the picker.
- Cards show blanks one way; Settings has a title bar; `@` forgives typos.
- On Hyprland the capture window and the picker float and stay on top.

## 0.1.0

- First release with installers for Windows and Linux, and updates from inside the app.
