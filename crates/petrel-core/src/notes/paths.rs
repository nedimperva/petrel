//! Rescanning only what the file watcher saw change (`src-tauri/src/watch.rs`). A full scan stats every file;
//! this reads the few that moved. Petrel's own writes come back here too, and are no change: the index already
//! has their size and time.

use std::path::Path;

use anyhow::Result;
use rusqlite::params;

use super::{abs, mtime_ms, ScanReport};
use crate::store::Store;

/// More paths than this at once (a folder moved, a sync catching up) is cheaper as a full scan.
const PATHS_MAX: usize = 200;

impl Store {
    /// Brings the index up to date for these files, given relative to the notes folder or absolute inside it.
    /// Anything that is not a note file (a folder, a picture) makes it a full scan, which is always right.
    pub fn scan_paths(&mut self, changed: &[std::path::PathBuf]) -> Result<ScanReport> {
        let root = self.root()?;
        let mut rels = Vec::new();
        for p in changed {
            let rel = match p.strip_prefix(&root) {
                Ok(r) => r.to_path_buf(),
                Err(_) if p.is_relative() => p.clone(),
                // Outside the folder: nothing of ours.
                Err(_) => continue,
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if rel.is_empty() || rel.split('/').any(|part| part.starts_with('.')) {
                continue;
            }
            if !rel.to_lowercase().ends_with(".md") || abs(&root, &rel).is_dir() {
                // Pictures and `.petrel` files do not change the index; a folder may hold many notes.
                if abs(&root, &rel).is_dir() {
                    return self.scan_notes();
                }
                continue;
            }
            if !rels.contains(&rel) {
                rels.push(rel);
            }
        }
        if rels.len() > PATHS_MAX {
            return self.scan_notes();
        }
        let mut report = ScanReport { root: root.display().to_string(), ..Default::default() };
        for rel in rels {
            self.scan_one(&root, &rel, &mut report)?;
        }
        Ok(report)
    }

    fn scan_one(&mut self, root: &Path, rel: &str, report: &mut ScanReport) -> Result<()> {
        let known: Option<(i64, i64)> = self
            .conn
            .query_row("SELECT size, mtime FROM notes WHERE path = ?1", params![rel], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .ok();
        match std::fs::metadata(abs(root, rel)) {
            Ok(meta) if meta.is_file() => {
                if known == Some((meta.len() as i64, mtime_ms(&meta))) {
                    return Ok(());
                }
                match self.index_file(root, rel) {
                    Ok(true) if known.is_some() => report.changed += 1,
                    Ok(true) => report.added += 1,
                    _ => {
                        report.skipped += 1;
                        return Ok(());
                    }
                }
                report.paths.push(rel.to_string());
            }
            _ => {
                if known.is_some() {
                    report.removed += self.conn.execute("DELETE FROM notes WHERE path = ?1", params![rel])?;
                    report.paths.push(rel.to_string());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests_support::{store_in, tmp};

    #[test]
    fn only_changed_files_count() {
        let dir = tmp();
        let mut s = store_in(&dir);
        let n = s.create_note("Travel", "Mostar", "bridge\n", &[]).unwrap();
        // Petrel's own write: nothing changed.
        let r = s.scan_paths(&[dir.join(&n.path)]).unwrap();
        assert_eq!((r.added, r.changed, r.removed), (0, 0, 0));
        // Drive brings a new version and a new note; a picture and the trash are not notes.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join(&n.path), "bridge and river\n").unwrap();
        std::fs::write(dir.join("Travel/Sarajevo.md"), "old town\n").unwrap();
        std::fs::create_dir_all(dir.join(".trash")).unwrap();
        let r = s
            .scan_paths(&[
                dir.join("Travel/Mostar.md"),
                dir.join("Travel/Sarajevo.md"),
                dir.join("Travel/attachments/x.png"),
                dir.join(".trash/y.md"),
            ])
            .unwrap();
        assert_eq!((r.added, r.changed, r.removed), (1, 1, 0));
        assert_eq!(r.paths, vec!["Travel/Mostar.md".to_string(), "Travel/Sarajevo.md".to_string()]);
        assert_eq!(s.peek_note(n.id).unwrap().body, "bridge and river\n");
        std::fs::remove_file(dir.join("Travel/Sarajevo.md")).unwrap();
        let r = s.scan_paths(&["Travel/Sarajevo.md".into()]).unwrap();
        assert_eq!((r.removed, r.paths.len()), (1, 1));
        std::fs::remove_dir_all(dir).ok();
    }
}
