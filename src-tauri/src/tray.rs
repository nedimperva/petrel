//! The tray icon (package 07): New draft, Capture, Show, Quit. With it, closing a window hides it and Petrel
//! keeps running, so the next capture is instant. Quit asks every window to save and close first.

use std::sync::atomic::Ordering;

use anyhow::{Context, Result};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

use crate::AppState;

pub fn build(app: &tauri::App) -> Result<()> {
    let new = MenuItem::with_id(app, "new", "New draft", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "Capture…", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Petrel", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause hotkey", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Petrel", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&new, &capture, &show, &sep, &quit])?;
    // Only where the app owns the hotkey; on Wayland the compositor does.
    if crate::desktop::hotkey_supported() {
        menu.insert(&pause, 4)?;
    }
    let pause_item = pause.clone();
    let icon = app.default_window_icon().cloned().context("no app icon for the tray")?;
    TrayIconBuilder::with_id("petrel")
        .icon(icon)
        .tooltip("Petrel")
        .menu(&menu)
        // Left click shows the window (Windows); the menu is on the right button. Linux trays only have the menu.
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "new" => crate::show_new_draft(app),
            "capture" => crate::open_capture(app),
            "show" => crate::show_main(app),
            "pause" => {
                let paused = crate::desktop::toggle_pause(app);
                let _ = pause_item.set_checked(paused);
            }
            "quit" => self::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Each window saves its text and closes itself (`petrel-quit`); the last one to close ends the process.
/// Choosing Quit again while that is under way ends it at once: every window flushes on hide and blur, so
/// at most the last few hundred milliseconds of typing are at stake, and only if a save is failing.
pub fn quit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        log::warn!("quit chosen twice: exiting without waiting for the windows");
        return app.exit(0);
    }
    let windows = app.webview_windows();
    if windows.is_empty() {
        return app.exit(0);
    }
    for label in windows.keys() {
        if let Err(e) = app.emit_to(label.as_str(), "petrel-quit", ()) {
            log::warn!("asking {label} to close: {e}");
        }
    }
}
