//! Two-way sync of the notes folder with a remote folder (Google Drive, `src-tauri/src/drive.rs`), without a
//! sync service. The engine knows nothing about Drive: it sees a `Remote` that lists, reads, writes and trashes
//! files by path, so it is tested here against a fake.
//!
//! Each file is decided by comparing three versions: the file here, the file there, and the one both sides had
//! after the last sync (`State`, kept next to the index, rebuildable). Only one side changed: that change is
//! copied over. Both changed to different text: nothing is lost; the other side's text is kept beside it as
//! `Title (conflict 2026-11-14 1830).md`, which the library already offers to settle. A file deleted on one side
//! and changed on the other is kept. Files deleted from the remote go to `.trash/` here, never away.
//!
//! What syncs: every file in the folder except `.trash/`, Petrel's temporary files and other dot files; the
//! history (`.history/`), the collections' looks (`.petrel`) and the keys (`.petrel-keys.json`) do sync.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{anyhow, Context, Result};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};

use crate::notes::TRASH_DIR;

/// Larger files are left alone: notes and pictures, not videos.
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;

/// A file on the remote side, its path relative to the Petrel folder there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteFile {
    pub id: String,
    pub path: String,
    /// Lower-case hex, as Drive gives `md5Checksum`.
    pub md5: String,
}

/// The remote folder, as the engine needs it.
pub trait Remote {
    /// Whether anything may have changed there since the last call. A remote that cannot tell says yes.
    fn has_changes(&mut self) -> Result<bool> {
        Ok(true)
    }
    /// Every file under the Petrel folder.
    fn list(&mut self) -> Result<Vec<RemoteFile>>;
    fn download(&mut self, id: &str) -> Result<Vec<u8>>;
    /// New text for the file `id`, or a new file at `path` (its folders made as needed).
    fn upload(&mut self, path: &str, id: Option<&str>, bytes: &[u8]) -> Result<RemoteFile>;
    /// To the remote's trash, where it can be got back.
    fn trash(&mut self, id: &str) -> Result<()>;
}

/// What both sides had after the last sync, and a cache so unchanged files are not read again.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// Path → the remote id and the text's md5 both sides had.
    pub synced: BTreeMap<String, Synced>,
    /// Path → (modified ms, size, md5) of the local file when it was last read.
    pub seen: BTreeMap<String, (i64, u64, String)>,
    /// Whatever the remote keeps to know what changed (Drive's page token).
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Synced {
    pub id: String,
    pub md5: String,
}

impl State {
    pub fn load(path: &Path) -> State {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let bytes = serde_json::to_vec(self)?;
        write_bytes(path, &bytes)
    }
}

/// What one sync did.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub uploaded: usize,
    pub downloaded: usize,
    /// Deleted there, so moved to `.trash/` here.
    pub trashed_here: usize,
    /// Deleted here, so moved to the remote's trash.
    pub trashed_there: usize,
    pub conflicts: usize,
    /// Local files written or moved, relative to the folder, for the index to read again.
    pub changed: Vec<String>,
    /// Files that failed this time, with why; they are tried again next time.
    pub failed: Vec<(String, String)>,
}

/// Whether a path in the folder syncs.
pub fn syncs(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if name.ends_with(".petrel-tmp") || name == "desktop.ini" || name == ".DS_Store" || name == "Thumbs.db" {
        return false;
    }
    rel.split('/').all(|part| {
        !part.starts_with('.') || part == ".history" || part == ".petrel" || part == ".petrel-keys.json"
    }) && !rel.starts_with(TRASH_DIR)
}

