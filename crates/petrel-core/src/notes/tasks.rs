//! Open tasks across the notes: every `- [ ]` that is not in code or front matter, for the Ctrl K tasks page, and
//! ticking one there, which writes the file like typing `x` would (a version first if one is due, one undo).

use anyhow::{bail, Context, Result};
use rusqlite::params;
use serde::Serialize;

use super::{abs, split_front, write_atomic, UndoStep};
use crate::store::{Store, UndoToken};

/// Tasks listed at most; past that the page says to narrow it.
const TASKS_MAX: usize = 1_000;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenTask {
    pub note_id: i64,
    pub title: String,
    pub folder: String,
    pub modified_at: i64,
    /// The line in the file, from 0, front matter included: what `tick_task` checks.
    pub line: usize,
    /// The task's words, without `- [ ] `.
    pub text: String,
}

/// `- [ ] words` (or `*`, `+`, `1.`), indented or not: the words.
fn open_task(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let rest = t
        .strip_prefix("- ")
        .or_else(|| t.strip_prefix("* "))
        .or_else(|| t.strip_prefix("+ "))
        .or_else(|| {
            let digits = t.find(|c: char| !c.is_ascii_digit())?;
            (digits > 0).then(|| t[digits..].strip_prefix(". ").or_else(|| t[digits..].strip_prefix(") ")))?
        })?;
    let words = rest.strip_prefix("[ ] ")?.trim();
    (!words.is_empty()).then_some(words)
}

/// The open tasks in a file's text: (line, words).
pub(crate) fn tasks_in(content: &str) -> Vec<(usize, String)> {
    let (front, _) = split_front(content);
    let skip = front.lines().count();
    let mut fence = false;
    let mut out = Vec::new();
    for (i, line) in content.lines().enumerate().skip(skip) {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        if let Some(w) = open_task(line) {
            out.push((i, w.to_string()));
        }
    }
    out
}

impl Store {
    /// Every unticked task in every note, the most recently changed notes first.
    pub fn open_tasks(&self) -> Result<Vec<OpenTask>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, folder, modified_at, content FROM notes \
             WHERE content LIKE '%[ ] %' ORDER BY modified_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (note_id, title, folder, modified_at, content) = row?;
            for (line, text) in tasks_in(&content) {
                out.push(OpenTask {
                    note_id,
                    title: title.clone(),
                    folder: folder.clone(),
                    modified_at,
                    line,
                    text,
                });
                if out.len() >= TASKS_MAX {
                    return Ok(out);
                }
            }
        }
        Ok(out)
    }

    /// Ticks the task on `line` of the note's file, if that line is still the task `text`. Undo puts it back.
    pub fn tick_task(&mut self, id: i64, line: usize, text: &str) -> Result<UndoToken> {
        let root = self.root()?;
        let row = self.row(id)?;
        let path = abs(&root, &row.path);
        let before = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        let mut lines: Vec<&str> = before.split('\n').collect();
        let Some(&old) = lines.get(line) else { bail!("that task is no longer in {}", row.title) };
        if open_task(old.trim_end_matches('\r')) != Some(text.trim()) {
            bail!("that task changed in {}; open the note to tick it", row.title);
        }
        let at = old.find("[ ]").context("no box on that line")?;
        let ticked = format!("{}[x]{}", &old[..at], &old[at + 3..]);
        lines[line] = &ticked;
        let after = lines.join("\n");
        self.note_version_if_due(id, &before)?;
        write_atomic(&path, &after)?;
        self.index_file(&root, &row.path)?;
        Ok(self.remember_notes(vec![UndoStep::NoteText { path: row.path.clone(), before, after }]))
    }

    /// How many tasks a note still has open (for the page's count after a tick).
    pub fn open_task_count(&self, id: i64) -> Result<usize> {
        let content: String =
            self.conn.query_row("SELECT content FROM notes WHERE id = ?1", params![id], |r| r.get(0))?;
        Ok(tasks_in(&content).len())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests_support::{store_in, tmp};
    use super::*;

    #[test]
    fn tasks_outside_code_and_front() {
        let text = "---\ntags: [x]\n---\n- [ ] milk\n  * [ ] nested\n- [x] done\n```\n- [ ] code\n```\n1. [ ] first\n- [ ]\n";
        let got: Vec<_> = tasks_in(text).into_iter().map(|(l, w)| format!("{l}:{w}")).collect();
        assert_eq!(got, vec!["3:milk", "4:nested", "9:first"]);
    }

    #[test]
    fn tick_writes_the_file_and_undoes() {
        let dir = tmp();
        let mut s = store_in(&dir);
        let n = s.create_note("", "Week", "## Monday\n\n- [ ] Dentist\n- [ ] Call Amra\n", &[]).unwrap();
        let older = s.create_note("", "Garden", "- [ ] garlic\n", &[]).unwrap();
        let tasks = s.open_tasks().unwrap();
        assert_eq!(tasks.len(), 3);
        let t = tasks.iter().find(|t| t.text == "Call Amra").unwrap();
        assert!(s.tick_task(n.id, t.line, "Something else").is_err());
        let token = s.tick_task(n.id, t.line, "Call Amra").unwrap();
        assert!(std::fs::read_to_string(dir.join("Week.md")).unwrap().contains("- [x] Call Amra"));
        assert_eq!(s.open_task_count(n.id).unwrap(), 1);
        assert_eq!(s.open_task_count(older.id).unwrap(), 1);
        s.undo_notes(&token.token).unwrap();
        assert!(std::fs::read_to_string(dir.join("Week.md")).unwrap().contains("- [ ] Call Amra"));
        std::fs::remove_dir_all(dir).ok();
    }
}
