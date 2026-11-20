//! Collections' looks (`<top>/.petrel`): colour, mark, whether they hold things to copy, and their templates.

use super::*;

impl Store {
    // ---- collections' looks ------------------------------------------------------------------------------------

    /// Each top folder's look (colour and mark), from its `.petrel` file. Folders without one are left out.
    pub fn topic_faces(&self) -> Result<HashMap<String, TopicFace>> {
        let root = self.root()?;
        let mut out = HashMap::new();
        let Ok(entries) = std::fs::read_dir(&root) else { return Ok(out) };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !e.path().is_dir() {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(e.path().join(FACE_FILE)) {
                let f = parse_face(&text);
                if f.color.is_some() || f.mark.is_some() || f.copy.is_some() {
                    out.insert(
                        name,
                        TopicFace {
                            color: f.color.unwrap_or_default(),
                            mark: f.mark.unwrap_or_default(),
                            copy: f.copy.unwrap_or_default(),
                        },
                    );
                }
            }
        }
        Ok(out)
    }

    /// Sets a top folder's colour, mark and kind (`copy`: `yes`, `no`, or empty for the default). Lines in
    /// `.petrel` Petrel does not know are kept.
    pub fn set_topic_face(&mut self, top: &str, color: &str, mark: &str, copy: &str) -> Result<TopicFace> {
        let root = self.root()?;
        let top = clean_folder(top);
        if top.is_empty() || top.contains('/') || top == INBOX_DIR {
            bail!("only a collection (a top folder) has a look of its own");
        }
        let (color, mark, copy) = (face_word(color)?, face_word(mark)?, face_word(copy)?);
        if !matches!(copy.as_str(), "" | "yes" | "no") {
            bail!("a collection is to copy (yes) or pages (no), not {copy}");
        }
        let dir = abs(&root, &top);
        if !dir.is_dir() {
            bail!("there is no folder called {top}");
        }
        let path = dir.join(FACE_FILE);
        let old = std::fs::read_to_string(&path).unwrap_or_default();
        let mut lines: Vec<String> = old
            .lines()
            .filter(|l| !matches!(l.split_once(':').map(|(k, _)| k.trim()), Some("color" | "mark" | "copy")))
            .map(str::to_string)
            .collect();
        if lines.is_empty() {
            lines.push("# Petrel: how this collection looks in the library.".into());
        }
        if !color.is_empty() {
            lines.push(format!("color: {color}"));
        }
        if !mark.is_empty() {
            lines.push(format!("mark: {mark}"));
        }
        if !copy.is_empty() {
            lines.push(format!("copy: {copy}"));
        }
        write_atomic(&path, &(lines.join("\n") + "\n"))?;
        Ok(TopicFace { color, mark, copy })
    }

    /// What a new note in `folder`'s collection starts with: the `template:` line of its top folder's `.petrel`
    /// (newlines written as `\n`). Empty when it has none.
    pub fn collection_template(&self, folder: &str) -> Result<String> {
        let root = self.root()?;
        let top = clean_folder(folder);
        let top = top.split('/').next().unwrap_or("");
        if top.is_empty() {
            return Ok(String::new());
        }
        let text = std::fs::read_to_string(abs(&root, top).join(FACE_FILE)).unwrap_or_default();
        Ok(text
            .lines()
            .find_map(|l| l.strip_prefix("template:"))
            .map(|v| unescape_line(v.trim_start()))
            .unwrap_or_default())
    }

    /// Sets (or with empty text removes) a collection's template; the other lines of `.petrel` are kept.
    pub fn set_collection_template(&mut self, top: &str, text: &str) -> Result<()> {
        let root = self.root()?;
        let top = clean_folder(top);
        if top.is_empty() || top.contains('/') || top == INBOX_DIR {
            bail!("only a collection (a top folder) has a template");
        }
        let dir = abs(&root, &top);
        if !dir.is_dir() {
            bail!("there is no folder called {top}");
        }
        let path = dir.join(FACE_FILE);
        let old = std::fs::read_to_string(&path).unwrap_or_default();
        let mut lines: Vec<String> =
            old.lines().filter(|l| !l.starts_with("template:")).map(str::to_string).collect();
        if lines.is_empty() {
            lines.push("# Petrel: how this collection looks in the library.".into());
        }
        let text = text.trim_end();
        if !text.is_empty() {
            lines.push(format!("template: {}", escape_line(text)));
        }
        write_atomic(&path, &(lines.join("\n") + "\n"))
    }

