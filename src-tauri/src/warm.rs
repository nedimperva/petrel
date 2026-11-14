//! Warm windows: the capture window and the picker are made once and then only hidden and shown, so a hotkey
//! shows a page that has already loaded instead of booting a new webview each time.
//!
//! A warm page waits, hidden, until it is asked for. The page tells Rust it is waiting (`window_ready`); an open
//! asked for before that is remembered and handed over then, one asked for after is sent as `petrel-open-window`.
//! When the page is done it hides itself and reloads, which brings it back to waiting with a clean slate.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct Warm {
    /// Pages that are loaded and waiting to be asked for.
    ready: HashSet<String>,
    /// Pages asked for before they were waiting.
    pending: HashSet<String>,
}

pub type State = Mutex<Warm>;

/// How a window should be opened right now.
pub enum Open {
    /// Not made yet: make it; the page starts as soon as it is waiting.
    Build,
    /// Made and waiting: it was told to start.
    Started,
    /// Already on screen: bring it forward.
    Focus(Box<tauri::WebviewWindow>),
    /// Made but still loading: it starts as soon as it is waiting.
    Loading,
}

/// Asks the window `label` to open, and says what the caller still has to do.
pub fn open(app: &tauri::AppHandle, label: &str) -> Open {
    let Some(w) = app.get_webview_window(label) else {
        mark_pending(app, label);
        return Open::Build;
    };
    if w.is_visible().unwrap_or(false) {
        return Open::Focus(Box::new(w));
    }
    let state = app.state::<State>();
    let Ok(mut warm) = state.lock() else { return Open::Loading };
    if warm.ready.remove(label) {
        drop(warm);
        if let Err(e) = app.emit_to(label, "petrel-open-window", ()) {
            log::warn!("asking {label} to open: {e}");
        }
        return Open::Started;
    }
    warm.pending.insert(label.to_string());
    Open::Loading
}

fn mark_pending(app: &tauri::AppHandle, label: &str) {
    if let Ok(mut warm) = app.state::<State>().lock() {
        warm.ready.remove(label);
        warm.pending.insert(label.to_string());
    }
}

/// The page is loaded and waiting. True means it was already asked for and should start now.
#[tauri::command]
pub fn window_ready(state: tauri::State<State>, window: tauri::WebviewWindow) -> bool {
    let label = window.label().to_string();
    let Ok(mut warm) = state.lock() else { return true };
    if warm.pending.remove(&label) {
        return true;
    }
    warm.ready.insert(label);
    false
}

/// Hides a warm window; its page reloads itself to wait again. Without a tray, or while quitting, the window
/// is closed instead: a hidden window would keep Petrel running with nothing on screen.
pub fn hide(app: &tauri::AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let state = app.state::<crate::AppState>();
    let stays = state.tray.load(Ordering::SeqCst) && !state.quitting.load(Ordering::SeqCst);
    if stays {
        let _ = w.hide();
    } else {
        if let Ok(mut warm) = app.state::<State>().lock() {
            warm.ready.remove(label);
            warm.pending.remove(label);
        }
        let _ = w.destroy();
    }
}
