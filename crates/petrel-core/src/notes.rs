//! Notes: Markdown files in a folder the person picks, beside the drafts in the database
//! (docs/design/notes.md).
//!
//! The files are the notes. Sub-folders are the tree, a note's title is its file name, tags and the pin are front
//! matter. The `notes` table is an index of them (title, preview, text for search, size, mtime, hash) that a scan
//! of the folder can rebuild; nothing in it is the only copy of anything except `note_versions`, the history
//! Petrel keeps for text it overwrote. Every write is a temp file and a rename, so a file on disk is always a
//! whole old or a whole new note. Text changed on disk while it was open in Petrel is kept as a conflict copy,
//! never overwritten. A trashed note goes to `.trash/` in the notes folder, never deleted.
//!
//! Drafts become notes by `promote_draft` (a new file) or `append_to_note` (added to the end of one). The draft
//! keeps its text and goes to the Archive with a `promotions` row pointing at the note; links to the draft are
//! rewritten to the note. Each of those, a rename and a trash returns an undo token that `Store::undo` takes.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::attachments;
use crate::links::{self, same, Link, Target};
use crate::store::{Store, UndoToken, VERSION_INTERVAL_MS};

mod conflicts;
mod days;
pub mod fold;
mod folders;
pub mod history;
mod linking;
mod looks;
pub mod passages;
mod paths;
mod pictures;
pub mod scratch;
mod tasks;
pub mod trash;
mod undo;

pub use conflicts::Conflict;
pub use tasks::OpenTask;
pub use trash::TrashItem;

/// The setting that holds the notes folder.
pub const ROOT_SETTING: &str = "notes.root";
/// Inside the notes folder; skipped by the scan like every other dot-folder.
pub const TRASH_DIR: &str = ".trash";
/// Captures land here until they are filed.
pub const INBOX_DIR: &str = "inbox";
/// Today's page and the days before it: `journal/YYYY-MM-DD.md`.
pub const JOURNAL_DIR: &str = "journal";
/// A collection's look in the library (colour and mark), kept in the folder so it syncs with it.
pub const FACE_FILE: &str = ".petrel";
/// Notes read for "the week", at most.
const BETWEEN_MAX: usize = 200;
/// Settings keys `copied.<path>` count copies (collections sort by them).
const COPY_PREFIX: &str = "copied.";
/// Settings keys `copied_in.<app>|<path>` count copies made from the picker with that app in front.
const COPY_IN_PREFIX: &str = "copied_in.";
/// More files than this in the notes folder are not indexed (a folder picked by mistake, like a home folder).
pub const SCAN_MAX: usize = 50_000;
/// Versions kept per note; older ones go first.
pub const NOTE_VERSIONS_KEPT: i64 = 200;
/// Links and mentions listed under a note, each.
const BACKLINKS_MAX: usize = 50;
/// Texts searched for links when a note is renamed or a draft promoted.
const REWRITE_MAX: usize = 2_000;
/// Longest title, in characters; a file name has to fit every file system.
const NOTE_TITLE_MAX: usize = 120;

pub(crate) const SCHEMA_V5: &str = r#"
CREATE TABLE notes (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  folder      TEXT NOT NULL,
  title       TEXT NOT NULL,
  preview     TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  front       TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  pinned      INTEGER NOT NULL DEFAULT 0,
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,
  hash        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL
);
CREATE INDEX notes_modified ON notes (modified_at DESC);
CREATE INDEX notes_accessed ON notes (accessed_at DESC);
CREATE INDEX notes_folder   ON notes (folder, modified_at DESC);
CREATE INDEX notes_title    ON notes (title COLLATE NOCASE);

CREATE VIRTUAL TABLE notes_fts USING fts5 (
  content, title,
  content = 'notes', content_rowid = 'id',
  tokenize = "unicode61 remove_diacritics 2"
);
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, content, title) VALUES (new.id, new.content, new.title);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, content, title) VALUES ('delete', old.id, old.content, old.title);
END;
CREATE TRIGGER notes_au AFTER UPDATE OF content, title ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, content, title) VALUES ('delete', old.id, old.content, old.title);
  INSERT INTO notes_fts (rowid, content, title) VALUES (new.id, new.content, new.title);
END;

CREATE TABLE note_versions (
  id         INTEGER PRIMARY KEY,
  note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX note_versions_note ON note_versions (note_id, created_at DESC);

CREATE TABLE promotions (
  draft_id  INTEGER PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
  note_path TEXT NOT NULL,
  kind      TEXT NOT NULL,
  at        INTEGER NOT NULL
);
"#;

// ---- wire types ----------------------------------------------------------------------------------------------

/// A whole note, as the note page needs it. `body` is the text without front matter.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: i64,
    /// Relative to the notes folder, `/` between parts: `Projects/Petrel/Roadmap.md`.
    pub path: String,
    /// `''` for the top of the notes folder.
    pub folder: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    /// Of the file as Petrel last read or wrote it; `save_note` takes it back to notice edits made elsewhere.
    pub hash: String,
    pub created_at: i64,
    pub modified_at: i64,
    pub version_count: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: i64,
    pub path: String,
    pub folder: String,
    pub title: String,
    pub preview: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub modified_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFolder {
    pub path: String,
    pub name: String,
    pub depth: usize,
    /// Notes directly in this folder.
    pub count: i64,
}

/// What `save_note` did.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedNote {
    pub hash: String,
    pub modified_at: i64,
    /// The file had changed on disk since it was opened: the other text is kept here (a path like `path`).
    pub conflict: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub added: usize,
    pub changed: usize,
    pub removed: usize,
    /// Files that could not be read as UTF-8 text; left alone.
    pub skipped: usize,
    pub root: String,
    /// The notes added, changed or gone, relative to the folder: the open note reloads when it is one of them.
    pub paths: Vec<String>,
}

/// A note changed by a rename, promote or append, and the undo token for it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteChange {
    pub note: Note,
    pub token: UndoToken,
    /// Other notes and drafts whose links were rewritten.
    pub relinked: usize,
}

/// One row of the `[[` list.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkTarget {
    /// `note` or `draft`.
    pub kind: String,
    pub id: i64,
    pub title: String,
    /// A note's folder, or a draft's (`inbox`, `archive`).
    pub folder: String,
    pub uuid: Option<String>,
    pub modified_at: i64,
}

