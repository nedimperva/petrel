//! Scratch pages: five pages that live in the capture window for the phone number, the shop list, the thing to
//! keep for an hour. They are files in `.scratch/1.md` to `5.md`: not notes (the scan skips dot folders, so
//! they are never found, filed or in the inbox), but synced, so the same five are on every computer.

use anyhow::{bail, Result};

use super::write_atomic;
use crate::store::Store;

pub const SCRATCH_DIR: &str = ".scratch";
pub const PAGES: u8 = 5;

impl Store {
    /// The text of scratch page `n` (1 to 5); empty when it was never written.
    pub fn scratch(&self, n: u8) -> Result<String> {
        check(n)?;
        let path = self.root()?.join(SCRATCH_DIR).join(format!("{n}.md"));
        match std::fs::read_to_string(&path) {
            Ok(t) => Ok(t),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(e.into()),
        }
    }

    /// Writes scratch page `n`. An empty page keeps an empty file rather than none, so a page emptied here is
    /// emptied on the other computers too.
    pub fn set_scratch(&self, n: u8, text: &str) -> Result<()> {
        check(n)?;
        let dir = self.root()?.join(SCRATCH_DIR);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{n}.md"));
        if !path.exists() && text.is_empty() {
            return Ok(());
        }
        write_atomic(&path, text)
    }
}

fn check(n: u8) -> Result<()> {
    if !(1..=PAGES).contains(&n) {
        bail!("there are {PAGES} scratch pages");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::notes::tests_support::{store_in, tmp};

    #[test]
    fn scratch_pages_are_files_the_scan_leaves_alone() {
        let dir = tmp();
        let mut s = store_in(&dir);
        assert_eq!(s.scratch(2).unwrap(), "");
        s.set_scratch(2, "milk, bread").unwrap();
        assert_eq!(s.scratch(2).unwrap(), "milk, bread");
        assert!(dir.join(".scratch/2.md").exists());
        assert!(s.set_scratch(6, "x").is_err());
        let r = s.scan_notes().unwrap();
        assert_eq!(r.added, 0);
    }
}
