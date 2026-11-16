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
    /// Moves or renames the file `id` to `path`, keeping its history there. `None` when the remote cannot, and
    /// the engine uploads a copy and trashes the old one instead.
    fn move_to(&mut self, _id: &str, _path: &str) -> Result<Option<RemoteFile>> {
        Ok(None)
    }
    /// Several uploads at once; a remote that can run them side by side overrides this.
    fn upload_many(&mut self, items: &[(String, Option<String>, Vec<u8>)]) -> Vec<Result<RemoteFile>> {
        items.iter().map(|(path, id, bytes)| self.upload(path, id.as_deref(), bytes)).collect()
    }
    /// Several downloads at once, in the order asked.
    fn download_many(&mut self, ids: &[String]) -> Vec<Result<Vec<u8>>> {
        ids.iter().map(|id| self.download(id)).collect()
    }
}

/// How many files go to `upload_many` or `download_many` at a time, so a first sync of a big folder does not
/// hold every file in memory at once.
const BATCH: usize = 24;

/// A note longer than this is not kept for merging; it keeps both copies on a clash, as before.
const BASE_MAX: usize = 512 * 1024;

/// A full look at the local folder at least this often, in case the watcher missed something.
pub const FULL_SCAN_MS: i64 = 60 * 60 * 1000;

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
    /// When the whole local folder was last scanned (ms). Between full scans only the paths the watcher
    /// names are looked at again.
    #[serde(default)]
    pub full_at: i64,
    /// Where the text of each synced note is kept, by md5, so a note changed on both sides can be merged
    /// against what both had (`<state file>.base/`). Not saved in the state; `load` sets it.
    #[serde(skip)]
    pub base_dir: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Synced {
    pub id: String,
    pub md5: String,
}

impl State {
    pub fn load(path: &Path) -> State {
        let mut s: State =
            std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        s.base_dir = Some(path.with_extension("base"));
        s
    }

    /// The text a note had at the last sync, if it was kept.
    fn base_text(&self, md5: &str) -> Option<String> {
        std::fs::read_to_string(self.base_dir.as_ref()?.join(md5)).ok()
    }

    /// Keeps the synced text of each note that has none kept yet, and (after a full scan) drops what no note
    /// has any more. Notes only: other files are not merged.
    fn keep_bases(&self, root: &Path, prune: bool) {
        let Some(dir) = &self.base_dir else { return };
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        for (path, s) in &self.synced {
            if !path.ends_with(".md") || is_history(path) || dir.join(&s.md5).exists() {
                continue;
            }
            let Ok(bytes) = std::fs::read(local(root, path)) else { continue };
            if bytes.len() <= BASE_MAX && md5_hex(&bytes) == s.md5 {
                let _ = write_bytes(&dir.join(&s.md5), &bytes);
            }
        }
        if prune {
            let wanted: BTreeSet<&str> = self.synced.values().map(|s| s.md5.as_str()).collect();
            for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                if !wanted.contains(e.file_name().to_string_lossy().as_ref()) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
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
    /// Moved or renamed on one side, so moved on the other rather than copied again.
    pub moved: usize,
    /// Both changed in different places, so both edits were kept in one text.
    pub merged: usize,
    /// Local files written or moved, relative to the folder, for the index to read again.
    pub changed: Vec<String>,
    /// Files that failed this time, with why; they are tried again next time.
    pub failed: Vec<(String, String)>,
    /// Each thing done, in order: what (`sent`, `received`, `moved`, `merged`, `kept both`, `to the trash
    /// here`, `to the trash there`) and the path. For the sync log.
    pub log: Vec<(String, String)>,
}

impl Report {
    fn did(&mut self, what: &str, path: &str) {
        self.log.push((what.to_string(), path.to_string()));
    }
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
    walk(root, root.to_path_buf(), seen, &mut out);
    seen.retain(|k, _| out.contains_key(k));
    Ok(out)
}

/// The local files as `scan` sees them, trusting `seen` for everything except the paths named (files or
/// folders, relative), which are looked at again. The watcher names what changed; this saves walking a folder
/// of thousands of notes and their histories every 30 seconds.
pub fn scan_paths(
    root: &Path,
    seen: &mut BTreeMap<String, (i64, u64, String)>,
    paths: &[String],
) -> BTreeMap<String, String> {
    for rel in paths {
        let under = format!("{rel}/");
        seen.retain(|k, _| k != rel && !k.starts_with(&under));
    }
    let mut out: BTreeMap<String, String> =
        seen.iter().map(|(k, (_, _, m))| (k.clone(), m.clone())).collect();
    for rel in paths {
        if rel.is_empty() || !syncs(rel) {
            continue;
        }
        let path = local(root, rel);
        match std::fs::metadata(&path) {
            Ok(m) if m.is_dir() => walk(root, path, seen, &mut out),
            Ok(m) if m.is_file() => look(root, &path, &m, seen, &mut out),
            _ => {}
        }
    }
    out
}

fn walk(
    root: &Path,
    start: PathBuf,
    seen: &mut BTreeMap<String, (i64, u64, String)>,
    out: &mut BTreeMap<String, String>,
) {
    let mut stack = vec![start];
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
            look(root, &path, &meta, seen, out);
        }
    }
}

