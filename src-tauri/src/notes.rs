//! The notes commands (docs/design/notes.md). Same shape as `commands.rs`: the store does the work, these
//! translate errors. File reads and writes are small and local, so they run on the command thread like a save.

use std::path::{Path, PathBuf};

use petrel_core::notes::{
    Backlinks, LinkTarget, Note, NoteChange, NoteFolder, NoteQuery, NoteSummary, Resolved, SavedNote,
    ScanReport,
};
use petrel_core::{Store, UndoToken};
use tauri::State;

use crate::AppState;

type R<T> = Result<T, String>;

fn with<T>(state: &State<AppState>, f: impl FnOnce(&mut Store) -> anyhow::Result<T>) -> R<T> {
    let mut store = state.store.lock().map_err(|_| "store lock poisoned".to_string())?;
    f(&mut store).map_err(|e| format!("{e:#}"))
}

/// Where notes go until the person picks a folder: `Documents/Petrel Notes`, or for a debug build `notes/` next to
/// its database, so trying a development build never writes into the real notes.
pub fn default_root(db_path: &Path) -> PathBuf {
    if cfg!(debug_assertions) || std::env::var_os("PETREL_DB").is_some() {
        return db_path.parent().unwrap_or(Path::new(".")).join("notes");
    }
    dirs::document_dir().or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from(".")).join("Petrel Notes")
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesInfo {
    root: String,
}

#[tauri::command]
pub fn notes_info(state: State<AppState>) -> R<NotesInfo> {
    let default = default_root(&state.db_path);
    with(&state, |s| Ok(NotesInfo { root: s.notes_root_or(&default)?.display().to_string() }))
}

#[tauri::command]
pub fn set_notes_root(state: State<AppState>, root: String) -> R<ScanReport> {
    with(&state, |s| s.set_notes_root(Path::new(&root)))
}

#[tauri::command]
pub fn scan_notes(state: State<AppState>) -> R<ScanReport> {
    let default = default_root(&state.db_path);
    with(&state, |s| {
        let root = s.notes_root_or(&default)?;
        if !root.exists() {
            std::fs::create_dir_all(&root)?;
        }
        s.scan_notes()
    })
}

#[tauri::command]
pub fn list_notes(state: State<AppState>, query: NoteQuery) -> R<Vec<NoteSummary>> {
    with(&state, |s| s.list_notes(&query))
}

#[tauri::command]
pub fn find_notes(state: State<AppState>, text: String, limit: usize) -> R<Vec<NoteSummary>> {
    with(&state, |s| s.find_notes(&text, limit.min(200)))
}

#[tauri::command]
pub fn search_notes(state: State<AppState>, text: String, limit: usize) -> R<Vec<NoteSummary>> {
    with(&state, |s| s.search_notes(&text, limit.min(200)))
}

#[tauri::command]
pub fn note_folders(state: State<AppState>) -> R<Vec<NoteFolder>> {
    with(&state, |s| s.note_folders())
}

#[tauri::command]
pub fn open_note(state: State<AppState>, id: i64) -> R<Note> {
    with(&state, |s| s.note(id))
}

#[tauri::command]
pub fn peek_note(state: State<AppState>, id: i64) -> R<Note> {
    with(&state, |s| s.peek_note(id))
}

#[tauri::command]
pub fn create_note(
    state: State<AppState>,
    folder: String,
    title: String,
    body: String,
    tags: Vec<String>,
) -> R<Note> {
    with(&state, |s| s.create_note(&folder, &title, &body, &tags))
}

#[tauri::command]
pub fn save_note(state: State<AppState>, id: i64, body: String, base_hash: String) -> R<SavedNote> {
    with(&state, |s| s.save_note(id, &body, &base_hash))
}

#[tauri::command]
pub fn rename_note(state: State<AppState>, id: i64, title: String) -> R<NoteChange> {
    with(&state, |s| s.rename_note(id, &title))
}

#[tauri::command]
pub fn pin_note(state: State<AppState>, id: i64, pinned: bool) -> R<Note> {
    with(&state, |s| s.set_note_pinned(id, pinned))
}

#[tauri::command]
pub fn set_note_tags(state: State<AppState>, id: i64, tags: Vec<String>) -> R<Note> {
    with(&state, |s| s.set_note_tags(id, &tags))
}

#[tauri::command]
pub fn trash_note(state: State<AppState>, id: i64) -> R<UndoToken> {
    with(&state, |s| s.trash_note(id))
}

#[tauri::command]
pub fn promote_draft(
    state: State<AppState>,
    draft_id: i64,
    folder: String,
    title: String,
    keep_tags: bool,
) -> R<NoteChange> {
    with(&state, |s| s.promote_draft(draft_id, &folder, &title, keep_tags))
}

#[tauri::command]
pub fn append_to_note(state: State<AppState>, draft_id: i64, note_id: i64, keep_tags: bool) -> R<NoteChange> {
    with(&state, |s| s.append_to_note(draft_id, note_id, keep_tags))
}

#[tauri::command]
pub fn link_targets(state: State<AppState>, text: String, limit: usize) -> R<Vec<LinkTarget>> {
    with(&state, |s| s.link_targets(&text, limit.min(50)))
}

#[tauri::command]
pub fn resolve_link(state: State<AppState>, inner: String) -> R<Resolved> {
    with(&state, |s| s.resolve_link(&inner))
}

#[tauri::command]
pub fn backlinks(state: State<AppState>, id: i64) -> R<Backlinks> {
    with(&state, |s| s.backlinks(id))
}

#[tauri::command]
pub fn link_mention(state: State<AppState>, note_id: i64, kind: String, id: i64) -> R<UndoToken> {
    with(&state, |s| s.link_mention(note_id, &kind, id))
}
