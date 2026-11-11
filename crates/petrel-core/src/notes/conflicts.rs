//! Conflict copies, settled: when a note changed on disk while Petrel had it open, the other text was kept next
//! to it as `Title (conflict 2026-11-11 2114).md` (`conflict_copy`). The library shows a card for each such pair;
//! keeping one side sends the other to `.trash/`, keeping both gives the copy a name of its own. One undo each.

use anyhow::{bail, Result};
use serde::Serialize;

use super::{abs, join_rel, split_front, write_atomic, UndoStep};
use crate::store::{Store, UndoToken};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    /// The note as Petrel last wrote it.
    pub original: i64,
    /// The other text.
    pub copy: i64,
    pub title: String,
    pub folder: String,
    pub copied_at: i64,
}

/// `Title (conflict 2026-11-11 2114)` or `… 2114 2)`: the title it is a copy of.
pub(crate) fn copy_of(title: &str) -> Option<&str> {
    let inner = title.strip_suffix(')')?;
    let at = inner.rfind(" (conflict ")?;
    let stamp = &inner[at + " (conflict ".len()..];
    let b = stamp.as_bytes();
    let ok = b.len() >= 15
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b' '
        && b[11..15].iter().all(u8::is_ascii_digit)
        && (b.len() == 15 || (b[15] == b' ' && b[16..].iter().all(u8::is_ascii_digit) && b.len() > 16));
    (ok && at > 0).then(|| &title[..at])
}

impl Store {
    /// Notes that have a conflict copy beside them, the newest copy first.
    pub fn conflicts(&self) -> Result<Vec<Conflict>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, folder, title, modified_at FROM notes WHERE title LIKE '% (conflict %)' ORDER BY modified_at DESC")?;
        let copies: Vec<(i64, String, String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::new();
        for (copy, folder, title, copied_at) in copies {
            let Some(base) = copy_of(&title) else { continue };
            if let Some(original) = self.id_of(&join_rel(&folder, base))? {
                out.push(Conflict { original, copy, title: base.to_string(), folder, copied_at });
            }
        }
        Ok(out)
    }

    /// `keep` is `left` (the note as it is, the copy to the trash), `right` (the copy's text in the note, a
    /// version of the old text first, the copy to the trash) or `both` (the copy renamed `Title (other)`).
    pub fn settle_conflict(&mut self, original: i64, copy: i64, keep: &str) -> Result<UndoToken> {
        let root = self.root()?;
        let o = self.row(original)?;
        let c = self.row(copy)?;
        if copy_of(&c.title) != Some(o.title.as_str()) || c.folder != o.folder {
            bail!("{} is not a conflict copy of {}", c.title, o.title);
        }
        match keep {
            "left" => {
                let trashed = self.move_to_trash(&root, &c.path)?;
                Ok(self.remember_notes(vec![UndoStep::FileTrashed { path: c.path, trashed }]))
            }
            "right" => {
                let path = abs(&root, &o.path);
                let before = std::fs::read_to_string(&path)?;
                let theirs = std::fs::read_to_string(abs(&root, &c.path))?;
                let after = format!("{}{}", split_front(&before).0, split_front(&theirs).1);
                self.note_version(original, &before, "conflict")?;
                write_atomic(&path, &after)?;
                self.index_file(&root, &o.path)?;
                let trashed = self.move_to_trash(&root, &c.path)?;
                Ok(self.remember_notes(vec![
                    UndoStep::NoteText { path: o.path, before, after },
                    UndoStep::FileTrashed { path: c.path, trashed },
                ]))
            }
            "both" => {
                let mut name = format!("{} (other)", o.title);
                let mut n = 2;
                while abs(&root, &join_rel(&o.folder, &name)).exists() {
                    name = format!("{} (other {n})", o.title);
                    n += 1;
                }
                Ok(self.rename_note(copy, &name)?.token)
            }
            _ => bail!("keep left, right or both, not {keep}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests_support::{store_in, tmp};
    use super::*;

    #[test]
    fn copy_names() {
        assert_eq!(copy_of("Plan (conflict 2026-11-11 2114)"), Some("Plan"));
        assert_eq!(copy_of("Plan (conflict 2026-11-11 2114 3)"), Some("Plan"));
        assert_eq!(copy_of("Plan (conflict of ideas)"), None);
        assert_eq!(copy_of("Plan"), None);
    }

    #[test]
    fn settle_each_way() {
        let dir = tmp();
        let mut s = store_in(&dir);
        let n = s.create_note("work", "Plan", "mine\n", &[]).unwrap();
        // Drive changed it while Petrel had it open: the save keeps the other text as a copy.
        std::fs::write(dir.join("work/Plan.md"), "theirs\n").unwrap();
        let saved = s.save_note(n.id, "mine, edited\n", &n.hash).unwrap();
        assert!(saved.conflict.is_some());
        let c = s.conflicts().unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].original, c[0].title.as_str()), (n.id, "Plan"));

        let t = s.settle_conflict(n.id, c[0].copy, "right").unwrap();
        assert_eq!(s.peek_note(n.id).unwrap().body, "theirs\n");
        assert!(s.conflicts().unwrap().is_empty());
        s.undo_notes(&t.token).unwrap();
        s.scan_notes().unwrap();
        assert_eq!(s.peek_note(n.id).unwrap().body, "mine, edited\n");
        let c = s.conflicts().unwrap();
        assert_eq!(c.len(), 1);

        s.settle_conflict(n.id, c[0].copy, "both").unwrap();
        assert!(dir.join("work/Plan (other).md").exists());
        assert!(s.conflicts().unwrap().is_empty());
        assert!(s.settle_conflict(n.id, n.id, "left").is_err());
        std::fs::remove_dir_all(dir).ok();
    }
}