pub fn md5_hex(bytes: &[u8]) -> String {
    let d = Md5::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// The local files that sync, with their md5, reading only those whose size or time changed since `seen`.
pub fn scan(
    root: &Path,
    seen: &mut BTreeMap<String, (i64, u64, String)>,
) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let path = e.path();
            let Some(rel) = rel_of(root, &path) else { continue };
            if !syncs(&rel) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            if !meta.is_file() || meta.len() > MAX_BYTES {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64);
            let md5 = match seen.get(&rel) {
                Some((t, n, m)) if *t == mtime && *n == meta.len() => m.clone(),
                _ => {
                    let Ok(bytes) = std::fs::read(&path) else { continue };
                    let m = md5_hex(&bytes);
                    seen.insert(rel.clone(), (mtime, meta.len(), m.clone()));
                    m
                }
            };
            out.insert(rel, md5);
        }
    }
    seen.retain(|k, _| out.contains_key(k));
    Ok(out)
}

fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Option<Vec<&str>> = rel.components().map(|c| c.as_os_str().to_str()).collect();
    Some(parts?.join("/"))
}

fn local(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part))
}

/// A temp file beside the target, synced, then renamed over it.
fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().ok_or_else(|| anyhow!("{} has no folder", path.display()))?;
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.petrel-tmp"));
    {
        let mut f = std::fs::File::create(&tmp).with_context(|| format!("writing {}", tmp.display()))?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    let mut last = None;
    for _ in 0..5 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
        }
    }
    Err(anyhow!("moving {} to {}: {}", tmp.display(), path.display(), last.expect("tried")))
}