/// Where a link goes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Resolved {
    Note {
        id: i64,
    },
    /// Nothing by that name. `draft` is true for `[[d:…]]` and `[[u:…]]`, which Petrel does not create.
    Missing {
        title: String,
        folder: Option<String>,
        draft: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackRef {
    pub kind: String,
    pub id: i64,
    pub title: String,
    /// The line with the link or the mention.
    pub line: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlinks {
    pub linked: Vec<BackRef>,
    /// Texts that name the note without linking to it.
    pub mentioned: Vec<BackRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteVersion {
    pub id: i64,
    pub reason: String,
    pub created_at: i64,
    pub length: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteQuery {
    /// Only this folder (not its sub-folders). None: every note.
    pub folder: Option<String>,
    pub pinned: Option<bool>,
    pub limit: Option<usize>,
}

// ---- undo ------------------------------------------------------------------------------------------------------

pub(crate) struct NotesUndo {
    pub(crate) token: String,
    steps: Vec<UndoStep>,
}

enum UndoStep {
    /// Undo: to the notes trash.
    FileCreated {
        path: String,
    },
    FileRenamed {
        from: String,
        to: String,
    },
    FileTrashed {
        path: String,
        trashed: PathBuf,
    },
    /// A file that is not a note (a picture) moved with one. Undo moves it back.
    FileMoved {
        from: String,
        to: String,
    },
    /// Undo puts `before` back if the file still holds `after`.
    NoteText {
        path: String,
        before: String,
        after: String,
    },
}

/// Undo tokens for notes start with this, so `Store::undo` knows which list to look in.
pub(crate) const TOKEN_PREFIX: &str = "note-";

// ---- front matter ----------------------------------------------------------------------------------------------

/// The part of front matter Petrel reads. Every other line is kept as written.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Front {
    pub tags: Vec<String>,
    pub pinned: bool,
    pub other: Vec<String>,
}

/// Splits `---` front matter off. Returns the raw block (delimiters and its last newline included, `''` when
/// there is none) and the body.
pub fn split_front(text: &str) -> (&str, &str) {
    let first_len = if text.starts_with("---\n") {
        4
    } else if text.starts_with("---\r\n") {
        5
    } else {
        return ("", text);
    };
    let mut at = first_len;
    for line in text[first_len..].split_inclusive('\n') {
        let end = at + line.len();
        let t = line.trim_end();
        if t == "---" || t == "..." {
            return (&text[..end], &text[end..]);
        }
        at = end;
    }
    ("", text)
}

pub fn parse_front(raw: &str) -> Front {
    let mut f = Front::default();
    let lines: Vec<&str> = raw.lines().collect();
    if lines.len() < 2 {
        return f;
    }
    let inner = &lines[1..lines.len() - 1];
    let mut i = 0;
    while i < inner.len() {
        let line = inner[i];
        let key = line.split_once(':').map(|(k, v)| (k.trim(), v.trim()));
        match key {
            Some(("tags", v)) if !line.starts_with(' ') => {
                let v = v.trim_start_matches('[').trim_end_matches(']');
                f.tags.extend(v.split(',').map(clean_tag).filter(|t| !t.is_empty()));
                while i + 1 < inner.len() && inner[i + 1].trim_start().starts_with("- ") {
                    i += 1;
                    let t = clean_tag(inner[i].trim_start().trim_start_matches("- "));
                    if !t.is_empty() {
                        f.tags.push(t);
                    }
                }
            }
            Some(("pinned", v)) if !line.starts_with(' ') => f.pinned = v.eq_ignore_ascii_case("true"),
            _ => f.other.push(line.to_string()),
        }
        i += 1;
    }
    f.tags.dedup();
    f
}

fn clean_tag(t: &str) -> String {
    t.trim().trim_matches(|c| c == '"' || c == '\'').trim_start_matches('#').trim().to_string()
}

pub fn render_front(f: &Front) -> String {
    if f.tags.is_empty() && !f.pinned && f.other.is_empty() {
        return String::new();
    }
    let mut s = String::from("---\n");
    for l in &f.other {
        s.push_str(l);
        s.push('\n');
    }
    if !f.tags.is_empty() {
        s.push_str("tags: [");
        s.push_str(&f.tags.join(", "));
        s.push_str("]\n");
    }
    if f.pinned {
        s.push_str("pinned: true\n");
    }
    s.push_str("---\n");
    s
}

// ---- files -----------------------------------------------------------------------------------------------------

fn hash(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64)
}

/// A temp file next to the target, synced, then renamed over it.
fn write_atomic(path: &Path, text: &str) -> Result<()> {
    let dir = path.parent().ok_or_else(|| anyhow!("{} has no folder", path.display()))?;
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("note");
    let tmp = dir.join(format!(".{name}.petrel-tmp"));
    {
        let mut f = std::fs::File::create(&tmp).with_context(|| format!("writing {}", tmp.display()))?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
    }
    rename_with_retry(&tmp, path)
}

/// Windows refuses a rename while another program (an indexer, a sync client) has the file open for a moment.
fn rename_with_retry(from: &Path, to: &Path) -> Result<()> {
    let mut last = None;
    for _ in 0..5 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(40));
            }
        }
    }
    Err(anyhow!("moving {} to {}: {}", from.display(), to.display(), last.expect("tried")))
}

/// `Title (conflict 2026-11-11 2114)`, as `conflict_copy` names the other side of a clash.
pub fn is_conflict_copy(title: &str) -> bool {
    title.ends_with(')')
        && title.rfind(" (conflict ").is_some_and(|at| {
            let rest = &title[at + 11..];
            rest.len() >= 10
                && rest.as_bytes()[..10].iter().enumerate().all(|(i, b)| {
                    if i == 4 || i == 7 {
                        *b == b'-'
                    } else {
                        b.is_ascii_digit()
                    }
                })
        })
}

/// A title that is a file name on Linux and Windows: no path or reserved characters, no dots or spaces at the
/// ends, at most `NOTE_TITLE_MAX` characters.
pub fn clean_title(title: &str) -> String {
    let s: String =
        title.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '-' } else { c }).collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s: String = s.chars().take(NOTE_TITLE_MAX).collect();
    let s = s.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    // Windows keeps these names for devices (`nul.md` too), so a note called Con could not be written there.
    if windows_reserved(&s) {
        format!("{s}_")
    } else {
        s
    }
}

/// CON, PRN, AUX, NUL, COM1–9 and LPT1–9, in any case, alone or before a dot.
pub fn windows_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// A folder path from the UI or a link: clean parts joined by `/`; `..`, `.` and dot-folders dropped.
pub fn clean_folder(folder: &str) -> String {
    folder
        .split(['/', '\\'])
        .filter(|p| !p.trim().starts_with('.'))
        .map(clean_title)
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn join_rel(folder: &str, title: &str) -> String {
    if folder.is_empty() {
        format!("{title}.md")
    } else {
        format!("{folder}/{title}.md")
    }
}

fn abs(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for part in rel.split('/') {
        p.push(part);
    }
    p
}

/// The first lines of the text after front matter, for cards: Markdown marks for headings and lists made plain,
/// blank lines dropped, at most `PREVIEW_LINES` lines and `PREVIEW_CHARS` characters (cut at a word).
fn body_preview(body: &str) -> String {
    let mut out = String::new();
    for (n, line) in body.lines().map(str::trim).filter(|l| !l.is_empty()).take(PREVIEW_LINES).enumerate() {
        let line = line.trim_start_matches('#').trim_start();
        let line = if let Some(rest) = line.strip_prefix("- [ ] ").or_else(|| line.strip_prefix("* [ ] ")) {
            format!("☐ {rest}")
        } else if let Some(rest) = ["- [x] ", "- [X] ", "* [x] "].iter().find_map(|m| line.strip_prefix(m)) {
            format!("☑ {rest}")
        } else if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            format!("• {rest}")
        } else {
            line.to_string()
        };
        if n > 0 {
            out.push('\n');
        }
        for (i, word) in line.split_whitespace().enumerate() {
            if out.chars().count() + word.chars().count() + 1 > PREVIEW_CHARS {
                return out.trim_end().to_string();
            }
            if i > 0 {
                out.push(' ');
            }
            out.push_str(word);
        }
    }
    out
}

