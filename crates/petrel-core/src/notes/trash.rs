//! The trash, opened: what is in `.trash/`, a look at each, Put back, and emptying what is older than a month.
//! Each thing trashed is named `<stamp> <name>`; where it came from is a line in `.trash/.places` (`name`, a tab,
//! the path it had), written when it went. Things trashed before that file existed go back to the top of the
//! folder. Emptying is the only place Petrel deletes a note's file, and only when asked.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{bail, Context, Result};
use chrono::TimeZone;
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{abs, rename_with_retry, TRASH_DIR};
use crate::store::Store;

const PLACES: &str = ".places";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    /// The name in `.trash/`: what Put back and the preview take.
    pub name: String,
    pub title: String,
    /// The path it had, relative to the notes folder (a folder's for a collection).
    pub from: String,
    /// When it went to the trash (ms).
    pub at: i64,
    /// A whole collection, not one note.
    pub folder: bool,
}

/// Writes down where a trashed thing came from, so Put back knows. A failure only costs that.
pub(crate) fn note_place(root: &Path, name: &str, rel: &str) {
    use std::io::Write;
    let path = root.join(TRASH_DIR).join(PLACES);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{name}\t{rel}");
    }
}

fn places(root: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(root.join(TRASH_DIR).join(PLACES))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}

fn forget_places(root: &Path, gone: &[String]) -> Result<()> {
    let path = root.join(TRASH_DIR).join(PLACES);
    let Ok(text) = std::fs::read_to_string(&path) else { return Ok(()) };
    let kept: String = text
        .lines()
        .filter(|l| l.split_once('\t').is_none_or(|(a, _)| !gone.iter().any(|g| g == a)))
        .map(|l| format!("{l}\n"))
        .collect();
    std::fs::write(&path, kept)?;
    Ok(())
}

/// `20261116-101500 Bread.md` → (its time in ms, `Bread.md`). A counter after the stamp (`… 2 Bread.md`) is
/// part of the name here; the places file has the true one.
fn split_stamp(name: &str) -> Option<(i64, &str)> {
    let (stamp, rest) = name.split_once(' ')?;
    let t = chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%d-%H%M%S").ok()?;
    let at = chrono::Local.from_local_datetime(&t).earliest()?.timestamp_millis();
    Some((at, rest))
}