/// One file: its md5 from `seen` when its size and time are the same, read again when not.
fn look(
    root: &Path,
    path: &Path,
    meta: &std::fs::Metadata,
    seen: &mut BTreeMap<String, (i64, u64, String)>,
    out: &mut BTreeMap<String, String>,
) {
    let Some(rel) = rel_of(root, path) else { return };
    if !syncs(&rel) || !meta.is_file() || meta.len() > MAX_BYTES {
        return;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64);
    let md5 = match seen.get(&rel) {
        Some((t, n, m)) if *t == mtime && *n == meta.len() => m.clone(),
        _ => {
            let Ok(bytes) = std::fs::read(path) else { return };
            let m = md5_hex(&bytes);
            seen.insert(rel.clone(), (mtime, meta.len(), m.clone()));
            m
        }
    };
    out.insert(rel, md5);
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

/// Now, as conflict copies are named: `2026-11-14 1830`.
pub fn stamp_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H%M").to_string()
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

/// Whether a path is a note's version (`.history/`), which is removed outright when the other side thinned it.
fn is_history(rel: &str) -> bool {
    rel.split('/').any(|part| part == ".history")
}

/// Moves a local file to `.trash/`, as Petrel's own trash does.
fn to_trash(root: &Path, rel: &str) -> Result<()> {
    if is_history(rel) {
        return std::fs::remove_file(local(root, rel)).with_context(|| format!("removing {rel}"));
    }
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
    std::fs::rename(local(root, rel), &target).with_context(|| format!("moving {rel} to the trash"))?;
    crate::notes::trash::note_place(root, &target.file_name().unwrap_or_default().to_string_lossy(), rel);
    Ok(())
}

/// Runs one sync of `root` with `remote`, looking at the whole local folder. `stamp` names conflict copies
/// (`2026-11-14 1830`).
pub fn sync(root: &Path, remote: &mut dyn Remote, state: &mut State, stamp: &str) -> Result<Report> {
    sync_hinted(root, remote, state, stamp, None)
}

/// One sync. `hint` names the local paths that may have changed since the last one (an empty list: none);
/// `None` scans the whole folder.
pub fn sync_hinted(
    root: &Path,
    remote: &mut dyn Remote,
    state: &mut State,
    stamp: &str,
    hint: Option<&[String]>,
) -> Result<Report> {
    let mut report = Report::default();
    let here = match hint {
        Some(paths) => scan_paths(root, &mut state.seen, paths),
        None => {
            let h = scan(root, &mut state.seen)?;
            state.full_at = chrono::Utc::now().timestamp_millis();
            h
        }
    };
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

    let mut paths: BTreeSet<String> =
        here.keys().chain(there.keys()).chain(state.synced.keys()).cloned().collect();
    moves(root, remote, state, &mut report, &here, &there, &mut paths);

    // One-sided changes go in batches, so a remote can run them side by side; the rest one by one.
    let mut ups: Vec<(String, Option<String>)> = Vec::new();
    let mut downs: Vec<(String, RemoteFile, Option<String>)> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    for path in paths {
        let l = here.get(&path).cloned();
        let r = there.get(&path).cloned();
        let base = state.synced.get(&path).map(|s| s.md5.clone());
        let rm = r.as_ref().map(|f| f.md5.clone());
        if l == rm {
            match &r {
                Some(f) => {
                    state.synced.insert(path, Synced { id: f.id.clone(), md5: f.md5.clone() });
                }
                None => {
                    state.synced.remove(&path);
                }
            }
            continue;
        }
        match (l != base, rm != base, l.is_some(), r) {
            (true, false, true, r) => ups.push((path, r.map(|f| f.id))),
            (false, true, _, Some(f)) => downs.push((path, f, l)),
            _ => rest.push(path),
        }
    }
    let mut failures_in_a_row = 0;
    let failed = |report: &mut Report, in_a_row: &mut usize, path: &str, e: anyhow::Error| -> Result<()> {
        report.failed.push((path.to_string(), format!("{e:#}")));
        *in_a_row += 1;
        // Offline or signed out: stop rather than fail every file one by one.
        if *in_a_row >= 3 {
            return Err(e.context("sync stopped after three failures in a row"));
        }
        Ok(())
    };

    for chunk in ups.chunks(BATCH) {
        let mut items = Vec::new();
        for (path, id) in chunk {
            match std::fs::read(local(root, path)) {
                Ok(bytes) => items.push((path.clone(), id.clone(), bytes)),
                Err(e) => report.failed.push((path.clone(), format!("reading {path}: {e}"))),
            }
        }
        let results = remote.upload_many(&items);
        for ((path, _, bytes), res) in items.iter().zip(results) {
            match res {
                Ok(f) => {
                    // What was sent, whatever the remote reports, is what both sides now have.
                    state.synced.insert(path.clone(), Synced { id: f.id, md5: md5_hex(bytes) });
                    report.uploaded += 1;
                    report.did("sent", path);
                    failures_in_a_row = 0;
                }
                Err(e) => failed(&mut report, &mut failures_in_a_row, path, e)?,
            }
        }
    }
    for chunk in downs.chunks(BATCH) {
        let mut wanted = Vec::new();
        for (path, f, seen) in chunk {
            match unchanged(root, path, seen.as_deref()) {
                Ok(true) => wanted.push((path, f)),
                Ok(false) => {
                    report.failed.push((path.clone(), format!("{path} changed while syncing; next time")))
                }
                Err(e) => report.failed.push((path.clone(), format!("{e:#}"))),
            }
        }
        let ids: Vec<String> = wanted.iter().map(|(_, f)| f.id.clone()).collect();
        let results = remote.download_many(&ids);
        for ((path, f), res) in wanted.into_iter().zip(results) {
            match res.and_then(|bytes| write_bytes(&local(root, path), &bytes)) {
                Ok(()) => {
                    state.synced.insert(path.clone(), Synced { id: f.id.clone(), md5: f.md5.clone() });
                    report.downloaded += 1;
                    report.did("received", path);
                    report.changed.push(path.clone());
                    failures_in_a_row = 0;
                }
                Err(e) => failed(&mut report, &mut failures_in_a_row, path, e)?,
            }
        }
    }
    for path in rest {
        let l = here.get(&path).cloned();
        let r = there.get(&path).cloned();
        let b = state.synced.get(&path).cloned();
        match decide(root, remote, state, &mut report, &path, l, r, b, stamp) {
            Ok(()) => failures_in_a_row = 0,
            Err(e) => failed(&mut report, &mut failures_in_a_row, &path, e)?,
        }
    }
    state.keep_bases(root, hint.is_none());
    Ok(report)
}

/// Renames and moves, on either side, done as moves on the other rather than a new copy and a deletion. A
/// move is a file gone from one path and the same text (md5) new at another, on one side only. Handled paths
/// are taken out of `paths`; anything that fails is left to the ordinary rules.
#[allow(clippy::too_many_arguments)]
fn moves(
    root: &Path,
    remote: &mut dyn Remote,
    state: &mut State,
    report: &mut Report,
    here: &BTreeMap<String, String>,
    there: &BTreeMap<String, RemoteFile>,
    paths: &mut BTreeSet<String>,
) {
    // Moved here: gone here and unchanged there; new here only, with the same text.
    let mut gone: Vec<(String, Synced)> = state
        .synced
        .iter()
        .filter(|(p, s)| !here.contains_key(*p) && there.get(*p).is_some_and(|f| f.md5 == s.md5))
        .map(|(p, s)| (p.clone(), s.clone()))
        .collect();
    let new_here: Vec<(String, String)> = here
        .iter()
        .filter(|(p, _)| !state.synced.contains_key(*p) && !there.contains_key(*p))
        .map(|(p, m)| (p.clone(), m.clone()))
        .collect();
    let mut moved_here = BTreeSet::new();
    for (to, md5) in new_here {
        let Some(i) = gone.iter().position(|(_, s)| s.md5 == md5) else { continue };
        let (from, s) = gone.remove(i);
        match remote.move_to(&s.id, &to) {
            Ok(Some(f)) => {
                state.synced.remove(&from);
                state.synced.insert(to.clone(), Synced { id: f.id, md5 });
                paths.remove(&from);
                paths.remove(&to);
                moved_here.insert(s.id);
                report.moved += 1;
                report.did("moved", &to);
            }
            // Not supported, or failed: the copy-and-trash rules still get there.
            Ok(None) => return,
            Err(_) => continue,
        }
    }
    // Moved there: the same id at a new path, the old path unchanged here and gone there.
    let by_id: BTreeMap<&str, (&String, &Synced)> =
        state.synced.iter().map(|(p, s)| (s.id.as_str(), (p, s))).collect();
    let mut todo = Vec::new();
    for (to, f) in there {
        if state.synced.contains_key(to) || here.contains_key(to) || moved_here.contains(&f.id) {
            continue;
        }
        let Some((from, s)) = by_id.get(f.id.as_str()) else { continue };
        if *from == to || there.contains_key(*from) || here.get(*from) != Some(&s.md5) || f.md5 != s.md5 {
            continue;
        }
        todo.push(((*from).clone(), to.clone(), f.clone()));
    }
    for (from, to, f) in todo {
        let target = local(root, &to);
        let moved = target
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::rename(local(root, &from), &target));
        if moved.is_err() {
            continue;
        }
        if let Some(seen) = state.seen.remove(&from) {
            state.seen.insert(to.clone(), seen);
        }
        state.synced.remove(&from);
        state.synced.insert(to.clone(), Synced { id: f.id, md5: f.md5 });
        paths.remove(&from);
        paths.remove(&to);
        report.did("moved", &to);
        report.changed.push(from);
        report.changed.push(to);
        report.moved += 1;
    }
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
                report.did("sent", path);
            }
            None => {
                if let Some(f) = &r {
                    remote.trash(&f.id)?;
                    report.trashed_there += 1;
                    report.did("to the trash there", path);
                }
                state.synced.remove(path);
            }
        },
        (false, true) => match &r {
            Some(f) => {
                download(root, remote, path, f, l.as_deref())?;
                synced(state, &f.id, &f.md5);
                report.downloaded += 1;
                report.did("received", path);
                report.changed.push(path.to_string());
            }
            None => {
                if l.is_some() {
                    if !unchanged(root, path, l.as_deref())? {
                        return Ok(());
                    }
                    to_trash(root, path)?;
                    report.trashed_here += 1;
                    report.did("to the trash here", path);
                    report.changed.push(path.to_string());
                }
                state.synced.remove(path);
            }
        },
        // Both changed, to different text (equal text returned above).
        _ => match (&l, &r) {
            (Some(here), Some(f)) => {
                let bytes = remote.download(&f.id)?;
                // Changed in different places: both edits in one text, on both sides.
                if let Some(merged) = merged(root, state, path, here, base.as_deref(), &bytes)? {
                    let u = remote.upload(path, Some(&f.id), merged.as_bytes())?;
                    write_bytes(&local(root, path), merged.as_bytes())?;
                    synced(state, &u.id, &md5_hex(merged.as_bytes()));
                    report.merged += 1;
                    report.did("merged", path);
                    report.changed.push(path.to_string());
                    return Ok(());
                }
                // The text here stays at its name; the other is kept beside it, and both go to both sides.
                let copy = conflict_name(root, path, stamp);
                write_bytes(&local(root, &copy), &bytes)?;
                report.changed.push(copy.clone());
                let c = upload(root, remote, &copy, None)?;
                state.synced.insert(copy, Synced { id: c.id, md5: c.md5 });
                let u = upload(root, remote, path, Some(&f.id))?;
                synced(state, &u.id, &u.md5);
                report.conflicts += 1;
                report.did("kept both", path);
            }
            // Deleted there, changed here: keep it.
            (Some(_), None) => {
                let u = upload(root, remote, path, None)?;
                synced(state, &u.id, &u.md5);
                report.uploaded += 1;
                report.did("sent", path);
            }
            // Deleted here, changed there: bring it back.
            (None, Some(f)) => {
                download(root, remote, path, f, None)?;
                synced(state, &f.id, &f.md5);
                report.downloaded += 1;
                report.did("received", path);
                report.changed.push(path.to_string());
            }
            (None, None) => {
                state.synced.remove(path);
            }
        },
    }
    Ok(())
}

