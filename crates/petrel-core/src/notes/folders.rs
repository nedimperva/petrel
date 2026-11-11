//! Collections are folders, and the sidebar makes, renames and trashes them. A rename moves the folder and keeps
//! every note's id, history and copy count: the index rows are rewritten in place, never dropped and re-read. A
//! trashed collection goes whole to `.trash/`, so nothing is lost.

use anyhow::{bail, Context, Result};
use rusqlite::params;

use super::{
    abs, clean_folder, rename_with_retry, COPY_IN_PREFIX, COPY_PREFIX, INBOX_DIR, JOURNAL_DIR, TRASH_DIR,
};
use crate::store::Store;

/// A folder Petrel keeps for itself, which the sidebar does not rename or trash.
fn kept(folder: &str) -> bool {
    folder.is_empty() || folder == INBOX_DIR || folder == JOURNAL_DIR || folder.starts_with('.')
}

impl Store {
    /// Makes a collection (`Recipes`, or `Travel/Mostar` inside one). Fine if it is already there.
    pub fn create_folder(&mut self, folder: &str) -> Result<String> {
        let root = self.root()?;
        let folder = clean_folder(folder);
        if kept(&folder) {
            bail!("pick another name: {folder} is Petrel's own");
        }
        std::fs::create_dir_all(abs(&root, &folder)).with_context(|| format!("making {folder}"))?;
        Ok(folder)
    }

    /// Gives a collection a new name in the same place (`Travel` → `Trips`, `Travel/Mostar` → `Travel/Herzegovina`).
    /// Returns the new path.
    pub fn rename_folder(&mut self, folder: &str, name: &str) -> Result<String> {
        let root = self.root()?;
        let from = clean_folder(folder);
        let name = clean_folder(name);
        if kept(&from) {
            bail!("{from} is Petrel's own and keeps its name");
        }
        if name.is_empty() || name.contains('/') {
            bail!("a name, without / in it");
        }
        let to = match from.rsplit_once('/') {
            Some((parent, _)) => format!("{parent}/{name}"),
            None => name.clone(),
        };
        if to == from {
            return Ok(to);
        }
        if kept(&to) {
            bail!("pick another name: {to} is Petrel's own");
        }
        let (a, b) = (abs(&root, &from), abs(&root, &to));
        if !a.is_dir() {
            bail!("there is no folder called {from}");
        }
        // A rename that only changes case is fine on Windows, where the old and new name are the same folder.
        if b.exists() && from.to_lowercase() != to.to_lowercase() {
            bail!("there is already a {to}");
        }
        rename_with_retry(&a, &b)?;
        let tx = self.conn.unchecked_transaction()?;
        let n = from.len() as i64;
        tx.execute(
            "UPDATE notes SET path = ?2 || substr(path, ?3 + 1), \
               folder = CASE WHEN folder = ?1 THEN ?2 ELSE ?2 || substr(folder, ?3 + 1) END \
             WHERE folder = ?1 OR folder LIKE ?4 ESCAPE '\\'",
            params![from, to, n, format!("{}/%", like_escape(&from))],
        )?;
        // Copy counts are kept by path.
        for prefix in [COPY_PREFIX, COPY_IN_PREFIX] {
            let keys: Vec<(String, String)> = tx
                .prepare("SELECT key, value FROM settings WHERE key LIKE ?1 ESCAPE '\\'")?
                .query_map(params![format!("{}%", like_escape(prefix))], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (k, v) in keys {
                let rest = &k[prefix.len()..];
                // `copied.<path>` or `copied_in.<app>|<path>`.
                let (head, path) = rest.rsplit_once('|').map_or(("", rest), |(a, p)| (a, p));
                if let Some(tail) = path.strip_prefix(&format!("{from}/")) {
                    let sep = if head.is_empty() { "" } else { "|" };
                    let nk = format!("{prefix}{head}{sep}{to}/{tail}");
                    tx.execute("DELETE FROM settings WHERE key = ?1", params![k])?;
                    tx.execute(
                        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                        params![nk, v],
                    )?;
                }
            }
        }
        tx.commit()?;
        Ok(to)
    }

    /// Moves a collection, with every note in it, to `.trash/`. Returns how many notes went.
    pub fn trash_folder(&mut self, folder: &str) -> Result<usize> {
        let root = self.root()?;
        let folder = clean_folder(folder);
        if kept(&folder) {
            bail!("{folder} is Petrel's own and stays");
        }
        let dir = abs(&root, &folder);
        if !dir.is_dir() {
            bail!("there is no folder called {folder}");
        }
        let trash = root.join(TRASH_DIR);
        std::fs::create_dir_all(&trash)?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let name = folder.replace('/', " ");
        let mut target = trash.join(format!("{stamp} {name}"));
        let mut k = 2;
        while target.exists() {
            target = trash.join(format!("{stamp} {k} {name}"));
            k += 1;
        }
        rename_with_retry(&dir, &target)?;
        let gone = self.conn.execute(
            "DELETE FROM notes WHERE folder = ?1 OR folder LIKE ?2 ESCAPE '\\'",
            params![folder, format!("{}/%", like_escape(&folder))],
        )?;
        Ok(gone)
    }
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::super::tests_support::{store_in, tmp};

    #[test]
    fn make_rename_and_trash() {
        let dir = tmp();
        let mut s = store_in(&dir);
        assert_eq!(s.create_folder("Travel").unwrap(), "Travel");
        assert!(s.create_folder("inbox").is_err());
        let n = s.create_note("Travel/Mostar", "Bridge", "old\n", &[]).unwrap();
        let top = s.create_note("Travel", "Plan", "x\n", &[]).unwrap();
        s.record_copy(n.id, Some("Code")).unwrap();

        assert_eq!(s.rename_folder("Travel", "Trips").unwrap(), "Trips");
        assert!(dir.join("Trips/Mostar/Bridge.md").exists() && !dir.join("Travel").exists());
        let moved = s.peek_note(n.id).unwrap();
        assert_eq!((moved.path.as_str(), moved.folder.as_str()), ("Trips/Mostar/Bridge.md", "Trips/Mostar"));
        assert_eq!(s.peek_note(top.id).unwrap().folder, "Trips");
        assert_eq!(s.copy_counts().unwrap().get("Trips/Mostar/Bridge.md"), Some(&1));
        assert_eq!(s.copy_counts_in("Code").unwrap().get("Trips/Mostar/Bridge.md"), Some(&1));
        assert_eq!(s.rename_folder("Trips/Mostar", "Herzegovina").unwrap(), "Trips/Herzegovina");
        assert!(s.rename_folder("journal", "x").is_err());
        s.create_folder("Ideas").unwrap();
        assert!(s.rename_folder("Ideas", "Trips").is_err());

        assert_eq!(s.trash_folder("Trips").unwrap(), 2);
        assert!(!dir.join("Trips").exists());
        assert!(s.peek_note(n.id).is_err());
        assert_eq!(s.scan_notes().unwrap().added, 0);
        std::fs::remove_dir_all(dir).ok();
    }
}