    /// A note's saved versions, newest first (the history panel).
    pub fn note_versions(&self, id: i64) -> Result<Vec<NoteVersion>> {
        // Versions made on another computer arrive as files; read them in first.
        if let Err(e) = self.reconcile_history(id) {
            eprintln!("petrel: reading the history of note {id}: {e:#}");
        }
        let mut st = self.conn.prepare(
            "SELECT id, reason, created_at, length(content) FROM note_versions WHERE note_id = ?1 \
             ORDER BY created_at DESC, id DESC",
        )?;
        let rows = st.query_map(params![id], |r| {
            Ok(NoteVersion { id: r.get(0)?, reason: r.get(1)?, created_at: r.get(2)?, length: r.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// A version's body, without its front matter.
    pub fn note_version_text(&self, version_id: i64) -> Result<String> {
        let text: String = self
            .conn
            .query_row("SELECT content FROM note_versions WHERE id = ?1", params![version_id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| anyhow!("no version {version_id}"))?;
        Ok(split_front(&text).1.to_string())
    }

    /// Keeps the file as it is now as a version, whatever the interval: before an AI rewrite or a restore.
    pub fn snapshot_note(&mut self, id: i64, reason: &str) -> Result<()> {
        let root = self.root()?;
        let row = self.row(id)?;
        let path = abs(&root, &row.path);
        let disk = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        self.note_version(id, &disk, reason)
    }

    /// Puts a version's body back, keeping today's front matter. The current text is kept first.
    pub fn restore_note_version(&mut self, id: i64, version_id: i64) -> Result<Note> {
        let owner: Option<i64> = self
            .conn
            .query_row("SELECT note_id FROM note_versions WHERE id = ?1", params![version_id], |r| r.get(0))
            .optional()?;
        if owner != Some(id) {
            bail!("that version is not one of this note's");
        }
        let body = self.note_version_text(version_id)?;
        self.snapshot_note(id, "restore")?;
        let root = self.root()?;
        let row = self.row(id)?;
        let path = abs(&root, &row.path);
        let disk = std::fs::read_to_string(&path).unwrap_or_default();
        let front = split_front(&disk).0.to_string();
        write_atomic(&path, &format!("{front}{body}"))?;
        self.index_file(&root, &row.path)?;
        self.note(id)
    }

    /// Counts a copy, so a collection can list what is used most first. Kept by path in settings: the index
    /// is rebuildable and a count is not worth a migration. A copy from the quick picker also counts for the app
    /// that was in front (`copied_in.<app>|<path>`), so the picker can offer what is used there first. Local only.
    pub fn record_copy(&mut self, id: i64, app: Option<&str>) -> Result<i64> {
        let row = self.row(id)?;
        let key = format!("{COPY_PREFIX}{}", row.path);
        let n = self.setting(&key)?.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0) + 1;
        self.set_setting(&key, &n.to_string())?;
        if let Some(app) = app.map(str::trim).filter(|a| !a.is_empty() && !a.contains('|')) {
            let key = format!("{COPY_IN_PREFIX}{app}|{}", row.path);
            let m = self.setting(&key)?.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0) + 1;
            self.set_setting(&key, &m.to_string())?;
        }
        Ok(n)
    }

    /// How often each note was copied with `app` in front, by path.
    pub fn copy_counts_in(&self, app: &str) -> Result<std::collections::HashMap<String, i64>> {
        let prefix = format!("{COPY_IN_PREFIX}{app}|");
        Ok(self
            .settings_with_prefix(&prefix)?
            .into_iter()
            .filter_map(|(k, v)| Some((k.strip_prefix(&prefix)?.to_string(), v.parse().ok()?)))
            .collect())
    }

    /// How often each note was copied, by path.
    pub fn copy_counts(&self) -> Result<std::collections::HashMap<String, i64>> {
        Ok(self
            .settings_with_prefix(COPY_PREFIX)?
            .into_iter()
            .filter_map(|(k, v)| Some((k.strip_prefix(COPY_PREFIX)?.to_string(), v.parse().ok()?)))
            .collect())
    }

    /// Rewrites links found by searching for `words` in notes. `map` gives the new target for a link that should
    /// change.
    pub(super) fn relink(
        &mut self,
        words: &str,
        steps: &mut Vec<UndoStep>,
        map: impl Fn(&Target) -> Option<Target>,
    ) -> Result<usize> {
        let root = self.root()?;
        let mut changed = 0;
        for t in self.texts_with(words, REWRITE_MAX)? {
            let (_, n) =
                links::rewrite(&t.text, |l| map(&l.target).map(|target| Link { target, ..l.clone() }.raw()));
            if n == 0 {
                continue;
            }
            changed += 1;
            {
                let row = self.row(t.id)?;
                let path = abs(&root, &row.path);
                let before = std::fs::read_to_string(&path)?;
                let (front, body) = split_front(&before);
                let (body_new, _) =
                    links::rewrite(body, |l| map(&l.target).map(|target| Link { target, ..l.clone() }.raw()));
                let after = format!("{front}{body_new}");
                if after == before {
                    continue;
                }
                self.note_version(t.id, &before, "before_relink")?;
                write_atomic(&path, &after)?;
                self.index_file(&root, &row.path)?;
                steps.push(UndoStep::NoteText { path: row.path, before, after });
            }
        }
        Ok(changed)
    }

    /// Notes whose text holds the words of `words` (by full-text search), newest first.
    pub(super) fn texts_with(&self, words: &str, limit: usize) -> Result<Vec<Text>> {
        let mut out = Vec::new();
        let Some(q) = phrase(words) else { return Ok(out) };
        let mut notes = self.conn.prepare_cached(
            "SELECT n.id, n.title, n.content FROM notes_fts f JOIN notes n ON n.id = f.rowid \
             WHERE notes_fts MATCH ?1 ORDER BY n.modified_at DESC LIMIT ?2",
        )?;
        for r in notes.query_map(params![q, limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))? {
            let (id, title, content): (i64, String, String) = r?;
            out.push(Text { id, title, text: split_front(&content).1.to_string() });
        }
        Ok(out)
    }

    pub(super) fn note_titled(&self, title: &str) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id FROM notes WHERE title = ?1 COLLATE NOCASE ORDER BY accessed_at DESC LIMIT 1",
                params![title.trim()],
                |r| r.get(0),
            )
            .optional()?)
    }
}