/// A note both sides changed, merged against the text both had at the last sync, when the changes are in
/// different places. `None` when it is not a note, the base was not kept, the file changed since the scan,
/// or the changes clash.
fn merged(
    root: &Path,
    state: &State,
    path: &str,
    here: &str,
    base: Option<&str>,
    there: &[u8],
) -> Result<Option<String>> {
    if !path.ends_with(".md") || is_history(path) {
        return Ok(None);
    }
    let Some(base) = base.and_then(|m| state.base_text(m)) else { return Ok(None) };
    let Ok(there) = std::str::from_utf8(there) else { return Ok(None) };
    let bytes = std::fs::read(local(root, path))?;
    if md5_hex(&bytes) != here {
        return Ok(None);
    }
    let Ok(ours) = std::str::from_utf8(&bytes) else { return Ok(None) };
    Ok(crate::merge::merge3(&base, ours, there))
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
        fn move_to(&mut self, id: &str, path: &str) -> Result<Option<RemoteFile>> {
            let (p, b) = self.files.get_mut(id).ok_or_else(|| anyhow!("no {id}"))?;
            *p = path.to_string();
            Ok(Some(RemoteFile { id: id.into(), path: path.into(), md5: md5_hex(b) }))
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
        let trashed = std::fs::read_dir(b.join(TRASH_DIR)).unwrap().flatten();
        assert_eq!(trashed.filter(|e| !e.file_name().to_string_lossy().starts_with('.')).count(), 1);
        // Where it came from is written down, for Put back.
        assert!(std::fs::read_to_string(b.join(TRASH_DIR).join(".places"))
            .unwrap()
            .contains("\tinbox/milk.md"));
    }

    #[test]
    fn edits_in_different_places_merge() {
        let (a, b) = (tmp(), tmp());
        let mut drive = Fake::default();
        let base = |d: &Path| State { base_dir: Some(d.join(".state.base")), ..State::default() };
        let (mut sa, mut sb) = (base(&a), base(&b));
        put(&a, "Trip.md", "# Trip\n\nMonday: museum\nTuesday: market\nWednesday: hike\n");
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        sync(&b, &mut drive, &mut sb, "s").unwrap();
        put(&a, "Trip.md", "# Trip\n\nMonday: old town\nTuesday: market\nWednesday: hike\n");
        put(&b, "Trip.md", "# Trip\n\nMonday: museum\nTuesday: market\nWednesday: lake\n");
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        let r = sync(&b, &mut drive, &mut sb, "s").unwrap();
        assert_eq!((r.merged, r.conflicts), (1, 0));
        let both = "# Trip\n\nMonday: old town\nTuesday: market\nWednesday: lake\n";
        assert_eq!(read(&b, "Trip.md"), both);
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        assert_eq!(read(&a, "Trip.md"), both);
        assert!(!local(&b, "Trip (conflict s).md").exists());
        // A clash on the same line still keeps both copies.
        put(&a, "Trip.md", &both.replace("market", "bazaar"));
        put(&b, "Trip.md", &both.replace("market", "souk"));
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        assert_eq!(sync(&b, &mut drive, &mut sb, "s").unwrap().conflicts, 1);
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
    fn a_rename_is_a_move_on_both_sides() {
        let (a, b) = (tmp(), tmp());
        let mut drive = Fake::default();
        let (mut sa, mut sb) = (State::default(), State::default());
        put(&a, "inbox/Rome.md", "pasta\n");
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        sync(&b, &mut drive, &mut sb, "s").unwrap();
        std::fs::create_dir_all(local(&a, "Travel")).unwrap();
        std::fs::rename(local(&a, "inbox/Rome.md"), local(&a, "Travel/Rome.md")).unwrap();
        let r = sync(&a, &mut drive, &mut sa, "s").unwrap();
        assert_eq!((r.moved, r.uploaded, r.trashed_there), (1, 0, 0));
        assert!(drive.trashed.is_empty());
        let r = sync(&b, &mut drive, &mut sb, "s").unwrap();
        assert_eq!((r.moved, r.downloaded, r.trashed_here), (1, 0, 0));
        assert_eq!(read(&b, "Travel/Rome.md"), "pasta\n");
        assert!(!local(&b, "inbox/Rome.md").exists());
        assert_eq!(sync(&b, &mut drive, &mut sb, "s").unwrap(), Report::default());
    }

    #[test]
    fn a_hinted_scan_reads_only_what_it_is_told() {
        let a = tmp();
        let mut drive = Fake::default();
        let mut sa = State::default();
        put(&a, "One.md", "one\n");
        put(&a, "Two.md", "two\n");
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        assert!(sa.full_at > 0);
        put(&a, "One.md", "one, more\n");
        put(&a, "Two.md", "two, more\n");
        let r = sync_hinted(&a, &mut drive, &mut sa, "s", Some(&["One.md".to_string()])).unwrap();
        assert_eq!(r.uploaded, 1);
        // The full scan finds the other one.
        assert_eq!(sync(&a, &mut drive, &mut sa, "s").unwrap().uploaded, 1);
        // A folder named by the watcher is walked; a removed file is seen as removed.
        std::fs::remove_file(local(&a, "One.md")).unwrap();
        put(&a, "Travel/Rome.md", "pasta\n");
        let hint = ["One.md".to_string(), "Travel".to_string()];
        let r = sync_hinted(&a, &mut drive, &mut sa, "s", Some(&hint)).unwrap();
        assert_eq!((r.uploaded, r.trashed_there), (1, 1));
    }

    #[test]
    fn a_thinned_version_is_removed_not_trashed() {
        let (a, b) = (tmp(), tmp());
        let mut drive = Fake::default();
        let (mut sa, mut sb) = (State::default(), State::default());
        put(&a, "Travel/.history/Rome/1-edit.md", "old\n");
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        sync(&b, &mut drive, &mut sb, "s").unwrap();
        std::fs::remove_file(local(&a, "Travel/.history/Rome/1-edit.md")).unwrap();
        sync(&a, &mut drive, &mut sa, "s").unwrap();
        assert_eq!(sync(&b, &mut drive, &mut sb, "s").unwrap().trashed_here, 1);
        assert!(!b.join(TRASH_DIR).exists());
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