impl Store {
    /// What is in the trash, newest first.
    pub fn trash_items(&self) -> Result<Vec<TrashItem>> {
        let root = self.root()?;
        let dir = root.join(TRASH_DIR);
        let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
        let places = places(&root);
        let mut out = Vec::new();
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let folder = e.path().is_dir();
            let modified = || {
                e.metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            };
            let (at, rest) = match split_stamp(&name) {
                Some((at, rest)) => (at, rest.to_string()),
                None => (modified().map_or(0, |d| d.as_millis() as i64), name.clone()),
            };
            let from = places.get(&name).cloned().unwrap_or_else(|| rest.clone());
            let last = from.rsplit('/').next().unwrap_or(&from);
            let title =
                if folder { last.to_string() } else { last.strip_suffix(".md").unwrap_or(last).to_string() };
            out.push(TrashItem { name, title, from, at, folder });
        }
        out.sort_by(|a, b| b.at.cmp(&a.at).then(a.name.cmp(&b.name)));
        Ok(out)
    }

    /// The start of a trashed note, or the notes in a trashed collection, for the preview.
    pub fn trash_peek(&self, name: &str) -> Result<String> {
        let path = self.trash_path(name)?;
        if path.is_dir() {
            let mut names: Vec<String> = walkdir(&path)
                .into_iter()
                .filter(|p| p.extension().is_some_and(|x| x == "md"))
                .filter_map(|p| p.strip_prefix(&path).ok().map(|r| r.to_string_lossy().replace('\\', "/")))
                .map(|r| r.strip_suffix(".md").unwrap_or(&r).to_string())
                .collect();
            names.sort();
            let n = names.len();
            names.truncate(40);
            let more = if n > 40 { format!("\n… and {} more", n - 40) } else { String::new() };
            return Ok(format!("{n} notes:\n{}{more}", names.join("\n")));
        }
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        Ok(text.chars().take(4_000).collect())
    }

    /// Puts a trashed thing back where it was (beside it, as "… (put back)", if that name is taken now) and
    /// indexes it. Returns the note's id for a note, none for a collection.
    pub fn trash_restore(&mut self, name: &str) -> Result<Option<i64>> {
        let root = self.root()?;
        let from = self.trash_path(name)?;
        let folder = from.is_dir();
        let places = places(&root);
        let rel = places
            .get(name)
            .cloned()
            .unwrap_or_else(|| split_stamp(name).map_or(name, |(_, r)| r).to_string());
        let mut target = rel.clone();
        let mut k = 1;
        while abs(&root, &target).exists() {
            let (stem, ext) =
                if folder { (rel.as_str(), "") } else { (rel.strip_suffix(".md").unwrap_or(&rel), ".md") };
            target = if k == 1 {
                format!("{stem} (put back){ext}")
            } else {
                format!("{stem} (put back {k}){ext}")
            };
            k += 1;
        }
        let to = abs(&root, &target);
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir)?;
        }
        rename_with_retry(&from, &to).with_context(|| format!("putting back {name}"))?;
        forget_places(&root, &[name.to_string()])?;
        if folder {
            self.scan_notes()?;
            return Ok(None);
        }
        self.index_file(&root, &target)?;
        let id =
            self.conn.query_row("SELECT id FROM notes WHERE path = ?1", params![target], |r| r.get(0)).ok();
        Ok(id)
    }

    /// Deletes what went to the trash more than `days` days ago, for good. Returns how many things went.
    pub fn trash_empty(&mut self, days: i64) -> Result<usize> {
        let root = self.root()?;
        let before = self.now() - days * 24 * 60 * 60 * 1000;
        let mut gone = Vec::new();
        for item in self.trash_items()? {
            if item.at >= before {
                continue;
            }
            let path = root.join(TRASH_DIR).join(&item.name);
            if item.folder {
                std::fs::remove_dir_all(&path)?;
            } else {
                std::fs::remove_file(&path)?;
            }
            gone.push(item.name);
        }
        forget_places(&root, &gone)?;
        Ok(gone.len())
    }

    fn trash_path(&self, name: &str) -> Result<std::path::PathBuf> {
        if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
            bail!("{name} is not in the trash");
        }
        let path = self.root()?.join(TRASH_DIR).join(name);
        if !path.exists() {
            bail!("{name} is no longer in the trash");
        }
        Ok(path)
    }
}

fn walkdir(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::tests_support::{store_in, tmp};

    #[test]
    fn trash_lists_peeks_puts_back_and_empties() {
        let dir = tmp();
        let mut s = store_in(&dir);
        let n = s.create_note("Travel", "Packing", "passport\n", &[]).unwrap();
        s.trash_note(n.id).unwrap();
        let items = s.trash_items().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Packing");
        assert_eq!(items[0].from, "Travel/Packing.md");
        assert!(s.trash_peek(&items[0].name).unwrap().contains("passport"));
        // The name is taken again by then: it comes back beside it.
        s.create_note("Travel", "Packing", "new list\n", &[]).unwrap();
        let id = s.trash_restore(&items[0].name).unwrap().unwrap();
        assert_eq!(s.peek_note(id).unwrap().path, "Travel/Packing (put back).md");
        assert!(s.trash_items().unwrap().is_empty());
        assert!(s.trash_peek("../x").is_err());

        let m = s.create_note("", "Old", "x\n", &[]).unwrap();
        s.trash_note(m.id).unwrap();
        assert_eq!(s.trash_empty(30).unwrap(), 0, "a fresh thing stays");
        assert_eq!(s.trash_empty(-1).unwrap(), 1);
        assert!(s.trash_items().unwrap().is_empty());
    }

    #[test]
    fn a_collection_comes_back_whole() {
        let dir = tmp();
        let mut s = store_in(&dir);
        s.create_note("Songs", "One", "la\n", &[]).unwrap();
        s.create_note("Songs", "Two", "la la\n", &[]).unwrap();
        s.trash_folder("Songs").unwrap();
        let items = s.trash_items().unwrap();
        assert!(items[0].folder);
        assert!(s.trash_peek(&items[0].name).unwrap().starts_with("2 notes"));
        assert_eq!(s.trash_restore(&items[0].name).unwrap(), None);
        assert_eq!(s.count_notes_in("Songs").unwrap(), 2);
    }
}
