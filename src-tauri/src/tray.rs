//! The tray icon: Capture, Quick picker, Show, Quit. With it, closing a window hides it and Petrel
//! keeps running, so the next capture is instant. Quit asks every window to save and close first.

use std::sync::atomic::Ordering;

use anyhow::{Context, Result};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

use crate::AppState;

pub fn build(app: &tauri::App) -> Result<()> {
    let new = MenuItem::with_id(app, "picker", "Quick picker…", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "Capture…", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Petrel", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause hotkeys", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Petrel", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&capture, &new, &show, &sep, &quit])?;
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
            "picker" => crate::open_picker(app),
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
    // With Drive on, the last edits go before the windows close: the main window saves and says so, and sync
    // gets up to five seconds. Quit chosen again meanwhile exits at once, as above.
    if crate::sync::is_on(app) {
        let _ = app.emit_to("main", "petrel-last-sync", ());
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            if !crate::sync::last(&app, std::time::Duration::from_secs(5)) {
                log::warn!("quit: the last sync took longer than five seconds; it runs at the next start");
                crate::sync::note_unfinished(&app);
            }
            let again = app.clone();
            let _ = app.run_on_main_thread(move || close_windows(&again));
        });
        return;
    }
    close_windows(app);
}

/// Each window saves its text and closes; the last one to close ends the process.
fn close_windows(app: &tauri::AppHandle) {
    let windows = app.webview_windows();
    if windows.is_empty() {
        return app.exit(0);
    }
    for (label, w) in &windows {
        // A warm window that is hidden has no text in it; the picker never has.
        if label == "picker" || (label == "capture" && !w.is_visible().unwrap_or(false)) {
            let _ = w.destroy();
            continue;
        }
        if let Err(e) = app.emit_to(label.as_str(), "petrel-quit", ()) {
            log::warn!("asking {label} to close: {e}");
        }
    }
}

/// What the tray icon says about sync: nothing when all is well, an amber dot for a note to settle or a sync
/// waiting on the network, a red dot when sync needs you (sign in again, or it failed).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mark {
    None,
    Waiting,
    Needs,
}

static SHOWN: std::sync::Mutex<Option<Mark>> = std::sync::Mutex::new(None);

/// Puts the mark on the tray icon, once per change.
pub fn mark_sync(app: &tauri::AppHandle, mark: Mark) {
    {
        let Ok(mut shown) = SHOWN.lock() else { return };
        if *shown == Some(mark) {
            return;
        }
        *shown = Some(mark);
    }
    let Some(tray) = app.tray_by_id("petrel") else { return };
    let Some(base) = app.default_window_icon() else { return };
    let (w, h) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
    let tip = match mark {
        Mark::None => "Petrel",
        Mark::Waiting => "Petrel · sync is waiting, or a note waits to be settled",
        Mark::Needs => "Petrel · sync needs you: open Settings › Sync",
    };
    let colour = match mark {
        Mark::None => None,
        Mark::Waiting => Some([0xe0, 0xa2, 0x3a]),
        Mark::Needs => Some([0xd2, 0x4b, 0x3f]),
    };
    if let Some(c) = colour {
        dot(&mut rgba, w, h, c);
    }
    let _ = tray.set_icon(Some(tauri::image::Image::new_owned(rgba, w, h)));
    let _ = tray.set_tooltip(Some(tip));
}

/// A filled dot with a light ring in the lower right corner, a third of the icon wide.
fn dot(rgba: &mut [u8], w: u32, h: u32, c: [u8; 3]) {
    let r = w.min(h) as f32 / 6.0;
    let (cx, cy) = (w as f32 - r - 1.0, h as f32 - r - 1.0);
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            let i = ((y * w + x) * 4) as usize;
            if d <= r {
                rgba[i..i + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
            } else if d <= r + r * 0.35 {
                rgba[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
    }
}
