//! The notes commands (docs/design/notes.md). Same shape as `commands.rs`: the store does the work, these
//! translate errors. File reads and writes are small and local, so they run on the command thread like a save.

use std::path::{Path, PathBuf};

use petrel_core::notes::{
    Backlinks, Conflict, LinkTarget, Note, NoteChange, NoteFolder, NoteQuery, NoteSummary, NoteVersion,
    OpenTask, Resolved, SavedNote, ScanReport, TopicFace,
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
pub fn set_notes_root(app: tauri::AppHandle, state: State<AppState>, root: String) -> R<ScanReport> {
    let report = with(&state, |s| s.set_notes_root(Path::new(&root)))?;
    crate::watch::start(&app, Path::new(&root));
    Ok(report)
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

/// A new capture: a file in `inbox/`. The capture window calls this on the first keystroke, then saves.
#[tauri::command]
pub fn capture_note(state: State<AppState>, body: String) -> R<Note> {
    let default = default_root(&state.db_path);
    with(&state, |s| {
        let root = s.notes_root_or(&default)?;
        std::fs::create_dir_all(&root)?;
        s.capture_note(&body)
    })
}

/// Files a note somewhere else (the inbox's `m` and Enter): another folder, a new title, or both.
#[tauri::command]
pub fn move_note(state: State<AppState>, id: i64, folder: String, title: String) -> R<NoteChange> {
    with(&state, |s| s.move_note(id, &folder, &title))
}

/// Adds a capture to the end of a note and puts the capture in the trash.
#[tauri::command]
pub fn merge_note(state: State<AppState>, from: i64, into: i64) -> R<NoteChange> {
    with(&state, |s| s.merge_note(from, into))
}

#[tauri::command]
pub fn undo_note(state: State<AppState>, token: String) -> R<usize> {
    with(&state, |s| s.undo(&token))
}

#[tauri::command]
pub fn note_versions(state: State<AppState>, id: i64) -> R<Vec<NoteVersion>> {
    with(&state, |s| s.note_versions(id))
}

#[tauri::command]
pub fn note_version_text(state: State<AppState>, version_id: i64) -> R<String> {
    with(&state, |s| s.note_version_text(version_id))
}

#[tauri::command]
pub fn restore_note_version(state: State<AppState>, id: i64, version_id: i64) -> R<Note> {
    with(&state, |s| s.restore_note_version(id, version_id))
}

/// Counts a copy from a collection, so its most used items come first; `app` is the app in front of the picker.
#[tauri::command]
pub fn record_copy(state: State<AppState>, id: i64, app: Option<String>) -> R<i64> {
    with(&state, |s| s.record_copy(id, app.as_deref()))
}

/// What the picker copied with this app in front, by path.
#[tauri::command]
pub fn copy_counts_in(state: State<AppState>, app: String) -> R<std::collections::HashMap<String, i64>> {
    with(&state, |s| s.copy_counts_in(&app))
}

/// Every unticked task, for the Ctrl K tasks page.
#[tauri::command]
pub fn open_tasks(state: State<AppState>) -> R<Vec<OpenTask>> {
    with(&state, |s| s.open_tasks())
}

/// Ticks one task in its file.
#[tauri::command]
pub fn tick_task(state: State<AppState>, id: i64, line: usize, text: String) -> R<UndoToken> {
    with(&state, |s| s.tick_task(id, line, &text))
}

/// A new collection from the sidebar (`Recipes`, or `Travel/Mostar` inside one).
#[tauri::command]
pub fn create_folder(state: State<AppState>, folder: String) -> R<String> {
    with(&state, |s| s.create_folder(&folder))
}

/// Renames a collection in place; returns its new path.
#[tauri::command]
pub fn rename_folder(state: State<AppState>, folder: String, name: String) -> R<String> {
    with(&state, |s| s.rename_folder(&folder, &name))
}

/// Moves a collection and its notes to `.trash/`; returns how many notes went.
#[tauri::command]
pub fn trash_folder(state: State<AppState>, folder: String) -> R<usize> {
    with(&state, |s| s.trash_folder(&folder))
}

/// "Show in the folder": the file manager, on the collection.
#[tauri::command]
pub fn reveal_folder(app: tauri::AppHandle, state: State<AppState>, folder: String) -> R<()> {
    use tauri_plugin_opener::OpenerExt;
    let default = default_root(&state.db_path);
    let root = with(&state, |s| s.notes_root_or(&default))?;
    let path = root.join(petrel_core::notes::clean_folder(&folder));
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// Notes with a conflict copy beside them.
#[tauri::command]
pub fn conflicts(state: State<AppState>) -> R<Vec<Conflict>> {
    with(&state, |s| s.conflicts())
}

/// `keep`: `left`, `right` or `both`.
#[tauri::command]
pub fn settle_conflict(state: State<AppState>, original: i64, copy: i64, keep: String) -> R<UndoToken> {
    with(&state, |s| s.settle_conflict(original, copy, &keep))
}

#[tauri::command]
pub fn copy_counts(state: State<AppState>) -> R<std::collections::HashMap<String, i64>> {
    with(&state, |s| s.copy_counts())
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

/// Today's page, or any day's (`YYYY-MM-DD`). None when the day has no page yet.
#[tauri::command]
pub fn day_note(state: State<AppState>, date: String) -> R<Option<Note>> {
    with(&state, |s| s.day_note(&date))
}

/// Files a capture onto a day's page, under the time.
#[tauri::command]
pub fn file_into_day(state: State<AppState>, id: i64, date: String) -> R<NoteChange> {
    with(&state, |s| s.file_into_day(id, &date))
}

/// `has:link`, `has:picture`, `has:task` in Ctrl K.
#[tauri::command]
pub fn notes_having(state: State<AppState>, what: String) -> R<Vec<i64>> {
    with(&state, |s| s.notes_having(&what))
}

/// What "the week" reads, and what the week's page counts and lists without AI.
#[tauri::command]
pub fn notes_between(state: State<AppState>, from: i64, to: i64) -> R<Vec<Note>> {
    with(&state, |s| s.notes_between(from, to))
}

#[tauri::command]
pub fn topic_faces(state: State<AppState>) -> R<std::collections::HashMap<String, TopicFace>> {
    with(&state, |s| s.topic_faces())
}

#[tauri::command]
pub fn set_topic_face(
    state: State<AppState>,
    top: String,
    color: String,
    mark: String,
    copy: Option<String>,
) -> R<TopicFace> {
    with(&state, |s| s.set_topic_face(&top, &color, &mark, copy.as_deref().unwrap_or("")))
}

/// A pasted picture, sent as raw bytes (a JSON array would be several times bigger). The folder and the file
/// name come in headers, percent-encoded: a header carries ASCII only.
#[tauri::command]
pub fn save_attachment(state: State<AppState>, request: tauri::ipc::Request<'_>) -> R<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("the picture did not arrive as bytes".into());
    };
    let header = |k: &str| -> R<String> {
        let v = request.headers().get(k).ok_or_else(|| format!("no {k}"))?;
        percent_decode(v.to_str().map_err(|e| e.to_string())?)
    };
    let (folder, name) = (header("x-petrel-folder")?, header("x-petrel-name")?);
    with(&state, |s| s.save_attachment(&folder, &name, bytes))
}

/// A picture's bytes, to show on the page.
#[tauri::command]
pub fn attachment(state: State<AppState>, folder: String, link: String) -> R<tauri::ipc::Response> {
    with(&state, |s| s.attachment(&folder, &link)).map(tauri::ipc::Response::new)
}

/// What `encodeURIComponent` made, back to text.
fn percent_decode(s: &str) -> R<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| format!("bad escape in {s}"))?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn headers_decode() {
        assert_eq!(super::percent_decode("Putovanja%2F%C5%A1alica").unwrap(), "Putovanja/šalica");
        assert_eq!(super::percent_decode("plain.png").unwrap(), "plain.png");
        assert!(super::percent_decode("%zz").is_err());
    }
}