const PREVIEW_LINES: usize = 6;
const PREVIEW_SETTING: &str = "notes.preview_format";
const PREVIEW_FORMAT: &str = "2";
const PREVIEW_CHARS: usize = 280;

/// An FTS5 query for the words of `text` as one phrase, or None when it has no words.
fn phrase(text: &str) -> Option<String> {
    let words: Vec<String> =
        text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(|w| w.to_string()).collect();
    (!words.is_empty()).then(|| format!("\"{}\"", words.join(" ")))
}

fn line_at(text: &str, at: usize) -> String {
    let start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let end = text[at..].find('\n').map_or(text.len(), |i| at + i);
    let line = text[start..end].trim();
    line.chars().take(200).collect()
}

/// Where `needle` first appears in `text` as a whole word, ignoring case. Byte offset into `text`.
fn find_word(text: &str, needle: &str) -> Option<usize> {
    let lower = text.to_lowercase();
    let n = needle.trim().to_lowercase();
    if n.is_empty() || lower.len() != text.len() {
        // Lowercasing changed the length: offsets would not line up. Fall back to an exact-case search.
        return text.find(needle.trim());
    }
    let mut from = 0;
    while let Some(i) = lower[from..].find(&n) {
        let at = from + i;
        let before = lower[..at].chars().next_back();
        let after = lower[at + n.len()..].chars().next();
        if !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric) {
            return Some(at);
        }
        from = at + n.len();
    }
    None
}

fn inside_any(links: &[Link], at: usize) -> bool {
    links.iter().any(|l| l.start <= at && at < l.end)
}

fn note_matches(t: &Target, folder: &str, title: &str) -> bool {
    match t {
        Target::Note { folder: None, title: t } => same(t, title),
        Target::Note { folder: Some(f), title: t } => same(t, title) && same(f, folder),
        _ => false,
    }
}

struct Row {
    id: i64,
    path: String,
    folder: String,
    title: String,
    front: String,
}

struct Text {
    id: i64,
    title: String,
    text: String,
}

impl Store {
    // ---- the folder --------------------------------------------------------------------------------------------

    pub fn notes_root(&self) -> Result<Option<PathBuf>> {
        Ok(self.setting(ROOT_SETTING)?.filter(|s| !s.is_empty()).map(PathBuf::from))
    }

    fn root(&self) -> Result<PathBuf> {
        self.notes_root()?.ok_or_else(|| anyhow!("no notes folder is set; choose one in Settings"))
    }

    /// Uses `default` when no folder was chosen yet. Does not create it until a note is written.
    pub fn notes_root_or(&mut self, default: &Path) -> Result<PathBuf> {
        if let Some(r) = self.notes_root()? {
            return Ok(r);
        }
        self.set_setting(ROOT_SETTING, &default.to_string_lossy())?;
        Ok(default.to_path_buf())
    }

    /// Points Petrel at another notes folder. The index is rebuilt from it; the old folder's files stay as
    /// they are, and so does their history in the database until the index forgets them.
    pub fn set_notes_root(&mut self, root: &Path) -> Result<ScanReport> {
        std::fs::create_dir_all(root).with_context(|| format!("creating {}", root.display()))?;
        if self.notes_root()?.as_deref() != Some(root) {
            self.set_setting(ROOT_SETTING, &root.to_string_lossy())?;
            self.conn.execute("DELETE FROM notes", [])?;
        }
        self.scan_notes()
    }

