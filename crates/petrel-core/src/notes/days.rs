//! Day pages: `journal/YYYY-MM-DD.md`, made when a capture or an entry first goes there.

use super::*;

impl Store {
    // ---- days --------------------------------------------------------------------------------------------------

    /// The page for a day (`YYYY-MM-DD`), if it has one. A day without one has no file: the page is made when
    /// something is written on it.
    pub fn day_note(&self, date: &str) -> Result<Option<Note>> {
        let date = check_day(date)?;
        match self.id_of(&join_rel(JOURNAL_DIR, &date))? {
            Some(id) => Ok(Some(self.peek_note(id)?)),
            None => Ok(None),
        }
    }

    /// Adds a capture to the end of a day's page under the time (`21:14 text`), making the page if the day has
    /// none, and moves the capture to the trash. One undo takes back all of it.
    pub fn file_into_day(&mut self, from_id: i64, date: &str) -> Result<NoteChange> {
        let date = check_day(date)?;
        let mut steps = Vec::new();
        let into = match self.id_of(&join_rel(JOURNAL_DIR, &date))? {
            Some(id) => id,
            None => {
                let n = self.create_note(JOURNAL_DIR, &date, "", &[])?;
                steps.push(UndoStep::FileCreated { path: n.path.clone() });
                n.id
            }
        };
        let time = chrono::Local::now().format("%H:%M").to_string();
        self.merge_with(from_id, into, steps, |body| day_entry(&time, body))
    }

    /// The notes whose text has a `[[link]]` (`link`), a picture (`picture`) or an open task (`task`): `has:` in
    /// Ctrl K. Read from the index, so every note counts, not only recent ones. Newest first.
    pub fn notes_having(&self, what: &str) -> Result<Vec<i64>> {
        let cond = match what {
            "link" => "content LIKE '%[[%]]%'",
            "picture" => "content LIKE '%![%](%)%'",
            "task" => "(content LIKE '%- [ ] %' OR content LIKE '%* [ ] %' OR content LIKE '%+ [ ] %')",
            _ => bail!("{what} is not something a note can have (link, picture, task)"),
        };
        let ids = self
            .conn
            .prepare(&format!("SELECT id FROM notes WHERE {cond} ORDER BY modified_at DESC"))?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    }

    /// Notes changed between two moments (ms), newest first, with their text: what "the week" reads.
    pub fn notes_between(&self, from: i64, to: i64) -> Result<Vec<Note>> {
        let ids: Vec<i64> = self
            .conn
            .prepare_cached(
                "SELECT id FROM notes WHERE modified_at >= ?1 AND modified_at < ?2 \
                 ORDER BY modified_at DESC LIMIT ?3",
            )?
            .query_map(params![from, to, BETWEEN_MAX as i64], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(ids.into_iter().filter_map(|id| self.peek_note(id).ok()).collect())
    }
}