/// `Travel/Rome.md` → `Travel/Rome (conflict 2026-11-14 1830).md`, a name not taken here.
pub fn conflict_name(root: &Path, rel: &str, stamp: &str) -> String {
    let (folder, file) = rel.rsplit_once('/').map_or(("", rel), |(a, b)| (a, b));
    let (stem, ext) = file.rsplit_once('.').map_or((file, ""), |(a, b)| (a, b));
    let ext = if ext.is_empty() { String::new() } else { format!(".{ext}") };
    let join = |name: String| if folder.is_empty() { name } else { format!("{folder}/{name}") };
    let mut n = 1;
    loop {
        let suffix = if n == 1 { String::new() } else { format!(" {n}") };
        let candidate = join(format!("{stem} (conflict {stamp}{suffix}){ext}"));
        if !local(root, &candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Moves a local file to `.trash/`, as Petrel's own trash does.
fn to_trash(root: &Path, rel: &str) -> Result<()> {
    let dir = root.join(TRASH_DIR);
    std::fs::create_dir_all(&dir)?;
    let file = rel.rsplit('/').next().unwrap_or(rel);
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut target = dir.join(format!("{stamp} {file}"));
    let mut n = 2;
    while target.exists() {
        target = dir.join(format!("{stamp} {n} {file}"));
        n += 1;
    }
    std::fs::rename(local(root, rel), &target).with_context(|| format!("moving {rel} to the trash"))
}

/// Runs one sync of `root` with `remote`. `stamp` names conflict copies (`2026-11-14 1830`).
pub fn sync(root: &Path, remote: &mut dyn Remote, state: &mut State, stamp: &str) -> Result<Report> {
    let mut report = Report::default();
    let here = scan(root, &mut state.seen)?;
    let local_changed = here.len() != state.synced.len()
        || here.iter().any(|(p, m)| state.synced.get(p).is_none_or(|s| &s.md5 != m));
    let remote_changed = remote.has_changes()?;
    if !local_changed && !remote_changed {
        return Ok(report);
    }
    // When the remote says nothing changed there, it still has what was synced: no need to list it.
    let there: BTreeMap<String, RemoteFile> = if remote_changed {
        let mut m = BTreeMap::new();
        for f in remote.list()? {
            if syncs(&f.path) {
                m.entry(f.path.clone()).or_insert(f);
            }
        }
        m
    } else {
        state
            .synced
            .iter()
            .map(|(p, s)| (p.clone(), RemoteFile { id: s.id.clone(), path: p.clone(), md5: s.md5.clone() }))
            .collect()
    };

    let paths: BTreeSet<String> =
        here.keys().chain(there.keys()).chain(state.synced.keys()).cloned().collect();
    let mut failures_in_a_row = 0;
    for path in paths {
        let l = here.get(&path).cloned();
        let r = there.get(&path).cloned();
        let b = state.synced.get(&path).cloned();
        let done = decide(root, remote, state, &mut report, &path, l, r, b, stamp);
        match done {
            Ok(()) => failures_in_a_row = 0,
            Err(e) => {
                report.failed.push((path.clone(), format!("{e:#}")));
                failures_in_a_row += 1;
                // Offline or signed out: stop rather than fail every file one by one.
                if failures_in_a_row >= 3 {
                    return Err(e.context("sync stopped after three failures in a row"));
                }
            }
        }
    }
    Ok(report)
}

#[allow(clippy::too_many_arguments)]
fn decide(
    root: &Path,
    remote: &mut dyn Remote,
    state: &mut State,
    report: &mut Report,
    path: &str,
    l: Option<String>,
    r: Option<RemoteFile>,
    b: Option<Synced>,
    stamp: &str,
) -> Result<()> {
    let base = b.as_ref().map(|s| s.md5.clone());
    let rm = r.as_ref().map(|f| f.md5.clone());
    let synced = |state: &mut State, id: &str, md5: &str| {
        state.synced.insert(path.to_string(), Synced { id: id.to_string(), md5: md5.to_string() });
    };
    if l == rm {
        match &r {
            Some(f) => synced(state, &f.id, &f.md5),
            None => {
                state.synced.remove(path);
            }
        }
        return Ok(());
    }
    let here_changed = l != base;
    let there_changed = rm != base;
    match (here_changed, there_changed) {
        (true, false) => match &l {
            Some(_) => {
                let f = upload(root, remote, path, r.as_ref().map(|f| f.id.as_str()))?;
                synced(state, &f.id, &f.md5);
                report.uploaded += 1;
            }
            None => {
                if let Some(f) = &r {
                    remote.trash(&f.id)?;
                    report.trashed_there += 1;
                }
                state.synced.remove(path);
            }
        },
        (false, true) => match &r {
            Some(f) => {
                download(root, remote, path, f, l.as_deref())?;
                synced(state, &f.id, &f.md5);
                report.downloaded += 1;
                report.changed.push(path.to_string());
            }
            None => {
                if l.is_some() {
                    if !unchanged(root, path, l.as_deref())? {
                        return Ok(());
                    }
                    to_trash(root, path)?;
                    report.trashed_here += 1;
                    report.changed.push(path.to_string());
                }
                state.synced.remove(path);
            }
        },
        // Both changed, to different text (equal text returned above).
        _ => match (&l, &r) {
            (Some(_), Some(f)) => {
                // The text here stays at its name; the other is kept beside it, and both go to both sides.
                let bytes = remote.download(&f.id)?;
                let copy = conflict_name(root, path, stamp);
                write_bytes(&local(root, &copy), &bytes)?;
                report.changed.push(copy.clone());
                let c = upload(root, remote, &copy, None)?;
                state.synced.insert(copy, Synced { id: c.id, md5: c.md5 });
                let u = upload(root, remote, path, Some(&f.id))?;
                synced(state, &u.id, &u.md5);
                report.conflicts += 1;
            }
            // Deleted there, changed here: keep it.
            (Some(_), None) => {
                let u = upload(root, remote, path, None)?;
                synced(state, &u.id, &u.md5);
                report.uploaded += 1;
            }
            // Deleted here, changed there: bring it back.
            (None, Some(f)) => {
                download(root, remote, path, f, None)?;
                synced(state, &f.id, &f.md5);
                report.downloaded += 1;
                report.changed.push(path.to_string());
            }
            (None, None) => {
                state.synced.remove(path);
            }
        },
    }
    Ok(())
}

/// Whether the local file is still what the scan saw (or still missing), so a write never lands on new typing.
fn unchanged(root: &Path, path: &str, seen: Option<&str>) -> Result<bool> {
    let now = match std::fs::read(local(root, path)) {
        Ok(bytes) => Some(md5_hex(&bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    Ok(now.as_deref() == seen)
}

fn upload(root: &Path, remote: &mut dyn Remote, path: &str, id: Option<&str>) -> Result<RemoteFile> {
    let bytes = std::fs::read(local(root, path)).with_context(|| format!("reading {path}"))?;
    let f = remote.upload(path, id, &bytes)?;
    // What was sent, whatever the remote reports, is what both sides now have.
    Ok(RemoteFile { md5: md5_hex(&bytes), ..f })
}

fn download(
    root: &Path,
    remote: &mut dyn Remote,
    path: &str,
    f: &RemoteFile,
    seen: Option<&str>,
) -> Result<()> {
    if !unchanged(root, path, seen)? {
        return Err(anyhow!("{path} changed while syncing; next time"));
    }
    let bytes = remote.download(&f.id)?;
    write_bytes(&local(root, path), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A remote folder in memory, shared by two "computers".
    #[derive(Default, Clone)]
    struct Fake {
        files: BTreeMap<String, (String, Vec<u8>)>,
        next: usize,
        trashed: Vec<String>,
    }

    impl Remote for Fake {
        fn list(&mut self) -> Result<Vec<RemoteFile>> {
            Ok(self
                .files
                .iter()
                .map(|(id, (path, b))| RemoteFile { id: id.clone(), path: path.clone(), md5: md5_hex(b) })
                .collect())
        }
        fn download(&mut self, id: &str) -> Result<Vec<u8>> {
            self.files.get(id).map(|(_, b)| b.clone()).ok_or_else(|| anyhow!("no {id}"))
        }
        fn upload(&mut self, path: &str, id: Option<&str>, bytes: &[u8]) -> Result<RemoteFile> {
            let id = match id {
                Some(id) => id.to_string(),
                None => {
                    self.next += 1;
                    format!("f{}", self.next)
                }
            };
            self.files.insert(id.clone(), (path.to_string(), bytes.to_vec()));
            Ok(RemoteFile { id, path: path.into(), md5: md5_hex(bytes) })
        }
        fn trash(&mut self, id: &str) -> Result<()> {
            self.files.remove(id);
            self.trashed.push(id.into());
            Ok(())
        }
    }

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("petrel-sync-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(root: &Path, rel: &str, text: &str) {
        let p = local(root, rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
        // Times on some file systems are coarse; the cache must not miss a change of the same size.
        std::thread::sleep(std::time::Duration::from_millis(15));
    }

    fn read(root: &Path, rel: &str) -> String {
        std::fs::read_to_string(local(root, rel)).unwrap()
    }

    #[test]
    fn what_syncs() {
        assert!(syncs("Travel/Rome.md"));
        assert!(syncs("Travel/.history/Rome/1-edit.md"));
        assert!(syncs("Prompts/.petrel"));
        assert!(syncs("inbox/attachments/a.png"));
        assert!(!syncs(".trash/x.md"));
        assert!(!syncs("Travel/.Rome.md.petrel-tmp"));
        assert!(!syncs(".git/config"));
    }

    #[test]
    fn two_computers_meet_through_the_remote() {
        let (a, b) = (tmp(), tmp());
        let mut drive = Fake::default();
        let (mut sa, mut sb) = (State::default(), State::default());
        put(&a, "Travel/Rome.md", "pasta\n");
        put(&a, "inbox/milk.md", "milk\n");
        let r = sync(&a, &mut drive, &mut sa, "s").unwrap();
        assert_eq!(r.uploaded, 2);
        let r = sync(&b, &mut drive, &mut sb, "s").unwrap();
        assert_eq!(r.downloaded, 2);
        assert_eq!(read(&b, "Travel/Rome.md"), "pasta\n");
        // Nothing changed anywhere: nothing to do.
        assert_eq!(sync(&a, &mut drive, &mut sa, "s").unwrap(), Report::default());

        // An edit on B reaches A.
        put(&b, "Travel/Rome.md", "pasta, gelato\n");
        assert_eq!(sync(&b, &mut drive, &mut sb, "s").unwrap().uploaded, 1);
        assert_eq!(sync(&a, &mut drive, &mut sa, "s").unwrap().downloaded, 1);
        assert_eq!(read(&a, "Travel/Rome.md"), "pasta, gelato\n");

        // A deletes; B's copy goes to its trash, not away.
        std::fs::remove_file(local(&a, "inbox/milk.md")).unwrap();
        assert_eq!(sync(&a, &mut drive, &mut sa, "s").unwrap().trashed_there, 1);
        let r = sync(&b, &mut drive, &mut sb, "s").unwrap();
        assert_eq!(r.trashed_here, 1);
        assert!(!local(&b, "inbox/milk.md").exists());
        assert_eq!(std::fs::read_dir(b.join(TRASH_DIR)).unwrap().count(), 1);
    }

    #[test]
    fn both_changed_keeps_both() {
        let (a, b) = (tmp(), tmp());
        let mut drive = Fake::default();
        let (mut sa, mut sb) = (State::default(), State::default());
        put(&a, "Plan.md", "one\n");
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        sync(&b, &mut drive, &mut sb, "s").unwrap();
        put(&a, "Plan.md", "one, from A\n");
        put(&b, "Plan.md", "one, from B\n");
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        let r = sync(&b, &mut drive, &mut sb, "2026-11-14 1830").unwrap();
        assert_eq!(r.conflicts, 1);
        assert_eq!(read(&b, "Plan.md"), "one, from B\n");
        assert_eq!(read(&b, "Plan (conflict 2026-11-14 1830).md"), "one, from A\n");
        // A gets both.
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        assert_eq!(read(&a, "Plan.md"), "one, from B\n");
        assert_eq!(read(&a, "Plan (conflict 2026-11-14 1830).md"), "one, from A\n");
        // And then all is quiet.
        assert_eq!(sync(&a, &mut drive, &mut sa, "s").unwrap(), Report::default());
        assert_eq!(sync(&b, &mut drive, &mut sb, "s").unwrap(), Report::default());
    }

    #[test]
    fn a_change_wins_over_a_delete() {
        let (a, b) = (tmp(), tmp());
        let mut drive = Fake::default();
        let (mut sa, mut sb) = (State::default(), State::default());
        put(&a, "Plan.md", "one\n");
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        sync(&b, &mut drive, &mut sb, "s").unwrap();
        std::fs::remove_file(local(&a, "Plan.md")).unwrap();
        put(&b, "Plan.md", "one, still wanted\n");
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        sync(&b, &mut drive, &mut sb, "s").unwrap();
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        assert_eq!(read(&a, "Plan.md"), "one, still wanted\n");
    }

    #[test]
    fn first_sync_of_two_full_folders_merges() {
        let (a, b) = (tmp(), tmp());
        let mut drive = Fake::default();
        let (mut sa, mut sb) = (State::default(), State::default());
        put(&a, "Same.md", "same\n");
        put(&a, "OnlyA.md", "a\n");
        put(&b, "Same.md", "same\n");
        put(&b, "OnlyB.md", "b\n");
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        let r = sync(&b, &mut drive, &mut sb, "s").unwrap();
        assert_eq!((r.conflicts, r.downloaded, r.uploaded), (0, 1, 1));
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        assert_eq!(read(&a, "OnlyB.md"), "b\n");
        assert_eq!(drive.files.len(), 3);
    }

    #[test]
    fn state_survives_a_restart() {
        let a = tmp();
        let mut drive = Fake::default();
        let mut sa = State::default();
        put(&a, "Plan.md", "one\n");
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        let file = a.join(".sync-test.json");
        sa.save(&file).unwrap();
        let mut again = State::load(&file);
        assert_eq!(again.synced, sa.synced);
        assert_eq!(sync(&a, &mut drive, &mut again, "s").unwrap(), Report::default());
    }
}
