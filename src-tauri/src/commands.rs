//! What the UI may ask for. Every command returns `Result<T, String>`; the engine's errors are formatted
//! with their context chain so the strip or the log can show them.

use petrel_core::action::{self, Action, EditorState, Paths, RunReport, Source};
use petrel_core::host::CancelToken;
use petrel_core::store::SweepReport;
use petrel_core::store_actions::RunLogEntry;
use petrel_core::{Draft, Folder, ListPage, ListQuery, SearchHit, Store, TagCount, UndoToken};
use tauri::{Manager, State};

use crate::host::TauriHost;
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

// ---- actions (package 03) -----------------------------------------------------------------------------------

#[tauri::command]
pub fn list_actions(state: State<AppState>) -> R<Vec<Action>> {
    with(&state, |s| s.actions())
}

/// Saving from the action editor trusts the steps: the person just wrote them (actions.md "Trust").
#[tauri::command]
pub fn save_action(state: State<AppState>, action: Action) -> R<Action> {
    with(&state, |s| s.save_action(&action, true))
}

#[tauri::command]
pub fn delete_action(state: State<AppState>, uuid: String) -> R<bool> {
    with(&state, |s| s.delete_action(&uuid))
}

#[tauri::command]
pub fn action_log(state: State<AppState>, limit: usize) -> R<Vec<RunLogEntry>> {
    with(&state, |s| s.action_log(limit.min(1000)))
}

/// The webview's answer to a `host-request` event.
#[tauri::command]
pub fn host_reply(state: State<AppState>, id: u64, value: serde_json::Value) -> bool {
    state.broker.answer(id, value)
}

/// Stops the running action, if there is one (`Esc` while it runs).
#[tauri::command]
pub fn cancel_run(state: State<AppState>) -> bool {
    match state.running.lock().ok().and_then(|r| r.clone()) {
        Some(token) => {
            token.cancel();
            true
        }
        None => false,
    }
}

/// `runAction` steps look actions up while the store is otherwise free.
struct Library<'a>(&'a std::sync::Mutex<Store>);

impl action::Library for Library<'_> {
    fn find_action(&self, key: &str) -> Option<Action> {
        self.0.lock().ok()?.action(key).ok().flatten()
    }
}

/// Clears the running slot however the run ends.
struct Running<'a>(&'a AppState);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        if let Ok(mut r) = self.0.running.lock() {
            *r = None;
        }
    }
}

/// Runs an action on a draft. The store is locked only to load and to commit, so autosave and the list keep
/// working while a step waits on a command or on the person. One run at a time.
#[tauri::command]
pub async fn run_action(
    app: tauri::AppHandle,
    key: String,
    draft_id: i64,
    editor: Option<EditorState>,
    source: Option<Source>,
) -> R<RunReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let cancel = CancelToken::default();
        {
            let mut running = state.running.lock().map_err(|_| "run lock poisoned".to_string())?;
            if running.is_some() {
                return Err("another action is running".to_string());
            }
            *running = Some(cancel.clone());
        }
        let _running = Running(&state);
        let (prepared, paths) = with(&state, |s| {
            Ok((action::prepare(s, &key, draft_id, editor, source.unwrap_or_default())?, Paths::for_store(s)))
        })?;
        let mut host = TauriHost {
            app: &app,
            broker: &state.broker,
            clipboard: &state.clipboard,
            cancel: cancel.clone(),
        };
        let executed = action::execute(prepared, &mut host, &Library(&state.store), &paths, &cancel);
        let report = with(&state, |s| action::finish(s, executed))?;
        if let action::RunOutcome::Failed { step, message } = &report.outcome {
            log::info!("action {} failed at step {step}: {message}", report.action);
        }
        Ok(report)
    })
    .await
    .map_err(|e| format!("the run stopped: {e}"))?
}