    /// Brings the index up to date with the folder: new and changed files are read, gone ones forgotten.
    /// Unchanged files cost a `stat`.
    pub fn scan_notes(&mut self) -> Result<ScanReport> {
        let root = self.root()?;
        let mut report = ScanReport { root: root.display().to_string(), ..Default::default() };
        if !root.is_dir() {
            report.removed = self.conn.execute("DELETE FROM notes", [])?;
            return Ok(report);
        }
        // Cards show a new kind of preview: read every file once more so none keeps the old one.
        if self.setting(PREVIEW_SETTING)?.as_deref() != Some(PREVIEW_FORMAT) {
            self.conn.execute("UPDATE notes SET mtime = -1", [])?;
            self.set_setting(PREVIEW_SETTING, PREVIEW_FORMAT)?;
        }
        let known: HashMap<String, (i64, i64)> = self
            .conn
            .prepare("SELECT path, size, mtime FROM notes")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?))))?
            .collect::<rusqlite::Result<_>>()?;
        let mut seen = HashSet::new();
        let mut stack = vec![(root.clone(), String::new())];
        let mut files = 0;
        let tx_start = self.conn.unchecked_transaction()?;
        while let Some((dir, rel_dir)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let Ok(meta) = e.metadata() else { continue };
                let rel = if rel_dir.is_empty() { name.clone() } else { format!("{rel_dir}/{name}") };
                if meta.is_dir() {
                    stack.push((e.path(), rel));
                    continue;
                }
                if !name.to_lowercase().ends_with(".md") {
                    continue;
                }
                files += 1;
                if files > SCAN_MAX {
                    break;
                }
                seen.insert(rel.clone());
                let size = meta.len() as i64;
                let mtime = mtime_ms(&meta);
                match known.get(&rel) {
                    Some(&(s, m)) if s == size && m == mtime => {}
                    Some(_) => match self.index_file(&root, &rel) {
                        Ok(true) => {
                            report.changed += 1;
                            report.paths.push(rel.clone());
                        }
                        _ => report.skipped += 1,
                    },
                    None => match self.index_file(&root, &rel) {
                        Ok(true) => {
                            report.added += 1;
                            report.paths.push(rel.clone());
                        }
                        _ => report.skipped += 1,
                    },
                }
            }
        }
        let mut forget = self.conn.prepare("DELETE FROM notes WHERE path = ?1")?;
        for path in known.keys() {
            if !seen.contains(path) {
                report.removed += forget.execute(params![path])?;
                report.paths.push(path.clone());
            }
        }
        drop(forget);
        tx_start.commit()?;
        Ok(report)
    }

    /// Reads one file into the index. False when it is not UTF-8 text (it is left out, never rewritten).
    fn index_file(&self, root: &Path, rel: &str) -> Result<bool> {
        let path = abs(root, rel);
        let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
        let meta = std::fs::metadata(&path)?;
        let Ok(text) = String::from_utf8(bytes) else {
            self.conn.execute("DELETE FROM notes WHERE path = ?1", params![rel])?;
            return Ok(false);
        };
        let (front_raw, body) = split_front(&text);
        let front = parse_front(front_raw);
        let (folder, file) = rel.rsplit_once('/').unwrap_or(("", rel));
        let title = file.strip_suffix(".md").or_else(|| file.strip_suffix(".MD")).unwrap_or(file);
        let mtime = mtime_ms(&meta);
        let created = meta.created().ok().map(mtime_ms_of).unwrap_or(mtime);
        let now = self.now();
        self.conn.execute(
            "INSERT INTO notes (path, folder, title, preview, content, front, tags, pinned, size, mtime, hash, \
                                created_at, modified_at, accessed_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?10, ?13) \
             ON CONFLICT (path) DO UPDATE SET folder = excluded.folder, title = excluded.title, \
               preview = excluded.preview, content = excluded.content, front = excluded.front, \
               tags = excluded.tags, pinned = excluded.pinned, size = excluded.size, mtime = excluded.mtime, \
               hash = excluded.hash, modified_at = excluded.modified_at",
            params![
                rel,
                folder,
                title,
                body_preview(body),
                text,
                front_raw,
                front.tags.join(","),
                front.pinned,
                meta.len() as i64,
                mtime,
                hash(&text),
                created.min(mtime),
                now
            ],
        )?;
        Ok(true)
    }

    fn row(&self, id: i64) -> Result<Row> {
        self.conn
            .query_row("SELECT id, path, folder, title, front FROM notes WHERE id = ?1", params![id], |r| {
                Ok(Row {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    folder: r.get(2)?,
                    title: r.get(3)?,
                    front: r.get(4)?,
                })
            })
            .optional()?
            .ok_or_else(|| anyhow!("note {id} is not in the notes folder (moved or deleted outside Petrel?)"))
    }

    fn id_of(&self, rel: &str) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row("SELECT id FROM notes WHERE path = ?1", params![rel], |r| r.get(0))
            .optional()?)
    }

    /// Re-reads the file if it changed since it was indexed. Errors when it is gone.
    fn refresh(&self, root: &Path, row: &Row) -> Result<()> {
        let path = abs(root, &row.path);
        let meta = std::fs::metadata(&path).map_err(|_| {
            anyhow!("{} is gone from the notes folder (moved or deleted outside Petrel?)", row.path)
        })?;
        let (size, mtime): (i64, i64) =
            self.conn.query_row("SELECT size, mtime FROM notes WHERE id = ?1", params![row.id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        if size != meta.len() as i64 || mtime != mtime_ms(&meta) {
            self.index_file(root, &row.path)?;
        }
        Ok(())
    }

    // ---- reading -----------------------------------------------------------------------------------------------

    /// A note, fresh from its file, marked accessed.
    pub fn note(&self, id: i64) -> Result<Note> {
        let n = self.peek_note(id)?;
        self.conn.execute("UPDATE notes SET accessed_at = ?2 WHERE id = ?1", params![id, self.now()])?;
        Ok(n)
    }

    /// A note without marking it accessed (previews, hover cards).
    pub fn peek_note(&self, id: i64) -> Result<Note> {
        let root = self.root()?;
        let row = self.row(id)?;
        self.refresh(&root, &row)?;
        self.conn
            .query_row(
                "SELECT id, path, folder, title, content, tags, pinned, hash, created_at, modified_at, \
                    (SELECT COUNT(*) FROM note_versions v WHERE v.note_id = n.id) \
             FROM notes n WHERE id = ?1",
                params![id],
                |r| {
                    let content: String = r.get(4)?;
                    Ok(Note {
                        id: r.get(0)?,
                        path: r.get(1)?,
                        folder: r.get(2)?,
                        title: r.get(3)?,
                        body: split_front(&content).1.to_string(),
                        tags: split_tags(&r.get::<_, String>(5)?),
                        pinned: r.get(6)?,
                        hash: r.get(7)?,
                        created_at: r.get(8)?,
                        modified_at: r.get(9)?,
                        version_count: r.get(10)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    pub fn list_notes(&self, q: &NoteQuery) -> Result<Vec<NoteSummary>> {
        let limit = q.limit.unwrap_or(100).min(1000) as i64;
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, path, folder, title, preview, tags, pinned, modified_at FROM notes \
             WHERE (?1 IS NULL OR folder = ?1) AND (?2 IS NULL OR pinned = ?2) \
             ORDER BY modified_at DESC, id DESC LIMIT ?3",
        )?;
        let rows =
            stmt.query_map(params![q.folder, q.pinned, limit], summary)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// `Ctrl P`, `[[` and Move to: notes whose title (or path) matches `text` the way Ctrl K matches commands,
    /// with case, accents and one typo forgiven (`fold`). The best match first, then the most recently opened.
    pub fn find_notes(&self, text: &str, limit: usize) -> Result<Vec<NoteSummary>> {
        if text.trim().is_empty() {
            let mut stmt = self.conn.prepare_cached(
                "SELECT id, path, folder, title, preview, tags, pinned, modified_at FROM notes \
                 ORDER BY accessed_at DESC, modified_at DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit as i64], summary)?.collect::<rusqlite::Result<_>>()?;
            return Ok(rows);
        }
        let all: Vec<(i64, String, String)> = {
            let mut stmt = self.conn.prepare_cached(
                "SELECT id, title, path FROM notes ORDER BY accessed_at DESC, modified_at DESC",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let q = fold::fold(text.trim());
        let mut hits: Vec<(f64, usize, i64)> = all
            .iter()
            .enumerate()
            .filter_map(|(i, (id, title, path))| {
                let t = fold::score(text, title);
                // A path holds the folder: "travel rome" finds Travel/Rome.md, but below any title match.
                let p = if t == 0.0 && fold::fold(path).contains(&q) { 5.0 } else { 0.0 };
                let s = t.max(p);
                (s > 0.0).then_some((s, i, *id))
            })
            .collect();
        // Best first; equal scores keep the order of last opened.
        hits.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        // Letters merely found in order are a last resort: only when nothing better matched.
        if hits.first().is_some_and(|h| h.0 >= 25.0) {
            hits.retain(|h| h.0 >= 25.0 || h.0 == 5.0);
        }
        hits.truncate(limit);
        let ids: Vec<i64> = hits.iter().map(|h| h.2).collect();
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, path, folder, title, preview, tags, pinned, modified_at FROM notes WHERE id IN rarray(?1)",
        )?;
        let found: Vec<NoteSummary> = stmt
            .query_map(params![crate::store::id_array(&ids)], summary)?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::with_capacity(found.len());
        for id in ids {
            if let Some(n) = found.iter().find(|n| n.id == id) {
                out.push(n.clone());
            }
        }
        Ok(out)
    }

    /// Search the text of notes (the same box syntax as drafts' words, without filters), best match first:
    /// bm25, with a word in the title worth four in the text.
    pub fn search_notes(&self, text: &str, limit: usize) -> Result<Vec<NoteSummary>> {
        let Some(q) = fts_words(text) else { return Ok(Vec::new()) };
        let mut stmt = self.conn.prepare_cached(
            "SELECT n.id, n.path, n.folder, n.title, n.preview, n.tags, n.pinned, n.modified_at \
             FROM notes_fts f JOIN notes n ON n.id = f.rowid WHERE notes_fts MATCH ?1 \
             ORDER BY bm25(notes_fts, 1.0, 4.0), n.modified_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![q, limit as i64], summary)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// The notes most about a question, best first, with their bodies: what "ask my notes" reads. Any word
    /// may match (short and common words are dropped), ranked by bm25.
    pub fn notes_about(&self, question: &str, limit: usize) -> Result<Vec<Note>> {
        let words: Vec<String> = question
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.chars().count() > 2 && !STOP.contains(&w.to_lowercase().as_str()))
            .map(|w| format!("\"{w}\"*"))
            .collect();
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare_cached(
            "SELECT f.rowid FROM notes_fts f WHERE notes_fts MATCH ?1 ORDER BY bm25(notes_fts) LIMIT ?2",
        )?;
        let ids: Vec<i64> = stmt
            .query_map(params![words.join(" OR "), limit as i64], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        ids.into_iter().map(|id| self.peek_note(id)).collect()
    }

    /// The notes most about a question among `within` only (a filter in Ctrl K), best first. When the words
    /// match fewer than `limit`, the rest of `within` follows in its order, so a question about a small
    /// collection reads all of it.
    pub fn notes_about_within(&self, question: &str, within: &[i64], limit: usize) -> Result<Vec<Note>> {
        let set: HashSet<i64> = within.iter().copied().collect();
        let mut ids: Vec<i64> = self
            .notes_about(question, 400)?
            .into_iter()
            .map(|n| n.id)
            .filter(|id| set.contains(id))
            .take(limit)
            .collect();
        for &id in within {
            if ids.len() >= limit {
                break;
            }
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        ids.into_iter().map(|id| self.peek_note(id)).collect()
    }

    /// Notes that share the most telling words with this one, without AI: the note's most frequent words (its
    /// title's count double), matched in the index, and kept only when a note has at least three of them.
    pub fn similar_notes(&self, id: i64, limit: usize) -> Result<Vec<NoteSummary>> {
        let note = self.peek_note(id)?;
        let mut counts: HashMap<String, usize> = HashMap::new();
        for w in passages::key_words(&note.title) {
            *counts.entry(w).or_default() += 2;
        }
        for w in fold::fold(&note.body).split(|c: char| !c.is_alphanumeric()) {
            if w.chars().count() > 3 && !STOP.contains(&w) && !w.chars().all(|c| c.is_ascii_digit()) {
                *counts.entry(w.to_string()).or_default() += 1;
            }
        }
        let mut words: Vec<(String, usize)> = counts.into_iter().collect();
        words.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let words: Vec<String> = words.into_iter().take(16).map(|(w, _)| w).collect();
        if words.len() < 3 {
            return Ok(Vec::new());
        }
        let q = words.iter().map(|w| format!("\"{w}\"*")).collect::<Vec<_>>().join(" OR ");
        let mut stmt = self.conn.prepare_cached(
            "SELECT n.id, n.path, n.folder, n.title, n.preview, n.tags, n.pinned, n.modified_at, n.content \
             FROM notes_fts f JOIN notes n ON n.id = f.rowid WHERE notes_fts MATCH ?1 AND n.id != ?2 \
             ORDER BY bm25(notes_fts, 1.0, 4.0) LIMIT 24",
        )?;
        let rows: Vec<(NoteSummary, String)> = stmt
            .query_map(params![q, id], |r| Ok((summary(r)?, r.get::<_, String>(8)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows
            .into_iter()
            // Whole words, so "plan" does not count "planet"; a conflict copy is the same note, not a related one.
            .filter(|(n, _)| !is_conflict_copy(&n.title))
            .filter(|(n, body)| {
                let text = fold::fold(&format!("{} {body}", n.title));
                let have: HashSet<&str> = text.split(|c: char| !c.is_alphanumeric()).collect();
                words.iter().filter(|w| have.contains(w.as_str())).count() >= 3
            })
            .map(|(n, _)| n)
            .take(limit)
            .collect())
    }

    /// The folders that hold notes, and the folders above them, in tree order.
    /// How many notes are right in `folder` ("" is the top of the folder).
    pub fn count_notes_in(&self, folder: &str) -> Result<usize> {
        let n: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM notes WHERE folder = ?1", params![folder], |r| r.get(0))?;
        Ok(n as usize)
    }

    pub fn note_folders(&self) -> Result<Vec<NoteFolder>> {
        let counts: Vec<(String, i64)> = self
            .conn
            .prepare("SELECT folder, COUNT(*) FROM notes GROUP BY folder")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut all: HashMap<String, i64> = HashMap::new();
        for (folder, n) in counts {
            if folder.is_empty() {
                continue;
            }
            let parts: Vec<&str> = folder.split('/').collect();
            for i in 1..parts.len() {
                all.entry(parts[..i].join("/")).or_insert(0);
            }
            *all.entry(folder).or_insert(0) += n;
        }
        // A collection just made from the sidebar has no notes yet: the folders on disk count too, two levels down.
        if let Ok(root) = self.root() {
            let mut stack = vec![(root, String::new(), 0)];
            while let Some((dir, rel, depth)) = stack.pop() {
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') || name == attachments::DIR || !e.path().is_dir() {
                        continue;
                    }
                    let path = if rel.is_empty() { name } else { format!("{rel}/{name}") };
                    all.entry(path.clone()).or_insert(0);
                    if depth < 1 {
                        stack.push((e.path(), path, depth + 1));
                    }
                }
            }
        }
        let mut out: Vec<NoteFolder> = all
            .into_iter()
            .map(|(path, count)| {
                let name = path.rsplit('/').next().unwrap_or(&path).to_string();
                NoteFolder { depth: path.matches('/').count(), name, path, count }
            })
            .collect();
        out.sort_by_key(|f| f.path.to_lowercase());
        Ok(out)
    }

    // ---- writing -----------------------------------------------------------------------------------------------

    /// Creates a note file. A title already taken in that folder gets a number (`Plan 2`).
    pub fn create_note(&mut self, folder: &str, title: &str, body: &str, tags: &[String]) -> Result<Note> {
        let root = self.root()?;
        let folder = clean_folder(folder);
        let base = clean_title(title);
        let base = if base.is_empty() { "Untitled".to_string() } else { base };
        let mut name = base.clone();
        let mut n = 2;
        while self.taken(&root, &join_rel(&folder, &name))? {
            name = format!("{base} {n}");
            n += 1;
        }
        let rel = join_rel(&folder, &name);
        let front = Front { tags: clean_tags(tags), ..Default::default() };
        write_atomic(&abs(&root, &rel), &(render_front(&front) + body))?;
        self.index_file(&root, &rel)?;
        let id = self.id_of(&rel)?.ok_or_else(|| anyhow!("{rel} was written but not indexed"))?;
        self.note(id)
    }

    /// The autosave write. `base_hash` is the hash the editor's text started from: if the file changed on disk
    /// since, the other text is kept as a conflict copy before this one is written.
    pub fn save_note(&mut self, id: i64, body: &str, base_hash: &str) -> Result<SavedNote> {
        let root = self.root()?;
        let row = self.row(id)?;
        let path = abs(&root, &row.path);
        let disk = std::fs::read_to_string(&path).ok();
        let mut conflict = None;
        let mut front = row.front.clone();
        if let Some(disk) = &disk {
            if hash(disk) != base_hash {
                let (their_front, their_body) = split_front(disk);
                // Front matter edited elsewhere (tags from another app) is kept; the body is the conflict.
                front = their_front.to_string();
                if their_body != body {
                    conflict = Some(self.conflict_copy(&root, &row, disk)?);
                }
            }
        }
        let text = format!("{front}{body}");
        if disk.as_deref() != Some(text.as_str()) {
            if let Some(old) = &disk {
                self.note_version_if_due(id, old)?;
            }
            write_atomic(&path, &text)?;
            self.index_file(&root, &row.path)?;
        }
        let (hash, modified_at) =
            self.conn.query_row("SELECT hash, modified_at FROM notes WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        Ok(SavedNote { hash, modified_at, conflict })
    }

    /// Whether a note path is in use: the file, the index, or a file that differs only in capitals. Windows sees
    /// `Plan.md` and `plan.md` as one file, so a twin made on Linux would clash there once synced.
    fn taken(&self, root: &Path, rel: &str) -> Result<bool> {
        if abs(root, rel).exists() || self.id_of(rel)?.is_some() {
            return Ok(true);
        }
        let file = rel.rsplit('/').next().unwrap_or(rel).to_lowercase();
        let dir = abs(root, rel);
        let Some(dir) = dir.parent() else { return Ok(false) };
        Ok(std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().to_lowercase() == file))
    }

    fn conflict_copy(&self, root: &Path, row: &Row, text: &str) -> Result<String> {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H%M");
        let base = format!("{} (conflict {stamp})", row.title);
        let mut name = base.clone();
        let mut n = 2;
        while self.taken(root, &join_rel(&row.folder, &name))? {
            name = format!("{base} {n}");
            n += 1;
        }
        let rel = join_rel(&row.folder, &name);
        write_atomic(&abs(root, &rel), text)?;
        self.index_file(root, &rel)?;
        Ok(rel)
    }

    fn note_version_if_due(&self, id: i64, text: &str) -> Result<()> {
        let now = self.now();
        let newest: Option<i64> = self.conn.query_row(
            "SELECT MAX(created_at) FROM note_versions WHERE note_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        if newest.is_some_and(|t| now - t < VERSION_INTERVAL_MS) {
            return Ok(());
        }
        self.note_version(id, text, "edit")
    }

    fn note_version(&self, id: i64, text: &str, reason: &str) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        let now = self.now();
        self.conn.execute(
            "INSERT INTO note_versions (note_id, content, reason, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, text, reason, now],
        )?;
        self.conn.execute(
            "DELETE FROM note_versions WHERE note_id = ?1 AND id NOT IN \
             (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2)",
            params![id, NOTE_VERSIONS_KEPT],
        )?;
        // The same version in the folder, so the history syncs with the notes. A failure here leaves the
        // version in the index, as before.
        if let (Ok(root), Ok(row)) = (self.root(), self.row(id)) {
            let _ = history::write(&root, &row.path, now, reason, text);
        }
        Ok(())
    }

    /// Rewrites the file's front matter with `f`, keeping the body.
    fn rewrite_front(&mut self, id: i64, f: impl FnOnce(&mut Front)) -> Result<Note> {
        let root = self.root()?;
        let row = self.row(id)?;
        let path = abs(&root, &row.path);
        let disk = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        let (raw, body) = split_front(&disk);
        let mut front = parse_front(raw);
        f(&mut front);
        let text = format!("{}{body}", render_front(&front));
        if text != disk {
            write_atomic(&path, &text)?;
            self.index_file(&root, &row.path)?;
        }
        self.peek_note(id)
    }

    pub fn set_note_pinned(&mut self, id: i64, pinned: bool) -> Result<Note> {
        self.rewrite_front(id, |f| f.pinned = pinned)
    }

    pub fn set_note_tags(&mut self, id: i64, tags: &[String]) -> Result<Note> {
        let tags = clean_tags(tags);
        self.rewrite_front(id, |f| f.tags = tags)
    }

    /// Moves the file to `.trash/` in the notes folder.
    pub fn trash_note(&mut self, id: i64) -> Result<UndoToken> {
        let root = self.root()?;
        let row = self.row(id)?;
        let trashed = self.move_to_trash(&root, &row.path)?;
        Ok(self.remember_notes(vec![UndoStep::FileTrashed { path: row.path, trashed }]))
    }

    fn move_to_trash(&self, root: &Path, rel: &str) -> Result<PathBuf> {
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
        rename_with_retry(&abs(root, rel), &target)?;
        trash::note_place(root, &target.file_name().unwrap_or_default().to_string_lossy(), rel);
        self.conn.execute("DELETE FROM notes WHERE path = ?1", params![rel])?;
        Ok(target)
    }

    /// Renames the note's file and rewrites every link to it in notes and drafts (each keeps a version first).
    pub fn rename_note(&mut self, id: i64, title: &str) -> Result<NoteChange> {
        let root = self.root()?;
        let row = self.row(id)?;
        let new_title = clean_title(title);
        if new_title.is_empty() {
            bail!("a note needs a title");
        }
        let mut steps = Vec::new();
        if new_title != row.title {
            let to = join_rel(&row.folder, &new_title);
            // A case-only rename is the same file on Windows and macOS.
            let same_file = to.to_lowercase() == row.path.to_lowercase();
            if !same_file && self.taken(&root, &to)? {
                bail!("there is already a note called “{new_title}” in that folder");
            }
            rename_with_retry(&abs(&root, &row.path), &abs(&root, &to))?;
            history::carry(&root, &row.path, &to);
            self.conn.execute(
                "UPDATE notes SET path = ?2, title = ?3 WHERE id = ?1",
                params![id, to, new_title],
            )?;
            self.index_file(&root, &to)?;
            steps.push(UndoStep::FileRenamed { from: row.path.clone(), to });
        }
        let (old_folder, old_title) = (row.folder.clone(), row.title.clone());
        let relinked = if same(&old_title, &new_title) {
            0
        } else {
            self.relink(&old_title, &mut steps, |t| {
                if note_matches(t, &old_folder, &old_title) {
                    match t {
                        Target::Note { folder, .. } => {
                            Some(Target::Note { folder: folder.clone(), title: new_title.clone() })
                        }
                        _ => None,
                    }
                } else {
                    None
                }
            })?
        };
        let token = self.remember_notes(steps);
        Ok(NoteChange { note: self.peek_note(id)?, token, relinked })
    }

    /// Files a note somewhere else: another folder, another title, or both. Links to it follow, as for a
    /// rename. This is how a capture leaves `inbox/`.
    pub fn move_note(&mut self, id: i64, folder: &str, title: &str) -> Result<NoteChange> {
        let root = self.root()?;
        let row = self.row(id)?;
        let new_folder = clean_folder(folder);
        let wanted = clean_title(title);
        let wanted = if wanted.is_empty() { row.title.clone() } else { wanted };
        if new_folder == row.folder {
            return self.rename_note(id, &wanted);
        }
        // A free name in the new folder: `Plan 2` when `Plan` is taken, as for a new note.
        let mut name = wanted.clone();
        let mut n = 2;
        while self.taken(&root, &join_rel(&new_folder, &name))? {
            name = format!("{wanted} {n}");
            n += 1;
        }
        let to = join_rel(&new_folder, &name);
        let target = abs(&root, &to);
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        rename_with_retry(&abs(&root, &row.path), &target)?;
        history::carry(&root, &row.path, &to);
        self.conn.execute(
            "UPDATE notes SET path = ?2, folder = ?3, title = ?4 WHERE id = ?1",
            params![id, to, new_folder, name],
        )?;
        self.index_file(&root, &to)?;
        let mut steps = vec![UndoStep::FileRenamed { from: row.path.clone(), to: to.clone() }];
        // Pictures the note links go with it, so the links keep working in the new folder.
        let before =
            std::fs::read_to_string(&target).with_context(|| format!("reading {}", target.display()))?;
        let (carried, moved) = self.carry_attachments(&root, &row.folder, &new_folder, &before)?;
        steps.extend(moved);
        if carried != before {
            write_atomic(&target, &carried)?;
            self.index_file(&root, &to)?;
            steps.push(UndoStep::NoteText { path: to.clone(), before, after: carried });
        }
        let (old_folder, old_title) = (row.folder.clone(), row.title.clone());
        let qualify_new = Some(new_folder.clone()).filter(|f| !f.is_empty());
        let relinked = self.relink(&old_title, &mut steps, |t| match t {
            Target::Note { folder, .. } if note_matches(t, &old_folder, &old_title) => {
                Some(Target::Note { folder: folder.as_ref().and(qualify_new.clone()), title: name.clone() })
            }
            _ => None,
        })?;
        let token = self.remember_notes(steps);
        Ok(NoteChange { note: self.peek_note(id)?, token, relinked })
    }

    /// Adds one note's text to the end of another, under the date and time, and moves the first to the trash.
    /// The inbox's "add to a note".
    pub fn merge_note(&mut self, from_id: i64, into_id: i64) -> Result<NoteChange> {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M");
        self.merge_with(from_id, into_id, Vec::new(), |body| format!("_{stamp}_\n\n{}\n", body.trim()))
    }

    /// The work of `merge_note`: `entry` turns the added text into what goes at the end. `steps` are undone after
    /// the merge's own (a day page made for it, say).
    fn merge_with(
        &mut self,
        from_id: i64,
        into_id: i64,
        mut steps: Vec<UndoStep>,
        entry: impl FnOnce(&str) -> String,
    ) -> Result<NoteChange> {
        if from_id == into_id {
            bail!("a note can't be added to itself");
        }
        let root = self.root()?;
        let from = self.peek_note(from_id)?;
        let row = self.row(into_id)?;
        let path = abs(&root, &row.path);
        let before = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        let (raw, body) = split_front(&before);
        let mut front = parse_front(raw);
        let mut front_text = raw.to_string();
        let mut tags = front.tags.clone();
        for t in &from.tags {
            if !tags.iter().any(|x| same(x, t)) {
                tags.push(t.clone());
            }
        }
        if tags != front.tags {
            front.tags = tags;
            front_text = render_front(&front);
        }
        let body = body.trim_end();
        let glue = if body.is_empty() { String::new() } else { format!("{body}\n\n") };
        self.note_version(into_id, &before, "before_append")?;
        let (added, moved) = self.carry_attachments(&root, &from.folder, &row.folder, &from.body)?;
        let after = format!("{front_text}{glue}{}", entry(&added));
        if let Err(e) = write_atomic(&path, &after) {
            // The pictures went ahead of the text: put them back where the capture still links them.
            for m in moved.iter().rev() {
                if let UndoStep::FileMoved { from, to } = m {
                    let _ = rename_with_retry(&abs(&root, to), &abs(&root, from));
                }
            }
            return Err(e);
        }
        self.index_file(&root, &row.path)?;
        let trashed = self.move_to_trash(&root, &from.path)?;
        steps.extend(moved);
        steps.push(UndoStep::NoteText { path: row.path.clone(), before, after });
        steps.push(UndoStep::FileTrashed { path: from.path.clone(), trashed });
        let token = self.remember_notes(steps);
        Ok(NoteChange { note: self.peek_note(into_id)?, token, relinked: 0 })
    }

    /// Writes every draft that is not in the Trash to a Markdown file once: Inbox drafts to `inbox/`, the
    /// others to `drafts/`. The drafts stay in the database, so nothing is lost if this goes wrong. Returns
    /// how many files were written; 0 when it already ran.
    pub fn export_drafts_once(&mut self) -> Result<usize> {
        const DONE: &str = "drafts.exported";
        if self.setting(DONE)?.is_some() {
            return Ok(0);
        }
        let root = self.root()?;
        std::fs::create_dir_all(&root)?;
        let rows: Vec<(String, String, i64, String, i64)> = self
            .conn
            .prepare(
                "SELECT d.title, d.content, d.folder, \
                    COALESCE((SELECT group_concat(t.name, ',') FROM draft_tags dt JOIN tags t ON t.id = dt.tag_id \
                              WHERE dt.draft_id = d.id), ''), d.created_at \
                 FROM drafts d WHERE d.deleted_at IS NULL AND d.folder != 2 AND trim(d.content) != ''",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut n = 0;
        for (title, content, folder, tags, created) in rows {
            let inbox = folder == 0;
            let to = if inbox { INBOX_DIR } else { "drafts" };
            let stamp = chrono::DateTime::from_timestamp_millis(created)
                .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H%M").to_string())
                .unwrap_or_default();
            let name = if inbox || title.trim().is_empty() {
                format!("{stamp} {}", title.chars().take(40).collect::<String>())
            } else {
                title.clone()
            };
            let tags = split_tags(&tags);
            let body = if inbox { content.clone() } else { without_title_line(&content, &title) };
            self.create_note(to, &name, &body, &tags)?;
            n += 1;
        }
        self.set_setting(DONE, &self.now().to_string())?;
        Ok(n)
    }

    /// A new capture: a file in `inbox/` named by the time it was made.
    pub fn capture_note(&mut self, body: &str) -> Result<Note> {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H%M%S").to_string();
        self.create_note(INBOX_DIR, &stamp, body, &[])
    }
}

/// A day as `YYYY-MM-DD`, refused when it is not a real date (the page's file name comes from it).
fn check_day(date: &str) -> Result<String> {
    let d = chrono::NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
        .map_err(|_| anyhow!("{date} is not a day (YYYY-MM-DD)"))?;
    Ok(d.format("%Y-%m-%d").to_string())
}

/// The line under an entry that came from the capture window, drawn small on the page.
pub const FROM_CAPTURE: &str = "_from capture_";

/// One entry on a day's page: the time, then the text, then where it came from. A quote, a list or a heading keeps
/// its own line and the mark goes after a blank line (a line right under a list would join its last item); plain
/// text ends with a hard break (two spaces) so the mark sits under it in any Markdown app.
fn day_entry(time: &str, body: &str) -> String {
    let body = body.trim();
    let block = body.starts_with(['>', '-', '*', '#', '!', '|', '`']) || body.starts_with("1.");
    if block {
        format!("{time}\n{body}\n\n{FROM_CAPTURE}\n")
    } else {
        format!("{time} {body}  \n{FROM_CAPTURE}\n")
    }
}

fn join_dir(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

/// `name` if no file in `dir` has it, else `stem-2.ext`, `stem-3.ext`…
fn free_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    (2..).map(|n| format!("{stem}-{n}.{ext}")).find(|c| !dir.join(c).exists()).expect("some number is free")
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().ok_or_else(|| anyhow!("{} has no folder", path.display()))?;
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("picture");
    let tmp = dir.join(format!(".{name}.petrel-tmp"));
    {
        let mut f = std::fs::File::create(&tmp).with_context(|| format!("writing {}", tmp.display()))?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    rename_with_retry(&tmp, path)
}

/// A collection's look, as the library draws it. The names are the UI's (`teal`, `plane`); empty is the default.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicFace {
    pub color: String,
    pub mark: String,
    /// `yes`: a collection of things to copy (cards in the library and the picker); `no`: pages, found with
    /// Ctrl K; empty: decided by its name (Prompts, Snippets… are to copy).
    pub copy: String,
}

#[derive(Default)]
struct FaceLines {
    color: Option<String>,
    mark: Option<String>,
    copy: Option<String>,
}

/// A colour or mark name: lower-case letters and `-`, short. Anything else is not one Petrel drew.
fn face_word(s: &str) -> Result<String> {
    let s = s.trim().to_lowercase();
    if s.len() > 24 || !s.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
        bail!("{s} is not a colour or mark Petrel knows");
    }
    Ok(s)
}

/// A text on one line of `.petrel`: `\` as `\\`, a newline as `\n`.
fn escape_line(text: &str) -> String {
    text.replace('\\', "\\\\").replace('\r', "").replace('\n', "\\n")
}

fn unescape_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some(o) => out.push(o),
            None => out.push('\\'),
        }
    }
    out
}

fn parse_face(text: &str) -> FaceLines {
    let mut f = FaceLines::default();
    for line in text.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let Ok(v) = face_word(v) else { continue };
        if v.is_empty() {
            continue;
        }
        match k.trim() {
            "color" => f.color = Some(v),
            "mark" => f.mark = Some(v),
            "copy" if v == "yes" || v == "no" => f.copy = Some(v),
            _ => {}
        }
    }
    f
}

fn mtime_ms_of(t: std::time::SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn split_tags(s: &str) -> Vec<String> {
    s.split(',').filter(|t| !t.is_empty()).map(str::to_string).collect()
}

fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags.iter().map(|t| clean_tag(t).replace(',', "")) {
        if !t.is_empty() && !out.iter().any(|x| same(x, &t)) {
            out.push(t);
        }
    }
    out
}

fn summary(r: &rusqlite::Row) -> rusqlite::Result<NoteSummary> {
    Ok(NoteSummary {
        id: r.get(0)?,
        path: r.get(1)?,
        folder: r.get(2)?,
        title: r.get(3)?,
        preview: r.get(4)?,
        tags: split_tags(&r.get::<_, String>(5)?),
        pinned: r.get(6)?,
        modified_at: r.get(7)?,
    })
}

/// Words too common to help find a note.
pub(crate) const STOP: &[&str] = &[
    "the", "and", "for", "are", "was", "what", "when", "where", "which", "who", "how", "why", "with", "that",
    "this", "have", "has", "had", "did", "does", "you", "your", "about", "from", "there", "their", "can",
    "could", "would", "should", "will", "into", "any", "all", "but", "not", "notes", "note", "my",
];

/// Each word as a prefix, all required: what a person typing in a search box means.
fn fts_words(text: &str) -> Option<String> {
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| {
            let ways: Vec<String> = fold::spellings(w).iter().map(|s| format!("\"{s}\"*")).collect();
            if ways.len() == 1 {
                ways[0].clone()
            } else {
                format!("({})", ways.join(" OR "))
            }
        })
        .collect();
    (!words.is_empty()).then(|| words.join(" AND "))
}

fn find_mention(text: &str, found: &[Link], title: &str) -> Option<usize> {
    let mut from = 0;
    while from < text.len() {
        let at = from + find_word(&text[from..], title)?;
        if !inside_any(found, at) {
            return Some(at);
        }
        from = at + title.len().max(1);
        while from < text.len() && !text.is_char_boundary(from) {
            from += 1;
        }
    }
    None
}

/// The draft's text without its first non-empty line when that line is the title (with or without `#`).
fn without_title_line(content: &str, title: &str) -> String {
    let mut lines = content.split_inclusive('\n');
    let mut skipped = String::new();
    for line in lines.by_ref() {
        if line.trim().is_empty() {
            skipped.push_str(line);
            continue;
        }
        let t = line.trim().trim_start_matches('#').trim();
        if same(t, title) || same(&clean_title(t), title) {
            let rest: String = lines.collect();
            return rest.trim_start_matches(['\n', '\r']).to_string();
        }
        return content.to_string();
    }
    let _ = skipped;
    content.to_string()
}

#[cfg(test)]
pub(crate) mod tests_support {
    use std::path::{Path, PathBuf};

    use crate::store::Store;

    pub fn store_in(dir: &Path) -> Store {
        let mut s = Store::open_in_memory().unwrap();
        s.set_notes_root(dir).unwrap();
        s
    }

    pub fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("petrel-notes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}

#[cfg(test)]
mod tests;
