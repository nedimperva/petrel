//! Links between notes: the `[[` list, where a link goes, what links here, and rewriting links when a note moves.

use super::*;

impl Store {
    // ---- links -------------------------------------------------------------------------------------------------

    /// The `[[` list: notes whose title holds `text` (starting with it first). Empty `text`: the most recently
    /// opened notes.
    pub fn link_targets(&self, text: &str, limit: usize) -> Result<Vec<LinkTarget>> {
        let out: Vec<LinkTarget> = self
            .find_notes(text, limit)?
            .into_iter()
            .map(|n| LinkTarget {
                kind: "note".into(),
                id: n.id,
                title: n.title,
                folder: n.folder,
                uuid: None,
                modified_at: n.modified_at,
            })
            .collect();
        Ok(out)
    }

    /// Where the text inside `[[…]]` goes.
    pub fn resolve_link(&self, inner: &str) -> Result<Resolved> {
        let Some((target, _, _)) = links::parse_inner(inner) else {
            bail!("“{inner}” is not a link");
        };
        Ok(match target {
            Target::Note { folder: Some(folder), title } => {
                let rel = join_rel(&clean_folder(&folder), &clean_title(&title));
                let id: Option<i64> = self
                    .conn
                    .query_row("SELECT id FROM notes WHERE path = ?1 COLLATE NOCASE", params![rel], |r| {
                        r.get(0)
                    })
                    .optional()?;
                match id {
                    Some(id) => Resolved::Note { id },
                    None => match self.note_titled(&title)? {
                        // The folder moved, the title did not: still the note people mean.
                        Some(id) => Resolved::Note { id },
                        None => Resolved::Missing { title, folder: Some(folder), draft: false },
                    },
                }
            }
            Target::Note { folder: None, title } => match self.note_titled(&title)? {
                Some(id) => Resolved::Note { id },
                None => Resolved::Missing { title, folder: None, draft: false },
            },
            // Links to the old drafts (`[[d:…]]`, `[[u:…]]`) lead nowhere now; the drafts are notes in drafts/.
            Target::Draft { title } => Resolved::Missing { title, folder: None, draft: true },
            Target::Uuid(u) => Resolved::Missing { title: u, folder: None, draft: true },
        })
    }

    /// Notes and drafts that link to this note, and those that name it without a link.
    pub fn backlinks(&self, note_id: i64) -> Result<Backlinks> {
        let row = self.row(note_id)?;
        let mut out = Backlinks::default();
        for t in self.texts_with(&row.title, 500)? {
            if t.id == note_id {
                continue;
            }
            let found = links::parse(&t.text);
            if let Some(l) = found.iter().find(|l| note_matches(&l.target, &row.folder, &row.title)) {
                if out.linked.len() < BACKLINKS_MAX {
                    out.linked.push(BackRef {
                        kind: "note".into(),
                        id: t.id,
                        title: t.title,
                        line: line_at(&t.text, l.start),
                    });
                }
                continue;
            }
            if let Some(at) = find_mention(&t.text, &found, &row.title) {
                if out.mentioned.len() < BACKLINKS_MAX {
                    out.mentioned.push(BackRef {
                        kind: "note".into(),
                        id: t.id,
                        title: t.title,
                        line: line_at(&t.text, at),
                    });
                }
            }
        }
        Ok(out)
    }

    /// "Link it": turns the first plain mention of the note's title in a draft or note into a link.
    pub fn link_mention(&mut self, note_id: i64, kind: &str, id: i64) -> Result<UndoToken> {
        let title = self.row(note_id)?.title;
        let mut steps = Vec::new();
        let edit = |text: &str| -> Option<String> {
            let found = links::parse(text);
            let at = find_mention(text, &found, &title)?;
            let written = &text[at..at + title.len().min(text.len() - at)];
            let link =
                if written == title { format!("[[{title}]]") } else { format!("[[{title}|{written}]]") };
            Some(format!("{}{link}{}", &text[..at], &text[at + written.len()..]))
        };
        if kind != "note" {
            bail!("only a note can be linked now");
        }
        {
            let root = self.root()?;
            let row = self.row(id)?;
            let path = abs(&root, &row.path);
            let before = std::fs::read_to_string(&path)?;
            let (front, body) = split_front(&before);
            let Some(new_body) = edit(body) else { bail!("“{title}” is no longer mentioned there") };
            let after = format!("{front}{new_body}");
            self.note_version(id, &before, "before_link")?;
            write_atomic(&path, &after)?;
            self.index_file(&root, &row.path)?;
            steps.push(UndoStep::NoteText { path: row.path, before, after });
        }
        Ok(self.remember_notes(steps))
    }
}
