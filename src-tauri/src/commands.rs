//! What the UI may ask for. Every command returns `Result<T, String>`; the engine's errors are formatted
//! with their context chain so the strip or the log can show them.

use petrel_core::store::Cursor;
use petrel_core::{Draft, Folder, ListPage, Store};
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
pub fn list_drafts(
    state: State<AppState>,
    folder: Folder,
    cursor: Option<Cursor>,
    limit: usize,
) -> R<ListPage> {
    with(&state, |s| s.list(folder, cursor, limit.min(500)))
}

/// The window starts hidden and the UI shows it once it has rendered, so there is no white flash.
#[tauri::command]
pub fn show_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
