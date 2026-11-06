//! The global capture hotkey and start at login (package 07).
//!
//! The hotkey opens the capture window from anywhere. It works on Windows and X11. On Wayland an app can't grab
//! keys, so the compositor binds `petrel --capture` instead (README), and the settings say so.
//! Start at login launches `petrel --hidden`: Petrel waits in the tray, so the first capture is instant.

use std::str::FromStr;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::AppState;

/// The setting: absent means the default, empty means off.
pub const HOTKEY_SETTING: &str = "capture.hotkey";
/// Ctrl+Alt is AltGr on Windows, and AltGr with a letter types a character on many layouts (AltGr+N is `}` on
/// Croatian and Bosnian ones). AltGr+Space types nothing on common layouts, and few apps use Ctrl+Alt+Space.
pub const DEFAULT_HOTKEY: &str = "Ctrl+Alt+Space";
/// What start at login passes, so Petrel starts in the tray instead of on screen.
pub const HIDDEN_ARG: &str = "--hidden";

/// The hotkey as registered, or why not.
#[derive(Default)]
pub struct Hotkey {
    /// What the person chose (`None`: off).
    pub chosen: Option<String>,
    pub registered: Option<Shortcut>,
    pub error: Option<String>,
    /// Paused from the tray until resumed or Petrel restarts.
    pub paused: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    hotkey: Option<String>,
    hotkey_default: &'static str,
    /// Registered and not paused.
    hotkey_active: bool,
    hotkey_paused: bool,
    hotkey_error: Option<String>,
    /// False on Wayland, where the compositor binds keys.
    hotkey_supported: bool,
    autostart: bool,
    autostart_error: Option<String>,
}

pub fn hotkey_supported() -> bool {
    !(cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some())
}

pub fn wants_hidden(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == HIDDEN_ARG)
}

/// The chosen hotkey from the store, the default if never set.
fn stored_hotkey(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let stored = state.store.lock().ok().and_then(|s| s.setting(HOTKEY_SETTING).ok().flatten());
    match stored {
        None => Some(DEFAULT_HOTKEY.to_string()),
        Some(s) if s.trim().is_empty() => None,
        Some(s) => Some(s),
    }
}

/// Parses a hotkey as the settings write it (`Ctrl+Alt+Space`). The plugin's parser takes these names.
pub fn parse(text: &str) -> Result<Shortcut> {
    let s = Shortcut::from_str(text.trim()).map_err(|e| anyhow!("{e}"))?;
    if s.mods.is_empty() {
        anyhow::bail!("a hotkey needs Ctrl, Alt or Shift: a bare key would be taken from every app");
    }
    Ok(s)
}

/// Registers the stored hotkey at start. Failures are kept for the settings to show, never fatal.
pub fn init(app: &AppHandle) {
    let chosen = stored_hotkey(app);
    let mut hk = Hotkey { chosen: chosen.clone(), ..Default::default() };
    if let Some(text) = chosen.filter(|_| hotkey_supported()) {
        match register(app, &text) {
            Ok(s) => hk.registered = Some(s),
            Err(e) => {
                log::warn!("capture hotkey {text}: {e:#}");
                hk.error = Some(format!("{e:#}"));
            }
        }
    }
    app.state::<AppState>().hotkey.lock().map(|mut h| *h = hk).ok();
}

fn register(app: &AppHandle, text: &str) -> Result<Shortcut> {
    let s = parse(text)?;
    app.global_shortcut()
        .register(s)
        .with_context(|| format!("{text} is taken by another app or the system"))?;
    Ok(s)
}

/// The plugin calls this for every registered key; only the capture hotkey is registered.
pub fn on_shortcut(app: &AppHandle, _shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    let paused = app.state::<AppState>().hotkey.lock().map(|h| h.paused).unwrap_or(false);
    if !paused {
        crate::open_capture(app);
    }
}

/// Changes the hotkey (`None` or empty: off). The new one is registered before the old one goes, so a key that
/// is taken leaves the working one in place.
pub fn set_hotkey(app: &AppHandle, text: Option<String>) -> Result<()> {
    let text = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let state = app.state::<AppState>();
    let old = lock(&state.hotkey)?.registered;
    let new = match &text {
        Some(t) if hotkey_supported() => {
            let s = parse(t)?;
            if Some(s) != old {
                register(app, t)?;
            }
            Some(s)
        }
        Some(t) => {
            parse(t)?;
            None
        }
        None => None,
    };
    if let Some(o) = old.filter(|o| Some(*o) != new) {
        let _ = app.global_shortcut().unregister(o);
    }
    state
        .store
        .lock()
        .map_err(|_| anyhow!("store lock poisoned"))?
        .set_setting(HOTKEY_SETTING, text.as_deref().unwrap_or(""))?;
    let mut hk = lock(&state.hotkey)?;
    hk.chosen = text;
    hk.registered = new;
    hk.error = None;
    Ok(())
}

fn lock(m: &Mutex<Hotkey>) -> Result<std::sync::MutexGuard<'_, Hotkey>> {
    m.lock().map_err(|_| anyhow!("hotkey lock poisoned"))
}

/// The tray's "Pause hotkey": a game or a remote desktop session may want the key for a while.
pub fn toggle_pause(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let Ok(mut hk) = state.hotkey.lock() else { return false };
    hk.paused = !hk.paused;
    hk.paused
}

pub fn set_autostart(app: &AppHandle, on: bool) -> Result<()> {
    let launcher = app.autolaunch();
    if on {
        launcher.enable().map_err(|e| anyhow!("{e}"))
    } else {
        launcher.disable().map_err(|e| anyhow!("{e}"))
    }
}

pub fn settings(app: &AppHandle) -> DesktopSettings {
    let state = app.state::<AppState>();
    let (hotkey, active, paused, error) = match state.hotkey.lock() {
        Ok(h) => (h.chosen.clone(), h.registered.is_some() && !h.paused, h.paused, h.error.clone()),
        Err(_) => (None, false, false, Some("hotkey lock poisoned".into())),
    };
    let (autostart, autostart_error) = match app.autolaunch().is_enabled() {
        Ok(on) => (on, None),
        Err(e) => (false, Some(e.to_string())),
    };
    DesktopSettings {
        hotkey,
        hotkey_default: DEFAULT_HOTKEY,
        hotkey_active: active,
        hotkey_paused: paused,
        hotkey_error: error,
        hotkey_supported: hotkey_supported(),
        autostart,
        autostart_error,
    }
}

/// Start hidden only when there is a tray to come back from.
pub fn start_hidden(app: &AppHandle, args: &[String]) -> bool {
    wants_hidden(args) && app.state::<AppState>().tray.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_what_the_settings_write() {
        for ok in [DEFAULT_HOTKEY, "Ctrl+Shift+N", "Alt+Shift+F2", "Ctrl+Alt+ArrowUp"] {
            assert!(parse(ok).is_ok(), "{ok}");
        }
        assert!(parse("N").is_err(), "a bare key");
        assert!(parse("Ctrl+Nope").is_err());
    }

    #[test]
    fn hidden_flag() {
        assert!(wants_hidden(&["petrel".into(), "--hidden".into()]));
        assert!(!wants_hidden(&["--hidden".into()]));
    }
}
