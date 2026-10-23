//! What the UI may ask for. Every command returns `Result<T, String>`; the engine's errors are formatted
//! with their context chain so the strip or the log can show them.

use petrel_core::store::SweepReport;
use petrel_core::{Draft, Folder, ListPage, ListQuery, SearchHit, Store, TagCount, UndoToken};
use tauri::{Manager, State};

use crate::AppState;

type R<T> = Result<T, String>;

fn with<T>(state: &State<AppState>, f: impl FnOnce(&mut Store) -> anyhow::Result<T>) -> R<T> {
    let mut store = state.store.lock().map_err(|_| "store lock poisoned".to_string())?;
    f(&mut store).map_err(|e| format!("{e:#}"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: &'static str,
    db_path: String,
    debug: bool,
}

#[tauri::command]
pub fn app_info(state: State<AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        db_path: state.db_path.display().to_string(),
        debug: cfg!(debug_assertions),
    }
}

#[tauri::command]
pub fn new_draft(state: State<AppState>, content: String) -> R<Draft> {
    with(&state, |s| s.new_draft(&content))
}

#[tauri::command]
pub fn open_draft(state: State<AppState>, id: i64) -> R<Draft> {
    with(&state, |s| s.draft(id))
}

#[tauri::command]
pub fn save_draft(state: State<AppState>, id: i64, content: String, cursor: i64) -> R<bool> {
    with(&state, |s| s.save(id, &content, cursor))
}

#[tauri::command]
pub fn list_drafts(state: State<AppState>, query: ListQuery) -> R<ListPage> {
    with(&state, |s| s.list(&query))
}

#[tauri::command]
pub fn search_drafts(state: State<AppState>, query: String, limit: usize) -> R<Vec<SearchHit>> {
    with(&state, |s| s.search(&query, limit.min(500)))
}

#[tauri::command]
pub fn set_tags(state: State<AppState>, id: i64, tags: Vec<String>) -> R<Vec<String>> {
    with(&state, |s| s.set_tags(id, &tags))
}

#[tauri::command]
pub fn tag_counts(state: State<AppState>, folder: Option<Folder>) -> R<Vec<TagCount>> {
    with(&state, |s| s.tag_counts(folder))
}

#[tauri::command]
pub fn rename_tag(state: State<AppState>, from: String, to: String) -> R<usize> {
    with(&state, |s| s.rename_tag(&from, &to))
}

#[tauri::command]
pub fn merge_tags(state: State<AppState>, from: Vec<String>, into: String) -> R<usize> {
    with(&state, |s| s.merge_tags(&from, &into))
}

#[tauri::command]
pub fn move_drafts(state: State<AppState>, ids: Vec<i64>, folder: Folder) -> R<UndoToken> {
    with(&state, |s| s.move_drafts(&ids, folder))
}

#[tauri::command]
pub fn flag_drafts(state: State<AppState>, ids: Vec<i64>, flagged: bool) -> R<UndoToken> {
    with(&state, |s| s.flag_drafts(&ids, flagged))
}

#[tauri::command]
pub fn add_tags(state: State<AppState>, ids: Vec<i64>, tags: Vec<String>) -> R<UndoToken> {
    with(&state, |s| s.add_tags(&ids, &tags))
}

#[tauri::command]
pub fn undo(state: State<AppState>, token: String) -> R<usize> {
    with(&state, |s| s.undo(&token))
}

/// No undo: the UI says so in its confirm dialog.
#[tauri::command]
pub fn empty_trash(state: State<AppState>) -> R<usize> {
    with(&state, |s| s.empty_trash())
}

/// Runs housekeeping now; the shell also runs it at start and daily.
#[tauri::command]
pub fn sweep(state: State<AppState>) -> R<SweepReport> {
    with(&state, |s| s.sweep())
}

/// The window starts hidden and the UI shows it once it has rendered, so there is no white flash.
#[tauri::command]
pub fn show_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
