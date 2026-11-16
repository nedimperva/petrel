//! A note's history in the folder, so it travels with the notes to every computer. Each version the index keeps
//! (`note_versions`) is also a file beside the note: `Travel/Rome.md` has its versions in
//! `Travel/.history/Rome/<ms>-<reason>.md`. The dot keeps them out of the notes; a collection renamed or trashed
//! takes its history along because the history is inside it.
//!
//! The index and the folder are made to agree when the history is opened (Ctrl H): versions found only as files
//! (written on another computer) are read in, versions found only in the index (made before this) are written
//! out. A version is the same one on both sides when its time and reason match.

use std::path::{Path, PathBuf};

use anyhow::Result;
use rusqlite::params;

use super::{abs, write_atomic, NOTE_VERSIONS_KEPT};
use crate::retention::{self, VersionAge};
use crate::store::Store;

pub const DIR: &str = ".history";

/// The folder that holds a note's versions.
pub fn dir_for(root: &Path, rel: &str) -> PathBuf {
    let (folder, file) = rel.rsplit_once('/').unwrap_or(("", rel));
    let stem = file.strip_suffix(".md").unwrap_or(file);
    let mut p = if folder.is_empty() { root.to_path_buf() } else { abs(root, folder) };
    p.push(DIR);
    p.push(stem);
    p
}

fn file_name(created_at: i64, reason: &str) -> String {
    let reason: String = reason.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    format!("{created_at}-{reason}.md")
}

/// `1731600000000-edit.md` → (1731600000000, "edit").
fn parse_name(name: &str) -> Option<(i64, String)> {
    let stem = name.strip_suffix(".md")?;
    let (ms, reason) = stem.split_once('-')?;
    Some((ms.parse().ok()?, reason.to_string()))
}

/// The version files in a note's history folder, oldest first.
fn files(dir: &Path) -> Vec<(i64, String, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<_> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let (ms, reason) = parse_name(&name)?;
            Some((ms, reason, e.path()))
        })
        .collect();
    out.sort_by_key(|(ms, _, _)| *ms);
    out
}

/// Keeps the newest `NOTE_VERSIONS_KEPT` files, as the index does.
fn prune(dir: &Path) {
    let all = files(dir);
    let extra = all.len().saturating_sub(NOTE_VERSIONS_KEPT as usize);
    for (_, _, path) in all.into_iter().take(extra) {
        let _ = std::fs::remove_file(path);
    }
}

/// Writes one version as a file, unless it is there already.
pub fn write(root: &Path, rel: &str, created_at: i64, reason: &str, text: &str) -> Result<()> {
    let dir = dir_for(root, rel);
    let path = dir.join(file_name(created_at, reason));
    if path.exists() {
        return Ok(());
    }
    write_atomic(&path, text)?;
    prune(&dir);
    Ok(())
}

/// Moves a note's history along when the note is renamed or moved. Nothing to do when it has none; an existing
/// history at the new name (an older note of that name) is left alone.
pub fn carry(root: &Path, from: &str, to: &str) {
    let (a, b) = (dir_for(root, from), dir_for(root, to));
    if !a.is_dir() || b.exists() {
        return;
    }
    if let Some(parent) = b.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // A history left behind is still in the index on this computer; nothing is lost.
    let _ = std::fs::rename(&a, &b);
}

