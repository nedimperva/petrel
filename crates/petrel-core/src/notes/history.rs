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
        Ok(())
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
}
