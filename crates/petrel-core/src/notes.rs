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
use crate::store::{Folder, Store, UndoToken, VERSION_INTERVAL_MS};
use crate::title;

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

/// A draft that became (part of) a note.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Promotion {
    pub note_path: String,
    pub note_title: String,
    /// The note's id while its file is indexed.
    pub note_id: Option<i64>,
    /// `promote` or `append`.
    pub kind: String,
    pub at: i64,
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
    Draft {
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
    DraftText {
        id: i64,
        before: String,
        after: String,
    },
    DraftBatch {
        token: String,
    },
    Promotion {
        draft_id: i64,
        previous: Option<(String, String, i64)>,
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

/// A title that is a file name on Linux and Windows: no path or reserved characters, no dots or spaces at the
/// ends, at most `NOTE_TITLE_MAX` characters.
pub fn clean_title(title: &str) -> String {
    let s: String =
        title.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '-' } else { c }).collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s: String = s.chars().take(NOTE_TITLE_MAX).collect();
    s.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string()
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

/// An FTS5 query for titles starting with the words of `text`.
fn title_prefix(text: &str) -> Option<String> {
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| format!("title : \"{w}\"*"))
        .collect();
    (!words.is_empty()).then(|| words.join(" AND "))
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
    kind: &'static str,
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
                        Ok(true) => report.changed += 1,
                        _ => report.skipped += 1,
                    },
                    None => match self.index_file(&root, &rel) {
                        Ok(true) => report.added += 1,
                        _ => report.skipped += 1,
                    },
                }
            }
        }
        let mut forget = self.conn.prepare("DELETE FROM notes WHERE path = ?1")?;
        for path in known.keys() {
            if !seen.contains(path) {
                report.removed += forget.execute(params![path])?;
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

    /// `Ctrl P`: notes whose title holds `text`, those starting with it first, then the most recently opened.
    pub fn find_notes(&self, text: &str, limit: usize) -> Result<Vec<NoteSummary>> {
        let t = text.trim().to_lowercase().replace(['%', '_'], "");
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, path, folder, title, preview, tags, pinned, modified_at FROM notes \
             WHERE ?1 = '' OR lower(title) LIKE '%' || ?1 || '%' OR lower(path) LIKE '%' || ?1 || '%' \
             ORDER BY (lower(title) LIKE ?1 || '%') DESC, accessed_at DESC, modified_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![t, limit as i64], summary)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Search the text of notes (the same box syntax as drafts' words, without filters).
    pub fn search_notes(&self, text: &str, limit: usize) -> Result<Vec<NoteSummary>> {
        let Some(q) = fts_words(text) else { return Ok(Vec::new()) };
        let mut stmt = self.conn.prepare_cached(
            "SELECT n.id, n.path, n.folder, n.title, n.preview, n.tags, n.pinned, n.modified_at \
             FROM notes_fts f JOIN notes n ON n.id = f.rowid WHERE notes_fts MATCH ?1 \
             ORDER BY n.modified_at DESC LIMIT ?2",
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

    /// The folders that hold notes, and the folders above them, in tree order.
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
        while abs(&root, &join_rel(&folder, &name)).exists()
            || self.id_of(&join_rel(&folder, &name))?.is_some()
        {
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

    fn conflict_copy(&self, root: &Path, row: &Row, text: &str) -> Result<String> {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H%M");
        let base = format!("{} (conflict {stamp})", row.title);
        let mut name = base.clone();
        let mut n = 2;
        while abs(root, &join_rel(&row.folder, &name)).exists() {
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
        self.conn.execute(
            "INSERT INTO note_versions (note_id, content, reason, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, text, reason, self.now()],
        )?;
        self.conn.execute(
            "DELETE FROM note_versions WHERE note_id = ?1 AND id NOT IN \
             (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2)",
            params![id, NOTE_VERSIONS_KEPT],
        )?;
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
            if !same_file && (abs(&root, &to).exists() || self.id_of(&to)?.is_some()) {
                bail!("there is already a note called “{new_title}” in that folder");
            }
            rename_with_retry(&abs(&root, &row.path), &abs(&root, &to))?;
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
        while abs(&root, &join_rel(&new_folder, &name)).exists()
            || self.id_of(&join_rel(&new_folder, &name))?.is_some()
        {
            name = format!("{wanted} {n}");
            n += 1;
        }
        let to = join_rel(&new_folder, &name);
        let target = abs(&root, &to);
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        rename_with_retry(&abs(&root, &row.path), &target)?;
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

    // ---- days --------------------------------------------------------------------------------------------------

    /// The page for a day (`YYYY-MM-DD`), if it has one. A day without one has no file: the page is made when
    /// something is written on it.
    pub fn day_note(&self, date: &str) -> Result<Option<Note>> {
        let date = check_day(date)?;
        match self.id_of(&join_rel(JOURNAL_DIR, &date))? {
            Some(id) => Ok(Some(self.peek_note(id)?)),
            None => Ok(None),
        }
    }

    /// Adds a capture to the end of a day's page under the time (`21:14 text`), making the page if the day has
    /// none, and moves the capture to the trash. One undo takes back all of it.
    pub fn file_into_day(&mut self, from_id: i64, date: &str) -> Result<NoteChange> {
        let date = check_day(date)?;
        let mut steps = Vec::new();
        let into = match self.id_of(&join_rel(JOURNAL_DIR, &date))? {
            Some(id) => id,
            None => {
                let n = self.create_note(JOURNAL_DIR, &date, "", &[])?;
                steps.push(UndoStep::FileCreated { path: n.path.clone() });
                n.id
            }
        };
        let time = chrono::Local::now().format("%H:%M").to_string();
        self.merge_with(from_id, into, steps, |body| day_entry(&time, body))
    }

    /// Notes changed between two moments (ms), newest first, with their text: what "the week" reads.
    pub fn notes_between(&self, from: i64, to: i64) -> Result<Vec<Note>> {
        let ids: Vec<i64> = self
            .conn
            .prepare_cached(
                "SELECT id FROM notes WHERE modified_at >= ?1 AND modified_at < ?2 \
                 ORDER BY modified_at DESC LIMIT ?3",
            )?
            .query_map(params![from, to, BETWEEN_MAX as i64], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(ids.into_iter().filter_map(|id| self.peek_note(id).ok()).collect())
    }

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
    fn carry_attachments(
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

    // ---- collections' looks ------------------------------------------------------------------------------------

    /// Each top folder's look (colour and mark), from its `.petrel` file. Folders without one are left out.
    pub fn topic_faces(&self) -> Result<HashMap<String, TopicFace>> {
        let root = self.root()?;
        let mut out = HashMap::new();
        let Ok(entries) = std::fs::read_dir(&root) else { return Ok(out) };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !e.path().is_dir() {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(e.path().join(FACE_FILE)) {
                let f = parse_face(&text);
                if f.color.is_some() || f.mark.is_some() {
                    out.insert(
                        name,
                        TopicFace { color: f.color.unwrap_or_default(), mark: f.mark.unwrap_or_default() },
                    );
                }
            }
        }
        Ok(out)
    }

    /// Sets a top folder's colour and mark (empty: the default). Lines in `.petrel` Petrel does not know are kept.
    pub fn set_topic_face(&mut self, top: &str, color: &str, mark: &str) -> Result<TopicFace> {
        let root = self.root()?;
        let top = clean_folder(top);
        if top.is_empty() || top.contains('/') || top == INBOX_DIR {
            bail!("only a collection (a top folder) has a look of its own");
        }
        let (color, mark) = (face_word(color)?, face_word(mark)?);
        let dir = abs(&root, &top);
        if !dir.is_dir() {
            bail!("there is no folder called {top}");
        }
        let path = dir.join(FACE_FILE);
        let old = std::fs::read_to_string(&path).unwrap_or_default();
        let mut lines: Vec<String> = old
            .lines()
            .filter(|l| !matches!(l.split_once(':').map(|(k, _)| k.trim()), Some("color" | "mark")))
            .map(str::to_string)
            .collect();
        if lines.is_empty() {
            lines.push("# Petrel: how this collection looks in the library.".into());
        }
        if !color.is_empty() {
            lines.push(format!("color: {color}"));
        }
        if !mark.is_empty() {
            lines.push(format!("mark: {mark}"));
        }
        write_atomic(&path, &(lines.join("\n") + "\n"))?;
        Ok(TopicFace { color, mark })
    }

    /// A note's saved versions, newest first (the history panel).
    pub fn note_versions(&self, id: i64) -> Result<Vec<NoteVersion>> {
        let mut st = self.conn.prepare(
            "SELECT id, reason, created_at, length(content) FROM note_versions WHERE note_id = ?1 \
             ORDER BY created_at DESC, id DESC",
        )?;
        let rows = st.query_map(params![id], |r| {
            Ok(NoteVersion { id: r.get(0)?, reason: r.get(1)?, created_at: r.get(2)?, length: r.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// A version's body, without its front matter.
    pub fn note_version_text(&self, version_id: i64) -> Result<String> {
        let text: String = self
            .conn
            .query_row("SELECT content FROM note_versions WHERE id = ?1", params![version_id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| anyhow!("no version {version_id}"))?;
        Ok(split_front(&text).1.to_string())
    }

    /// Keeps the file as it is now as a version, whatever the interval: before an AI rewrite or a restore.
    pub fn snapshot_note(&mut self, id: i64, reason: &str) -> Result<()> {
        let root = self.root()?;
        let row = self.row(id)?;
        let path = abs(&root, &row.path);
        let disk = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        self.note_version(id, &disk, reason)
    }

    /// Puts a version's body back, keeping today's front matter. The current text is kept first.
    pub fn restore_note_version(&mut self, id: i64, version_id: i64) -> Result<Note> {
        let owner: Option<i64> = self
            .conn
            .query_row("SELECT note_id FROM note_versions WHERE id = ?1", params![version_id], |r| r.get(0))
            .optional()?;
        if owner != Some(id) {
            bail!("that version is not one of this note's");
        }
        let body = self.note_version_text(version_id)?;
        self.snapshot_note(id, "restore")?;
        let root = self.root()?;
        let row = self.row(id)?;
        let path = abs(&root, &row.path);
        let disk = std::fs::read_to_string(&path).unwrap_or_default();
        let front = split_front(&disk).0.to_string();
        write_atomic(&path, &format!("{front}{body}"))?;
        self.index_file(&root, &row.path)?;
        self.note(id)
    }

    /// Counts a copy, so a collection can list what is used most first. Kept by path in settings: the index
    /// is rebuildable and a count is not worth a migration.
    pub fn record_copy(&mut self, id: i64) -> Result<i64> {
        let row = self.row(id)?;
        let key = format!("{COPY_PREFIX}{}", row.path);
        let n = self.setting(&key)?.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0) + 1;
        self.set_setting(&key, &n.to_string())?;
        Ok(n)
    }

    /// How often each note was copied, by path.
    pub fn copy_counts(&self) -> Result<std::collections::HashMap<String, i64>> {
        Ok(self
            .settings_with_prefix(COPY_PREFIX)?
            .into_iter()
            .filter_map(|(k, v)| Some((k.strip_prefix(COPY_PREFIX)?.to_string(), v.parse().ok()?)))
            .collect())
    }

    /// Rewrites links found by searching for `words`, in notes and drafts (Trash included: a link there may
    /// come back). `map` gives the new target for a link that should change.
    fn relink(
        &mut self,
        words: &str,
        steps: &mut Vec<UndoStep>,
        map: impl Fn(&Target) -> Option<Target>,
    ) -> Result<usize> {
        let root = self.root()?;
        let mut changed = 0;
        for t in self.texts_with(words, REWRITE_MAX, true)? {
            let (new, n) =
                links::rewrite(&t.text, |l| map(&l.target).map(|target| Link { target, ..l.clone() }.raw()));
            if n == 0 {
                continue;
            }
            changed += 1;
            if t.kind == "note" {
                let row = self.row(t.id)?;
                let path = abs(&root, &row.path);
                let before = std::fs::read_to_string(&path)?;
                let (front, body) = split_front(&before);
                let (body_new, _) =
                    links::rewrite(body, |l| map(&l.target).map(|target| Link { target, ..l.clone() }.raw()));
                let after = format!("{front}{body_new}");
                if after == before {
                    continue;
                }
                self.note_version(t.id, &before, "before_relink")?;
                write_atomic(&path, &after)?;
                self.index_file(&root, &row.path)?;
                steps.push(UndoStep::NoteText { path: row.path, before, after });
            } else {
                self.snapshot(t.id, "before_relink", self.now())?;
                self.set_draft_text(t.id, &new)?;
                steps.push(UndoStep::DraftText { id: t.id, before: t.text, after: new });
            }
        }
        Ok(changed)
    }

    fn set_draft_text(&self, id: i64, text: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE drafts SET content = ?2, title = ?3, preview = ?4, modified_at = ?5 \
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id, text, title::title(text), title::preview(text), self.now()],
        )?;
        Ok(())
    }

    /// Notes and drafts whose text holds the words of `words` (by full-text search), newest first.
    fn texts_with(&self, words: &str, limit: usize, with_trash: bool) -> Result<Vec<Text>> {
        let mut out = Vec::new();
        let Some(q) = phrase(words) else { return Ok(out) };
        let mut notes = self.conn.prepare_cached(
            "SELECT n.id, n.title, n.content FROM notes_fts f JOIN notes n ON n.id = f.rowid \
             WHERE notes_fts MATCH ?1 ORDER BY n.modified_at DESC LIMIT ?2",
        )?;
        for r in notes.query_map(params![q, limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))? {
            let (id, title, content): (i64, String, String) = r?;
            out.push(Text { kind: "note", id, title, text: split_front(&content).1.to_string() });
        }
        let mut drafts = self.conn.prepare_cached(
            "SELECT d.id, d.title, d.content FROM drafts_fts f JOIN drafts d ON d.id = f.rowid \
             WHERE drafts_fts MATCH ?1 AND d.deleted_at IS NULL AND (?3 OR d.folder != 2) \
             ORDER BY d.modified_at DESC LIMIT ?2",
        )?;
        for r in drafts
            .query_map(params![q, limit as i64, with_trash], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        {
            let (id, title, text): (i64, String, String) = r?;
            out.push(Text { kind: "draft", id, title, text });
        }
        Ok(out)
    }

    fn note_titled(&self, title: &str) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id FROM notes WHERE title = ?1 COLLATE NOCASE ORDER BY accessed_at DESC LIMIT 1",
                params![title.trim()],
                |r| r.get(0),
            )
            .optional()?)
    }

    fn draft_titled(&self, title: &str) -> Result<Option<i64>> {
        let Some(q) = phrase(title) else { return Ok(None) };
        let mut stmt = self.conn.prepare_cached(
            "SELECT d.id, d.title FROM drafts_fts f JOIN drafts d ON d.id = f.rowid \
             WHERE drafts_fts MATCH ?1 AND d.deleted_at IS NULL ORDER BY d.folder = 2, d.modified_at DESC LIMIT 200",
        )?;
        let rows = stmt.query_map(params![format!("title : {q}")], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for r in rows {
            let (id, t) = r?;
            if same(&t, title) {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    // ---- drafts into notes -------------------------------------------------------------------------------------

    /// Turns a draft into a new note: the text goes to a file (without its first line when that line is the
    /// title), the draft goes to the Archive with its text untouched, and links to the draft now go to the note.
    pub fn promote_draft(
        &mut self,
        draft_id: i64,
        folder: &str,
        title: &str,
        keep_tags: bool,
    ) -> Result<NoteChange> {
        let d = self.peek(draft_id)?;
        let wanted = if title.trim().is_empty() { d.title.clone() } else { title.to_string() };
        let body = without_title_line(&d.content, &wanted);
        let tags = if keep_tags { d.tags.clone() } else { Vec::new() };
        // An unqualified `[[Title]]` meant the draft only while no note had that title.
        let had_note = self.note_titled(&d.title)?.is_some();
        let note = self.create_note(folder, &wanted, &body, &tags)?;
        let mut steps = vec![UndoStep::FileCreated { path: note.path.clone() }];
        self.finish_promotion(&d, &note, "promote", had_note, &mut steps)
    }

    /// Adds a draft's text to the end of a note, under a rule and the date and time.
    pub fn append_to_note(&mut self, draft_id: i64, note_id: i64, keep_tags: bool) -> Result<NoteChange> {
        let root = self.root()?;
        let d = self.peek(draft_id)?;
        let row = self.row(note_id)?;
        let path = abs(&root, &row.path);
        let before = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        let (raw, body) = split_front(&before);
        let mut front = parse_front(raw);
        let mut front_text = raw.to_string();
        if keep_tags {
            let mut tags = front.tags.clone();
            for t in &d.tags {
                if !tags.iter().any(|x| same(x, t)) {
                    tags.push(t.clone());
                }
            }
            if tags != front.tags {
                front.tags = tags;
                front_text = render_front(&front);
            }
        }
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M");
        let body = body.trim_end();
        let glue = if body.is_empty() { String::new() } else { format!("{body}\n\n---\n\n") };
        let after = format!("{front_text}{glue}_{stamp}_\n\n{}\n", d.content.trim_end());
        self.note_version(note_id, &before, "before_append")?;
        write_atomic(&path, &after)?;
        self.index_file(&root, &row.path)?;
        let had_note = self.note_titled(&d.title)?.is_some_and(|id| id != note_id);
        let mut steps = vec![UndoStep::NoteText { path: row.path.clone(), before, after }];
        let note = self.peek_note(note_id)?;
        self.finish_promotion(&d, &note, "append", had_note, &mut steps)
    }

    fn finish_promotion(
        &mut self,
        d: &crate::store::Draft,
        note: &Note,
        kind: &str,
        had_note: bool,
        steps: &mut Vec<UndoStep>,
    ) -> Result<NoteChange> {
        let previous: Option<(String, String, i64)> = self
            .conn
            .query_row("SELECT note_path, kind, at FROM promotions WHERE draft_id = ?1", params![d.id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        self.conn.execute(
            "INSERT INTO promotions (draft_id, note_path, kind, at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT (draft_id) DO UPDATE SET note_path = excluded.note_path, kind = excluded.kind, at = excluded.at",
            params![d.id, note.path, kind, self.now()],
        )?;
        steps.push(UndoStep::Promotion { draft_id: d.id, previous });
        let moved = self.move_drafts(&[d.id], Folder::Archive)?;
        if moved.count > 0 {
            steps.push(UndoStep::DraftBatch { token: moved.token });
        }
        // Qualified when another note has the same title, so the link can't land on the wrong one.
        let qualify = self
            .conn
            .query_row(
                "SELECT COUNT(*) > 1 FROM notes WHERE title = ?1 COLLATE NOCASE",
                params![note.title],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false);
        let target = Target::Note {
            folder: Some(note.folder.clone()).filter(|f| qualify && !f.is_empty()),
            title: note.title.clone(),
        };
        let (dtitle, uuid) = (d.title.clone(), d.uuid.clone());
        let mut relinked = 0;
        if !dtitle.is_empty() {
            relinked += self.relink(&dtitle, steps, |t| match t {
                Target::Draft { title } if same(title, &dtitle) => Some(target.clone()),
                Target::Note { folder: None, title }
                    if !had_note && same(title, &dtitle) && !same(title, &note.title) =>
                {
                    Some(target.clone())
                }
                _ => None,
            })?;
        }
        relinked += self.relink(&uuid, steps, |t| match t {
            Target::Uuid(u) if u.eq_ignore_ascii_case(&uuid) => Some(target.clone()),
            _ => None,
        })?;
        let token = self.remember_notes(std::mem::take(steps));
        Ok(NoteChange { note: self.peek_note(note.id)?, token, relinked })
    }

    /// The note a draft became, for the banner on an archived draft.
    pub fn promotion(&self, draft_id: i64) -> Result<Option<Promotion>> {
        let row: Option<(String, String, i64)> = self
            .conn
            .query_row(
                "SELECT note_path, kind, at FROM promotions WHERE draft_id = ?1",
                params![draft_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((note_path, kind, at)) = row else { return Ok(None) };
        let note_id = self.id_of(&note_path)?;
        let file = note_path.rsplit('/').next().unwrap_or(&note_path);
        let note_title = file.strip_suffix(".md").unwrap_or(file).to_string();
        Ok(Some(Promotion { note_path, note_title, note_id, kind, at }))
    }

    // ---- links -------------------------------------------------------------------------------------------------

    /// The `[[` list: notes whose title holds `text` (starting with it first), then drafts whose title starts
    /// with its words. Empty `text`: the most recently opened notes and drafts.
    pub fn link_targets(&self, text: &str, limit: usize) -> Result<Vec<LinkTarget>> {
        let mut out: Vec<LinkTarget> = self
            .find_notes(text, limit)?
            .into_iter()
            .map(|n| LinkTarget {
                kind: "note".into(),
                id: n.id,
                title: n.title,
                folder: n.folder,
                uuid: None,
                modified_at: n.modified_at,
            })
            .collect();
        let draft_rows = |r: &rusqlite::Row| -> rusqlite::Result<LinkTarget> {
            let folder: i64 = r.get(3)?;
            Ok(LinkTarget {
                kind: "draft".into(),
                id: r.get(0)?,
                uuid: Some(r.get(1)?),
                title: r.get(2)?,
                folder: if folder == 1 { "archive".into() } else { "inbox".into() },
                modified_at: r.get(4)?,
            })
        };
        let drafts: Vec<LinkTarget> = match title_prefix(text) {
            Some(q) => self
                .conn
                .prepare_cached(
                    "SELECT d.id, d.uuid, d.title, d.folder, d.modified_at FROM drafts_fts f \
                     JOIN drafts d ON d.id = f.rowid WHERE drafts_fts MATCH ?1 AND d.deleted_at IS NULL \
                     AND d.folder != 2 AND d.title != '' ORDER BY d.modified_at DESC LIMIT ?2",
                )?
                .query_map(params![q, limit as i64], draft_rows)?
                .collect::<rusqlite::Result<_>>()?,
            None => self
                .conn
                .prepare_cached(
                    "SELECT id, uuid, title, folder, modified_at FROM drafts INDEXED BY drafts_list \
                     WHERE folder = 0 AND deleted_at IS NULL AND title != '' \
                     ORDER BY modified_at DESC, id DESC LIMIT ?1",
                )?
                .query_map(params![limit as i64], draft_rows)?
                .collect::<rusqlite::Result<_>>()?,
        };
        out.extend(drafts);
        Ok(out)
    }

    /// Where the text inside `[[…]]` goes.
    pub fn resolve_link(&self, inner: &str) -> Result<Resolved> {
        let Some((target, _, _)) = links::parse_inner(inner) else {
            bail!("“{inner}” is not a link");
        };
        Ok(match target {
            Target::Note { folder: Some(folder), title } => {
                let rel = join_rel(&clean_folder(&folder), &clean_title(&title));
                let id: Option<i64> = self
                    .conn
                    .query_row("SELECT id FROM notes WHERE path = ?1 COLLATE NOCASE", params![rel], |r| {
                        r.get(0)
                    })
                    .optional()?;
                match id {
                    Some(id) => Resolved::Note { id },
                    None => match self.note_titled(&title)? {
                        // The folder moved, the title did not: still the note people mean.
                        Some(id) => Resolved::Note { id },
                        None => Resolved::Missing { title, folder: Some(folder), draft: false },
                    },
                }
            }
            Target::Note { folder: None, title } => match self.note_titled(&title)? {
                Some(id) => Resolved::Note { id },
                None => match self.draft_titled(&title)? {
                    Some(id) => Resolved::Draft { id },
                    None => Resolved::Missing { title, folder: None, draft: false },
                },
            },
            Target::Draft { title } => match self.draft_titled(&title)? {
                Some(id) => Resolved::Draft { id },
                None => Resolved::Missing { title, folder: None, draft: true },
            },
            Target::Uuid(u) => match self.find_by_uuid(&u)? {
                Some(id) => Resolved::Draft { id },
                None => Resolved::Missing { title: u, folder: None, draft: true },
            },
        })
    }

    /// Notes and drafts that link to this note, and those that name it without a link.
    pub fn backlinks(&self, note_id: i64) -> Result<Backlinks> {
        let row = self.row(note_id)?;
        let mut out = Backlinks::default();
        for t in self.texts_with(&row.title, 500, false)? {
            if t.kind == "note" && t.id == note_id {
                continue;
            }
            let found = links::parse(&t.text);
            if let Some(l) = found.iter().find(|l| note_matches(&l.target, &row.folder, &row.title)) {
                if out.linked.len() < BACKLINKS_MAX {
                    out.linked.push(BackRef {
                        kind: t.kind.into(),
                        id: t.id,
                        title: t.title,
                        line: line_at(&t.text, l.start),
                    });
                }
                continue;
            }
            if let Some(at) = find_mention(&t.text, &found, &row.title) {
                if out.mentioned.len() < BACKLINKS_MAX {
                    out.mentioned.push(BackRef {
                        kind: t.kind.into(),
                        id: t.id,
                        title: t.title,
                        line: line_at(&t.text, at),
                    });
                }
            }
        }
        Ok(out)
    }

    /// "Link it": turns the first plain mention of the note's title in a draft or note into a link.
    pub fn link_mention(&mut self, note_id: i64, kind: &str, id: i64) -> Result<UndoToken> {
        let title = self.row(note_id)?.title;
        let mut steps = Vec::new();
        let edit = |text: &str| -> Option<String> {
            let found = links::parse(text);
            let at = find_mention(text, &found, &title)?;
            let written = &text[at..at + title.len().min(text.len() - at)];
            let link =
                if written == title { format!("[[{title}]]") } else { format!("[[{title}|{written}]]") };
            Some(format!("{}{link}{}", &text[..at], &text[at + written.len()..]))
        };
        if kind == "note" {
            let root = self.root()?;
            let row = self.row(id)?;
            let path = abs(&root, &row.path);
            let before = std::fs::read_to_string(&path)?;
            let (front, body) = split_front(&before);
            let Some(new_body) = edit(body) else { bail!("“{title}” is no longer mentioned there") };
            let after = format!("{front}{new_body}");
            self.note_version(id, &before, "before_link")?;
            write_atomic(&path, &after)?;
            self.index_file(&root, &row.path)?;
            steps.push(UndoStep::NoteText { path: row.path, before, after });
        } else {
            let d = self.peek(id)?;
            let Some(after) = edit(&d.content) else { bail!("“{title}” is no longer mentioned there") };
            self.snapshot(id, "before_link", self.now())?;
            self.set_draft_text(id, &after)?;
            steps.push(UndoStep::DraftText { id, before: d.content, after });
        }
        Ok(self.remember_notes(steps))
    }

    // ---- undo --------------------------------------------------------------------------------------------------

    fn remember_notes(&mut self, steps: Vec<UndoStep>) -> UndoToken {
        let count = steps.len();
        let token = format!("{TOKEN_PREFIX}{}", uuid::Uuid::new_v4());
        self.notes_undo.push_back(NotesUndo { token: token.clone(), steps });
        while self.notes_undo.len() > 50 {
            self.notes_undo.pop_front();
        }
        UndoToken { token, count }
    }

    /// Puts a notes change back, last step first. A step whose file or text changed since is skipped, never
    /// forced: what was typed after the change stays.
    pub(crate) fn undo_notes(&mut self, token: &str) -> Result<usize> {
        let Some(pos) = self.notes_undo.iter().position(|u| u.token == token) else {
            bail!("nothing to undo: that change is too old or was already undone");
        };
        let batch = self.notes_undo.remove(pos).expect("in range");
        let root = self.root()?;
        let mut n = 0;
        for step in batch.steps.into_iter().rev() {
            match step {
                UndoStep::FileCreated { path } => {
                    if abs(&root, &path).exists() {
                        self.move_to_trash(&root, &path)?;
                        n += 1;
                    }
                }
                UndoStep::FileRenamed { from, to } => {
                    let (f, t) = (abs(&root, &from), abs(&root, &to));
                    let case_only = from.to_lowercase() == to.to_lowercase();
                    if t.exists() && (case_only || !f.exists()) {
                        rename_with_retry(&t, &f)?;
                        let (folder, file) = from.rsplit_once('/').unwrap_or(("", &from));
                        let title = file.strip_suffix(".md").unwrap_or(file);
                        self.conn.execute(
                            "UPDATE notes SET path = ?2, folder = ?3, title = ?4 WHERE path = ?1",
                            params![to, from, folder, title],
                        )?;
                        self.index_file(&root, &from)?;
                        n += 1;
                    }
                }
                UndoStep::FileTrashed { path, trashed } => {
                    let back = abs(&root, &path);
                    if trashed.exists() && !back.exists() {
                        if let Some(dir) = back.parent() {
                            std::fs::create_dir_all(dir)?;
                        }
                        rename_with_retry(&trashed, &back)?;
                        self.index_file(&root, &path)?;
                        n += 1;
                    }
                }
                UndoStep::FileMoved { from, to } => {
                    let (f, t) = (abs(&root, &from), abs(&root, &to));
                    if t.exists() && !f.exists() {
                        rename_with_retry(&t, &f)?;
                        n += 1;
                    }
                }
                UndoStep::NoteText { path, before, after } => {
                    let p = abs(&root, &path);
                    if std::fs::read_to_string(&p).ok().as_deref() == Some(after.as_str()) {
                        write_atomic(&p, &before)?;
                        self.index_file(&root, &path)?;
                        n += 1;
                    }
                }
                UndoStep::DraftText { id, before, after } => {
                    let current: Option<String> = self
                        .conn
                        .query_row(
                            "SELECT content FROM drafts WHERE id = ?1 AND deleted_at IS NULL",
                            params![id],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if current.as_deref() == Some(after.as_str()) {
                        self.set_draft_text(id, &before)?;
                        n += 1;
                    }
                }
                UndoStep::DraftBatch { token } => n += self.undo(&token).unwrap_or(0),
                UndoStep::Promotion { draft_id, previous } => {
                    match previous {
                        Some((p, k, at)) => self.conn.execute(
                            "UPDATE promotions SET note_path = ?2, kind = ?3, at = ?4 WHERE draft_id = ?1",
                            params![draft_id, p, k, at],
                        )?,
                        None => self
                            .conn
                            .execute("DELETE FROM promotions WHERE draft_id = ?1", params![draft_id])?,
                    };
                }
            }
        }
        Ok(n)
    }
}

/// A day as `YYYY-MM-DD`, refused when it is not a real date (the page's file name comes from it).
fn check_day(date: &str) -> Result<String> {
    let d = chrono::NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
        .map_err(|_| anyhow!("{date} is not a day (YYYY-MM-DD)"))?;
    Ok(d.format("%Y-%m-%d").to_string())
}

/// One entry on a day's page: the time, then the text. A quote, a list or a heading keeps its own line.
fn day_entry(time: &str, body: &str) -> String {
    let body = body.trim();
    let block = body.starts_with(['>', '-', '*', '#', '!', '|', '`']) || body.starts_with("1.");
    if block {
        format!("{time}\n{body}\n")
    } else {
        format!("{time} {body}\n")
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
}

#[derive(Default)]
struct FaceLines {
    color: Option<String>,
    mark: Option<String>,
}

/// A colour or mark name: lower-case letters and `-`, short. Anything else is not one Petrel drew.
fn face_word(s: &str) -> Result<String> {
    let s = s.trim().to_lowercase();
    if s.len() > 24 || !s.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
        bail!("{s} is not a colour or mark Petrel knows");
    }
    Ok(s)
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
const STOP: &[&str] = &[
    "the", "and", "for", "are", "was", "what", "when", "where", "which", "who", "how", "why", "with", "that",
    "this", "have", "has", "had", "did", "does", "you", "your", "about", "from", "there", "their", "can",
    "could", "would", "should", "will", "into", "any", "all", "but", "not", "notes", "note", "my",
];

/// Each word as a prefix, all required: what a person typing in a search box means.
fn fts_words(text: &str) -> Option<String> {
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{w}\"*"))
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
mod tests {
    use super::*;

    fn store_in(dir: &Path) -> Store {
        let mut s = Store::open_in_memory().unwrap();
        s.set_notes_root(dir).unwrap();
        s
    }

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("petrel-notes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn capture_file_and_merge() {
        let dir = tmp();
        let mut s = store_in(&dir);
        let c = s.capture_note("Ask about the release date\n").unwrap();
        assert_eq!(c.folder, INBOX_DIR);
        assert!(dir.join(&c.path).exists());
        let target = s.create_note("work", "Tern release", "Open questions\n", &[]).unwrap();
        // Linked from elsewhere: the link follows a move.
        let other = s.create_note("", "Week", "See [[Plan]]\n", &[]).unwrap();
        let plan = s.create_note(INBOX_DIR, "Plan", "steps\n", &[]).unwrap();
        let moved = s.move_note(plan.id, "ideas", "Plan").unwrap();
        assert_eq!(moved.note.path, "ideas/Plan.md");
        assert!(dir.join("ideas/Plan.md").exists() && !dir.join("inbox/Plan.md").exists());
        assert!(s.peek_note(other.id).unwrap().body.contains("[[Plan]]"));
        s.undo_notes(&moved.token.token).unwrap();
        assert!(dir.join("inbox/Plan.md").exists());

        let merged = s.merge_note(c.id, target.id).unwrap();
        let body = s.peek_note(target.id).unwrap().body;
        assert!(body.starts_with("Open questions") && body.contains("Ask about the release date"), "{body}");
        assert!(!dir.join(&c.path).exists());
        assert!(s.merge_note(target.id, target.id).is_err());
        s.undo_notes(&merged.token.token).unwrap();
        assert!(dir.join(&c.path).exists());
        assert_eq!(s.peek_note(target.id).unwrap().body, "Open questions\n");
    }

    #[test]
    fn versions_restore_copies_and_asking() {
        let dir = tmp();
        let mut s = store_in(&dir);
        let n = s
            .create_note("Prompts", "Review", "Review this code for {{lang}} bugs\n", &["ai".into()])
            .unwrap();
        s.snapshot_note(n.id, "ai").unwrap();
        let saved = s.save_note(n.id, "Shorter\n", &n.hash).unwrap();
        assert!(saved.conflict.is_none());
        let versions = s.note_versions(n.id).unwrap();
        assert_eq!(versions[0].reason, "ai");
        assert!(s.note_version_text(versions[0].id).unwrap().starts_with("Review this code"));
        let back = s.restore_note_version(n.id, versions[0].id).unwrap();
        assert!(back.body.starts_with("Review this code") && back.tags == vec!["ai".to_string()]);
        let other = s.create_note("", "Other", "x\n", &[]).unwrap();
        assert!(s.restore_note_version(other.id, versions[0].id).is_err());

        assert_eq!(s.record_copy(n.id).unwrap(), 1);
        assert_eq!(s.record_copy(n.id).unwrap(), 2);
        assert_eq!(s.copy_counts().unwrap().get("Prompts/Review.md"), Some(&2));

        s.create_note("", "Garden", "Tomatoes need sun and water\n", &[]).unwrap();
        let found = s.notes_about("What do my tomatoes need?", 5).unwrap();
        assert_eq!(found[0].title, "Garden");
        assert!(s.notes_about("what is the", 5).unwrap().is_empty());
    }

    #[test]
    fn previews_keep_lines_and_drop_marks() {
        assert_eq!(
            body_preview("# Plan\n\n- [ ] milk\n- [x] eggs\n- bread\n"),
            "Plan\n☐ milk\n☑ eggs\n• bread"
        );
        let long = "word ".repeat(100);
        assert!(body_preview(&long).chars().count() <= PREVIEW_CHARS);
        assert_eq!(body_preview("1\n2\n3\n4\n5\n6\n7\n8"), "1\n2\n3\n4\n5\n6");
    }

    #[test]
    fn drafts_are_exported_once() {
        let dir = tmp();
        let mut s = store_in(&dir);
        s.new_draft("Shopping\nmilk").unwrap();
        let kept = s.new_draft("Book idea\nThe lighthouse").unwrap();
        s.move_drafts(&[kept.id], Folder::Archive).unwrap();
        s.new_draft("   ").unwrap();
        assert_eq!(s.export_drafts_once().unwrap(), 2);
        assert_eq!(s.export_drafts_once().unwrap(), 0);
        assert!(dir.join("drafts/Book idea.md").exists());
        let inbox =
            s.list_notes(&NoteQuery { folder: Some(INBOX_DIR.into()), ..Default::default() }).unwrap();
        assert_eq!(inbox.len(), 1);
        assert!(s.peek_note(inbox[0].id).unwrap().body.contains("milk"));
    }

    #[test]
    fn front_matter_round_trip() {
        let t = "---\ntitle: kept\ntags: [a, \"b\"]\npinned: true\n---\nBody\n";
        let (raw, body) = split_front(t);
        assert_eq!(body, "Body\n");
        let f = parse_front(raw);
        assert_eq!(f.tags, vec!["a", "b"]);
        assert!(f.pinned);
        assert_eq!(f.other, vec!["title: kept"]);
        assert_eq!(render_front(&f), "---\ntitle: kept\ntags: [a, b]\npinned: true\n---\n");
        let list = parse_front("---\ntags:\n  - x\n  - '#y'\n---\n");
        assert_eq!(list.tags, vec!["x", "y"]);
        assert_eq!(split_front("--- not front\n"), ("", "--- not front\n"));
        assert_eq!(split_front("---\nnever closed\n").0, "");
    }

    #[test]
    fn titles_are_file_names() {
        assert_eq!(clean_title("  a/b: c?  "), "a-b- c-");
        assert_eq!(clean_title("..hidden."), "hidden");
        assert_eq!(clean_folder("../Projects//Petrel/.git"), "Projects/Petrel");
    }

    #[test]
    fn create_scan_save_and_conflict() {
        let dir = tmp();
        let mut s = store_in(&dir);
        let n = s.create_note("Projects/Petrel", "Roadmap", "M1 then M2.\n", &["petrel".into()]).unwrap();
        assert_eq!(n.path, "Projects/Petrel/Roadmap.md");
        let on_disk = std::fs::read_to_string(dir.join("Projects/Petrel/Roadmap.md")).unwrap();
        assert_eq!(on_disk, "---\ntags: [petrel]\n---\nM1 then M2.\n");
        let again = s.create_note("Projects/Petrel", "Roadmap", "", &[]).unwrap();
        assert_eq!(again.title, "Roadmap 2");

        let saved = s.save_note(n.id, "M1, M2, M3.\n", &n.hash).unwrap();
        assert!(saved.conflict.is_none());
        assert_eq!(s.note(n.id).unwrap().body, "M1, M2, M3.\n");
        // Changed in another editor while open in Petrel: both texts are kept.
        std::fs::write(dir.join("Projects/Petrel/Roadmap.md"), "---\ntags: [petrel, x]\n---\nTheirs\n")
            .unwrap();
        let saved = s.save_note(n.id, "Mine\n", &saved.hash).unwrap();
        let copy = saved.conflict.expect("a conflict copy");
        assert!(std::fs::read_to_string(dir.join(&copy)).unwrap().contains("Theirs"));
        let mine = std::fs::read_to_string(dir.join("Projects/Petrel/Roadmap.md")).unwrap();
        assert_eq!(mine, "---\ntags: [petrel, x]\n---\nMine\n", "their front matter, my body");

        std::fs::write(dir.join("Loose.md"), "Dropped in by hand").unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join(".hidden/No.md"), "x").unwrap();
        std::fs::write(dir.join("bin.md"), [0xff, 0xfe, 0x00]).unwrap();
        let r = s.scan_notes().unwrap();
        assert_eq!((r.added, r.skipped), (1, 1));
        assert_eq!(s.find_notes("loose", 5).unwrap()[0].title, "Loose");
        std::fs::remove_file(dir.join("Loose.md")).unwrap();
        assert_eq!(s.scan_notes().unwrap().removed, 1);
        let folders: Vec<String> = s.note_folders().unwrap().into_iter().map(|f| f.path).collect();
        assert_eq!(folders, vec!["Projects", "Projects/Petrel"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rename_rewrites_links_and_undoes() {
        let dir = tmp();
        let mut s = store_in(&dir);
        let target = s.create_note("", "Omarchy", "Binds.\n", &[]).unwrap();
        let other = s.create_note("", "Laptop", "See [[Omarchy#Binds]] and [[Unrelated]].\n", &[]).unwrap();
        let d = s.new_draft("Wifi\n\nSame machine as [[omarchy]].").unwrap();
        let c = s.rename_note(target.id, "Omarchy setup").unwrap();
        assert_eq!(c.relinked, 2);
        assert!(dir.join("Omarchy setup.md").exists() && !dir.join("Omarchy.md").exists());
        assert_eq!(s.note(other.id).unwrap().body, "See [[Omarchy setup#Binds]] and [[Unrelated]].\n");
        assert!(s.peek(d.id).unwrap().content.ends_with("[[Omarchy setup]]."));
        let back = s.backlinks(target.id).unwrap();
        assert_eq!(back.linked.len(), 2);
        s.undo(&c.token.token).unwrap();
        assert!(dir.join("Omarchy.md").exists());
        assert!(s.peek(d.id).unwrap().content.ends_with("[[omarchy]]."));
        assert_eq!(s.note(other.id).unwrap().body, "See [[Omarchy#Binds]] and [[Unrelated]].\n");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn promote_and_append_keep_the_draft_and_undo() {
        let dir = tmp();
        let mut s = store_in(&dir);
        let d = s.new_draft("# Notes in Petrel\n\nFiles, folders, links.").unwrap();
        s.set_tags(d.id, &["petrel".into()]).unwrap();
        let linker = s.new_draft("Todo\n\nRead [[d:Notes in Petrel]] and [[u:".to_string().as_str()).unwrap();
        s.save(linker.id, &format!("Todo\n\nRead [[d:Notes in Petrel]] and [[u:{}|this]].", d.uuid), 0)
            .unwrap();
        let c = s.promote_draft(d.id, "Projects", "", true).unwrap();
        assert_eq!(c.note.path, "Projects/Notes in Petrel.md");
        assert_eq!(c.note.body, "Files, folders, links.");
        assert_eq!(c.note.tags, vec!["petrel"]);
        let after = s.peek(d.id).unwrap();
        assert_eq!(after.folder, Folder::Archive);
        assert_eq!(after.content, "# Notes in Petrel\n\nFiles, folders, links.", "the draft keeps its text");
        assert_eq!(s.promotion(d.id).unwrap().unwrap().note_id, Some(c.note.id));
        assert_eq!(
            s.peek(linker.id).unwrap().content,
            "Todo\n\nRead [[Notes in Petrel]] and [[Notes in Petrel|this]]."
        );
        assert_eq!(s.resolve_link("Notes in Petrel").unwrap(), Resolved::Note { id: c.note.id });

        s.undo(&c.token.token).unwrap();
        assert_eq!(s.peek(d.id).unwrap().folder, Folder::Inbox);
        assert!(s.promotion(d.id).unwrap().is_none());
        assert!(!dir.join("Projects/Notes in Petrel.md").exists());
        assert!(std::fs::read_dir(dir.join(TRASH_DIR)).unwrap().count() == 1, "undo trashes, never deletes");
        assert!(s.peek(linker.id).unwrap().content.contains("[[d:Notes in Petrel]]"));

        let journal = s.create_note("", "Journal", "Start.\n", &[]).unwrap();
        let entry = s.new_draft("Tried the history panel.").unwrap();
        let c = s.append_to_note(entry.id, journal.id, false).unwrap();
        assert!(c.note.body.starts_with("Start.\n\n---\n\n_"));
        assert!(c.note.body.ends_with("_\n\nTried the history panel.\n"));
        s.undo(&c.token.token).unwrap();
        assert_eq!(s.peek_note(journal.id).unwrap().body, "Start.\n");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn resolve_targets_and_mentions() {
        let dir = tmp();
        let mut s = store_in(&dir);
        let n = s.create_note("Home", "Omarchy setup", "x", &[]).unwrap();
        let d = s.new_draft("Wifi fix\n\nsleep").unwrap();
        s.new_draft("Laptop\n\nI should redo the omarchy setup soon.").unwrap();
        assert_eq!(s.resolve_link("Home/Omarchy setup").unwrap(), Resolved::Note { id: n.id });
        assert_eq!(s.resolve_link("Moved/Omarchy setup").unwrap(), Resolved::Note { id: n.id });
        assert_eq!(s.resolve_link("wifi fix").unwrap(), Resolved::Draft { id: d.id });
        assert_eq!(s.resolve_link("d:Wifi fix").unwrap(), Resolved::Draft { id: d.id });
        assert!(matches!(s.resolve_link("Nope").unwrap(), Resolved::Missing { draft: false, .. }));
        let t = s.link_targets("omar", 5).unwrap();
        assert_eq!(t[0].kind, "note");
        let t = s.link_targets("wif", 5).unwrap();
        assert_eq!((t.len(), t[0].kind.as_str()), (1, "draft"));
        let b = s.backlinks(n.id).unwrap();
        assert_eq!((b.linked.len(), b.mentioned.len()), (0, 1));
        let tok = s.link_mention(n.id, "draft", b.mentioned[0].id).unwrap();
        assert!(s
            .peek(b.mentioned[0].id)
            .unwrap()
            .content
            .contains("the [[Omarchy setup|omarchy setup]] soon"));
        assert_eq!(s.backlinks(n.id).unwrap().linked.len(), 1);
        s.undo(&tok.token).unwrap();
        assert_eq!(s.backlinks(n.id).unwrap().linked.len(), 0);
        let tok = s.trash_note(n.id).unwrap();
        assert!(!dir.join("Home/Omarchy setup.md").exists());
        s.undo(&tok.token).unwrap();
        assert!(dir.join("Home/Omarchy setup.md").exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn captures_go_to_a_day_page() {
        let dir = tmp();
        let mut s = store_in(&dir);
        assert!(s.day_note("2026-11-11").unwrap().is_none());
        assert!(s.day_note("2026-13-40").is_err() && s.day_note("../x").is_err());
        let c = s.capture_note("Lunch with Amra\n").unwrap();
        let ch = s.file_into_day(c.id, "2026-11-11").unwrap();
        assert_eq!(ch.note.path, "journal/2026-11-11.md");
        let body = &ch.note.body;
        assert!(
            body.len() > 6 && body.as_bytes()[2] == b':' && body.trim_end().ends_with("Lunch with Amra"),
            "{body}"
        );
        let q = s.capture_note("> a quote\n").unwrap();
        let body = s.file_into_day(q.id, "2026-11-11").unwrap().note.body;
        assert!(body.contains("\n> a quote"), "{body}");
        // One undo for the first: the capture comes back and the page it made goes.
        let c2 = s.capture_note("again\n").unwrap();
        let other = s.file_into_day(c2.id, "2026-11-12").unwrap();
        s.undo_notes(&other.token.token).unwrap();
        assert!(dir.join(&c2.path).exists() && !dir.join("journal/2026-11-12.md").exists());
        assert_eq!(day_entry("09:05", "- [ ] milk"), "09:05\n- [ ] milk\n");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn pictures_move_with_their_note() {
        let dir = tmp();
        let mut s = store_in(&dir);
        let link = s.save_attachment(INBOX_DIR, "Screen shot.PNG", b"png bytes").unwrap();
        assert_eq!(link, "attachments/Screen-shot.png");
        assert_eq!(s.attachment(INBOX_DIR, &link).unwrap(), b"png bytes");
        assert!(s.attachment(INBOX_DIR, "attachments/../../secret.png").is_err());
        assert!(s.save_attachment(INBOX_DIR, "x.exe", b"MZ").is_err());
        // The scan never takes a picture for a note.
        assert_eq!(s.scan_notes().unwrap().added, 0);

        let c = s.capture_note(&format!("Shelf ![shelf]({link})\n")).unwrap();
        // A picture of the same name already lives in Home: the moved one is renamed and the link follows.
        std::fs::create_dir_all(dir.join("Home/attachments")).unwrap();
        std::fs::write(dir.join("Home/attachments/Screen-shot.png"), b"other").unwrap();
        let moved = s.move_note(c.id, "Home", "Shelf").unwrap();
        assert!(moved.note.body.contains("](attachments/Screen-shot-2.png)"), "{}", moved.note.body);
        assert_eq!(std::fs::read(dir.join("Home/attachments/Screen-shot-2.png")).unwrap(), b"png bytes");
        assert!(!dir.join("inbox/attachments/Screen-shot.png").exists());
        s.undo_notes(&moved.token.token).unwrap();
        assert!(dir.join("inbox/attachments/Screen-shot.png").exists());
        let back = s.peek_note(s.id_of(&c.path).unwrap().unwrap()).unwrap();
        assert!(back.body.contains("](attachments/Screen-shot.png)"), "{}", back.body);

        // Added to a note in another folder: the picture goes there too.
        let into = s.create_note("work", "Plan", "Steps\n", &[]).unwrap();
        let merged = s.merge_note(back.id, into.id).unwrap();
        assert!(merged.note.body.contains("](attachments/Screen-shot.png)"));
        assert!(dir.join("work/attachments/Screen-shot.png").exists());
        s.undo_notes(&merged.token.token).unwrap();
        assert!(
            dir.join("inbox/attachments/Screen-shot.png").exists()
                && !dir.join("work/attachments/Screen-shot.png").exists()
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn collections_have_a_look() {
        let dir = tmp();
        let mut s = store_in(&dir);
        s.create_note("Travel", "Mostar", "", &[]).unwrap();
        assert!(s.topic_faces().unwrap().is_empty());
        std::fs::write(dir.join("Travel").join(FACE_FILE), "keep: me\ncolor: rose\n").unwrap();
        let f = s.set_topic_face("Travel", "teal", "plane").unwrap();
        assert_eq!((f.color.as_str(), f.mark.as_str()), ("teal", "plane"));
        let text = std::fs::read_to_string(dir.join("Travel").join(FACE_FILE)).unwrap();
        assert!(text.contains("keep: me") && !text.contains("rose"), "{text}");
        assert_eq!(s.topic_faces().unwrap()["Travel"], f);
        assert!(s.set_topic_face("inbox", "teal", "").is_err());
        assert!(s.set_topic_face("Travel/Sub", "teal", "").is_err());
        assert!(s.set_topic_face("Travel", "Teal; rm", "").is_err());
        assert!(s.set_topic_face("Nowhere", "teal", "").is_err());
        // The face file is not a note.
        assert_eq!(s.scan_notes().unwrap().added, 0);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn notes_of_a_week() {
        let dir = tmp();
        let mut s = store_in(&dir);
        let a = s.create_note("", "A", "one", &[]).unwrap();
        let all = s.notes_between(0, i64::MAX).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, a.id);
        assert!(s.notes_between(a.modified_at + 1, i64::MAX).unwrap().is_empty());
        std::fs::remove_dir_all(dir).ok();
    }
}
