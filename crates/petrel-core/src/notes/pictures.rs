//! Pictures pasted into a note: saved in `<folder>/attachments/` and read back for the page.

use super::*;

impl Store {
    // ---- pictures ----------------------------------------------------------------------------------------------

    /// Writes a pasted picture to `<folder>/attachments/` and returns the link text for it
    /// (`attachments/<name>`), relative to a note in `folder`. A name already taken gets a number.
    pub fn save_attachment(&mut self, folder: &str, name: &str, bytes: &[u8]) -> Result<String> {
        let root = self.root()?;
        let folder = clean_folder(folder);
        let name = attachments::clean_name(name)
            .ok_or_else(|| anyhow!("only pictures can be pasted into a note"))?;
        if bytes.is_empty() || bytes.len() > attachments::MAX_BYTES {
            bail!("that picture is too big to keep in a note (20 MB at most)");
        }
        let dir = abs(&root, &join_dir(&folder, attachments::DIR));
        let file = free_name(&dir, &name);
        write_bytes_atomic(&dir.join(&file), bytes)?;
        Ok(format!("{}/{file}", attachments::DIR))
    }

    /// The bytes of a picture a note in `folder` links as `attachments/<name>`, to show it on the page.
    pub fn attachment(&self, folder: &str, link: &str) -> Result<Vec<u8>> {
        let root = self.root()?;
        let name = link
            .strip_prefix(&format!("{}/", attachments::DIR))
            .filter(|n| attachments::is_clean(n))
            .ok_or_else(|| anyhow!("{link} is not a picture next to the note"))?;
        let path = abs(&root, &join_dir(&join_dir(&clean_folder(folder), attachments::DIR), name));
        std::fs::read(&path).with_context(|| format!("reading {}", path.display()))
    }

    /// Moves the pictures `body` links from one folder's `attachments/` to another's, renaming any whose name is
    /// taken there, and returns the body with its links fixed and the moves (for undo).
    pub(super) fn carry_attachments(
        &self,
        root: &Path,
        from: &str,
        to: &str,
        body: &str,
    ) -> Result<(String, Vec<UndoStep>)> {
        let names = attachments::linked(body);
        if from == to || names.is_empty() {
            return Ok((body.to_string(), Vec::new()));
        }
        let from_dir = join_dir(from, attachments::DIR);
        let to_dir = join_dir(to, attachments::DIR);
        let mut renamed = HashMap::new();
        let mut steps = Vec::new();
        for name in names {
            let src = format!("{from_dir}/{name}");
            if !abs(root, &src).is_file() {
                continue;
            }
            let dir = abs(root, &to_dir);
            std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
            let file = free_name(&dir, &name);
            let dst = format!("{to_dir}/{file}");
            rename_with_retry(&abs(root, &src), &abs(root, &dst))?;
            steps.push(UndoStep::FileMoved { from: src, to: dst });
            if file != name {
                renamed.insert(name, file);
            }
        }
        Ok((attachments::rename_links(body, &renamed), steps))
    }
}