impl Store {
    /// Makes the index and the note's history folder agree (see the module notes).
    pub(super) fn reconcile_history(&self, id: i64) -> Result<()> {
        let root = self.root()?;
        let row = self.row(id)?;
        let dir = dir_for(&root, &row.path);
        let on_disk = files(&dir);
        let in_index: Vec<(i64, String, String)> = {
            let mut st = self.conn.prepare(
                "SELECT created_at, reason, content FROM note_versions WHERE note_id = ?1 ORDER BY created_at",
            )?;
            let rows = st.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let same = |a: &str, b: &str| file_name(0, a) == file_name(0, b);
        for (ms, reason, path) in &on_disk {
            if in_index.iter().any(|(t, r, _)| t == ms && same(r, reason)) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(path) else { continue };
            self.conn.execute(
                "INSERT INTO note_versions (note_id, content, reason, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, text, reason, ms],
            )?;
        }
        for (ms, reason, text) in &in_index {
            if !on_disk.iter().any(|(t, r, _)| t == ms && same(reason, r)) {
                write(&root, &row.path, *ms, reason, text)?;
            }
        }
        self.conn.execute(
            "DELETE FROM note_versions WHERE note_id = ?1 AND id NOT IN \
             (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2)",
            params![id, NOTE_VERSIONS_KEPT],
        )?;
        self.thin_history(id)?;
        Ok(())
    }

    /// Thins one note's versions by age tier (`retention`), in the index and in its history folder alike.
    /// Buckets depend only on a version's time, so two computers thinning the same history keep the same
    /// versions, and a reconcile never brings a thinned one back from the other side.
    pub(super) fn thin_history(&self, id: i64) -> Result<usize> {
        let now = self.now();
        let r = self.retention()?;
        let rows: Vec<(i64, String, i64)> = {
            let mut st = self.conn.prepare(
                "SELECT id, reason, created_at FROM note_versions WHERE note_id = ?1 \
                 ORDER BY created_at DESC, id DESC",
            )?;
            let rows = st.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let ages: Vec<VersionAge> = rows
            .iter()
            .map(|(vid, reason, created_at)| VersionAge {
                id: *vid,
                draft_id: id,
                reason,
                created_at: *created_at,
            })
            .collect();
        let doomed = retention::versions_to_thin(&ages, now, &r);
        if doomed.is_empty() {
            return Ok(0);
        }
        let dir = self.root().ok().zip(self.row(id).ok()).map(|(root, row)| dir_for(&root, &row.path));
        for (vid, reason, created_at) in rows.iter().filter(|(vid, _, _)| doomed.contains(vid)) {
            self.conn.execute("DELETE FROM note_versions WHERE id = ?1", params![vid])?;
            if let Some(dir) = &dir {
                let _ = std::fs::remove_file(dir.join(file_name(*created_at, reason)));
            }
        }
        Ok(doomed.len())
    }

    /// Thins every note's history; part of the daily sweep.
    pub fn thin_note_histories(&self) -> Result<usize> {
        let ids: Vec<i64> = {
            let mut st = self.conn.prepare("SELECT DISTINCT note_id FROM note_versions")?;
            let rows = st.query_map([], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let mut n = 0;
        for id in ids {
            n += self.thin_history(id).unwrap_or(0);
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_folders() {
        let root = Path::new("/n");
        assert_eq!(dir_for(root, "Travel/Rome.md"), Path::new("/n/Travel/.history/Rome"));
        assert_eq!(dir_for(root, "Plan.md"), Path::new("/n/.history/Plan"));
        assert_eq!(parse_name("1731600000000-edit.md"), Some((1731600000000, "edit".into())));
        assert_eq!(parse_name("notes.md"), None);
        assert_eq!(file_name(5, "a i!"), "5-ai.md");
    }

    #[test]
    fn old_versions_thin_in_the_index_and_the_folder() {
        use std::sync::atomic::{AtomicI64, Ordering};
        use std::sync::Arc;
        let dir = crate::notes::tests_support::tmp();
        let mut s = crate::notes::tests_support::store_in(&dir);
        let clock = Arc::new(AtomicI64::new(1_700_000_000_000));
        let c = clock.clone();
        s.set_clock(move || c.load(Ordering::Relaxed));
        let n = s.create_note("", "Plan", "v0\n", &[]).unwrap();
        // A version every ten minutes for two days: all kept at first.
        for i in 0..288 {
            clock.fetch_add(10 * 60 * 1000, Ordering::Relaxed);
            s.note_version(n.id, &format!("v{i}\n"), "edit").unwrap();
        }
        let count = |s: &Store| -> i64 {
            s.conn
                .query_row("SELECT COUNT(*) FROM note_versions WHERE note_id = ?1", [n.id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(count(&s), NOTE_VERSIONS_KEPT);
        let thinned = s.thin_note_histories().unwrap();
        assert!(thinned > 100, "{thinned}");
        let left = count(&s);
        // The last hour whole (6), then one an hour for the day before.
        assert!((20..=40).contains(&left), "{left}");
        assert_eq!(files(&dir_for(&dir, "Plan.md")).len() as i64, left);
        // Thinning again at the same time changes nothing, and a reconcile brings nothing back.
        assert_eq!(s.thin_note_histories().unwrap(), 0);
        s.reconcile_history(n.id).unwrap();
        assert_eq!(count(&s), left);
    }
}
