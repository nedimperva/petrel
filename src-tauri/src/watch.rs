//! The live folder: Drive (or another app) changing a note is seen within a second, not only when the window
//! comes to the front. Events are gathered for a moment, then only those files are read again
//! (`Store::scan_paths`) and the main window is told which notes changed, so an open note with no typing in it
//! can reload quietly. Petrel's own writes come back as no change. A folder that sends no events (some network or
//! virtual drives) still has the rescan on focus.

use std::path::Path;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{Emitter, Manager};

use crate::AppState;

/// Events closer together than this are read as one change: a sync client writes a file in several steps.
const QUIET: Duration = Duration::from_millis(600);

pub type Watcher = Debouncer<RecommendedWatcher>;

/// Watches `root`, replacing any watcher on the old folder. Errors are logged: the rescan on focus still works.
pub fn start(app: &tauri::AppHandle, root: &Path) {
    let handle = app.clone();
    let made = new_debouncer(QUIET, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let paths: Vec<_> = events.into_iter().map(|e| e.path).collect();
        if paths.is_empty() {
            return;
        }
        let state = handle.state::<AppState>();
        let report = {
            let Ok(mut store) = state.store.lock() else { return };
            store.scan_paths(&paths)
        };
        match report {
            Ok(r) if !r.paths.is_empty() => {
                let _ = handle.emit_to("main", "petrel-folder", r);
            }
            Ok(_) => {}
            Err(e) => log::warn!("reading changed notes: {e:#}"),
        }
    });
    let watcher = made.and_then(|mut d| d.watcher().watch(root, RecursiveMode::Recursive).map(|_| d));
    let state = app.state::<AppState>();
    let Ok(mut slot) = state.watcher.lock() else { return };
    match watcher {
        Ok(w) => {
            *slot = Some(w);
            log::info!("watching {}", root.display());
        }
        Err(e) => {
            *slot = None;
            log::warn!("cannot watch {} (the folder is read again on focus): {e}", root.display());
        }
    }
}
