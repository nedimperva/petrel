//! Undo for notes: each change is a list of steps, put back last step first.

use super::*;

impl Store {
    // ---- undo --------------------------------------------------------------------------------------------------

    pub(super) fn remember_notes(&mut self, steps: Vec<UndoStep>) -> UndoToken {
        let count = steps.len();
        let token = format!("{TOKEN_PREFIX}{}", uuid::Uuid::new_v4());
        self.notes_undo.push_back(NotesUndo { token: token.clone(), steps });
        while self.notes_undo.len() > 50 {
            self.notes_undo.pop_front();
        }
        UndoToken { token, count }
    }

    /// Puts a notes change back, last step first. A step whose file or text changed since is skipped, never
    /// forced: what was typed after the change stays.
    pub(crate) fn undo_notes(&mut self, token: &str) -> Result<usize> {
        let Some(pos) = self.notes_undo.iter().position(|u| u.token == token) else {
            bail!("nothing to undo: that change is too old or was already undone");
        };
        let batch = self.notes_undo.remove(pos).expect("in range");
        let root = self.root()?;
        let mut n = 0;
        for step in batch.steps.into_iter().rev() {
            match step {
                UndoStep::FileCreated { path } => {
                    if abs(&root, &path).exists() {
                        self.move_to_trash(&root, &path)?;
                        n += 1;
                    }
                }
                UndoStep::FileRenamed { from, to } => {
                    let (f, t) = (abs(&root, &from), abs(&root, &to));
                    let case_only = from.to_lowercase() == to.to_lowercase();
                    if t.exists() && (case_only || !f.exists()) {
                        rename_with_retry(&t, &f)?;
                        let (folder, file) = from.rsplit_once('/').unwrap_or(("", &from));
                        let title = file.strip_suffix(".md").unwrap_or(file);
                        self.conn.execute(
                            "UPDATE notes SET path = ?2, folder = ?3, title = ?4 WHERE path = ?1",
                            params![to, from, folder, title],
                        )?;
                        self.index_file(&root, &from)?;
                        n += 1;
                    }
                }
                UndoStep::FileTrashed { path, trashed } => {
                    let back = abs(&root, &path);
                    if trashed.exists() && !back.exists() {
                        if let Some(dir) = back.parent() {
                            std::fs::create_dir_all(dir)?;
                        }
                        rename_with_retry(&trashed, &back)?;
                        self.index_file(&root, &path)?;
                        n += 1;
                    }
                }
                UndoStep::FileMoved { from, to } => {
                    let (f, t) = (abs(&root, &from), abs(&root, &to));
                    if t.exists() && !f.exists() {
                        rename_with_retry(&t, &f)?;
                        n += 1;
                    }
                }
                UndoStep::NoteText { path, before, after } => {
                    let p = abs(&root, &path);
                    if std::fs::read_to_string(&p).ok().as_deref() == Some(after.as_str()) {
                        write_atomic(&p, &before)?;
                        self.index_file(&root, &path)?;
                        n += 1;
                    }
                }
            }
        }
        Ok(n)
    }
}
