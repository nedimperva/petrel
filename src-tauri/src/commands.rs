//! What the UI may ask for. Every command returns `Result<T, String>`; the engine's errors are formatted
//! with their context chain so the strip or the log can show them.

use petrel_core::Store;
use std::sync::atomic::Ordering;

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

/// The last way out when the database will not take a save: the text goes to a file next to it
/// (`rescued/unsaved-<ms>.md`), outside SQLite, so a window can close without losing it. Returns the file's path.
#[tauri::command]
pub fn rescue_text(state: State<AppState>, text: String) -> R<String> {
    let dir = state.db_path.parent().map(|d| d.join("rescued")).ok_or("no data folder")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let path = dir.join(format!("unsaved-{ms}.md"));
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
    log::warn!("rescued unsaved text to {}", path.display());
    Ok(path.display().to_string())
}

/// Closes the calling window once its text is saved; the window's own close button is intercepted so it can't
/// close first. With a tray the main window only hides, so it comes back instantly and keeps its state; Quit
/// (or no tray) really closes it.
#[tauri::command]
pub fn close_window(state: State<AppState>, window: tauri::WebviewWindow) {
    let stays = state.tray.load(Ordering::SeqCst) && !state.quitting.load(Ordering::SeqCst);
    if window.label() == "main" && stays {
        let _ = window.hide();
        return;
    }
    let _ = window.destroy();
}

/// The window starts hidden and the UI shows it once it has rendered, so there is no white flash.
#[tauri::command]
pub fn show_window(state: State<AppState>, window: tauri::WebviewWindow) {
    // `petrel --capture` or `--hidden` as the first launch: the main window loads but stays hidden until asked for.
    if window.label() == "main" && state.stay_hidden.swap(false, Ordering::SeqCst) {
        return;
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// The capture window saved its draft and is done. With a tray Petrel keeps running there. Without one, if the
/// main window was never shown, nothing would be left on screen, so Petrel quits rather than lingering unseen.
#[tauri::command]
pub fn close_capture(state: State<AppState>, app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.destroy();
    }
    if state.tray.load(Ordering::SeqCst) {
        return;
    }
    let main_visible = app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false);
    if !main_visible {
        app.exit(0);
    }
}

/// The command bar's "Capture window".
#[tauri::command]
pub fn open_capture_window(app: tauri::AppHandle) {
    crate::open_capture(&app);
}

/// The UI's own preferences (`ui.*`: theme, last screen). Other keys belong to the engine.
#[tauri::command]
pub fn ui_settings(state: State<AppState>) -> R<std::collections::HashMap<String, String>> {
    with(&state, |s| Ok(s.settings_with_prefix("ui.")?.into_iter().collect()))
}

#[tauri::command]
pub fn set_ui_setting(state: State<AppState>, key: String, value: String) -> R<()> {
    if !key.starts_with("ui.") || key.len() > 64 {
        return Err(format!("{key} is not a UI setting"));
    }
    with(&state, |s| s.set_setting(&key, &value))
}

/// The settings page's Desktop section: the two hotkeys and start at login.
#[tauri::command]
pub fn desktop_settings(app: tauri::AppHandle) -> crate::desktop::DesktopSettings {
    crate::desktop::settings(&app)
}

/// `None` or empty turns the hotkey off. Refused (and the old one kept) when the key is taken or malformed.
#[tauri::command]
pub fn set_hotkey(
    app: tauri::AppHandle,
    which: crate::desktop::Which,
    hotkey: Option<String>,
) -> R<crate::desktop::DesktopSettings> {
    crate::desktop::set_hotkey(&app, which, hotkey).map_err(|e| format!("{e:#}"))?;
    Ok(crate::desktop::settings(&app))
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, on: bool) -> R<crate::desktop::DesktopSettings> {
    crate::desktop::set_autostart(&app, on).map_err(|e| format!("{e:#}"))?;
    Ok(crate::desktop::settings(&app))
}

// ---- copy ----------------------------------------------------------------------------------------------------

/// Puts text on the clipboard; with `html`, also as rich text for apps that paste formatting (mail, docs). The
/// clipboard handle lives in the app state: on Linux the owner must stay alive for the text to stay pasteable.
#[tauri::command]
pub fn copy_text(state: State<AppState>, text: String, html: bool) -> R<()> {
    let mut slot = state.clipboard.lock().map_err(|_| "clipboard lock poisoned".to_string())?;
    if slot.is_none() {
        *slot = Some(arboard::Clipboard::new().map_err(|e| format!("no clipboard: {e}"))?);
    }
    let cb = slot.as_mut().expect("just set");
    let done = if html { cb.set_html(markdown_html(&text), Some(text.clone())) } else { cb.set_text(&text) };
    done.map_err(|e| {
        // A dead connection (the display server restarted) is not coming back; the next copy opens a new one.
        *slot = None;
        format!("copying: {e}")
    })
}

/// Markdown as HTML for "Copy formatted". Raw HTML in the note is dropped: it would paste into mail as markup.
pub fn markdown_html(md: &str) -> String {
    use pulldown_cmark::{html, Event, Options, Parser};
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let events = Parser::new_ext(md, opts).filter(|e| !matches!(e, Event::Html(_) | Event::InlineHtml(_)));
    let mut out = String::new();
    html::push_html(&mut out, events);
    out
}

// ---- the quick picker ------------------------------------------------------------------------------------------

#[tauri::command]
pub fn open_picker_window(app: tauri::AppHandle) {
    crate::open_picker(&app);
}

/// The picker copied (or was dismissed) and is done.
#[tauri::command]
pub fn close_picker(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("picker") {
        let _ = w.destroy();
    }
}

/// "Open in Petrel" from the picker: the main window shows the note.
#[tauri::command]
pub fn show_note_in_main(app: tauri::AppHandle, id: i64) {
    use tauri::Emitter;
    crate::show_main(&app);
    let _ = app.emit_to("main", "petrel-open-note", id);
}

#[cfg(test)]
mod tests {
    #[test]
    fn formatted_copy_drops_raw_html() {
        let h = super::markdown_html("# Hi\n\n- [ ] one\n\n<script>x</script>\n\n**bold**");
        assert!(h.contains("<h1>Hi</h1>") && h.contains("<strong>bold</strong>") && h.contains("checkbox"));
        assert!(!h.contains("<script>"), "{h}");
    }
}
