//! The global hotkeys and start at login.
//!
//! One hotkey opens the capture window from anywhere, the other the quick picker. They work on Windows and X11.
//! On Wayland an app can't grab keys, so the compositor binds `petrel --capture` and `petrel --picker` instead
//! (README), and the settings say so.
//! Start at login launches `petrel --hidden`: Petrel waits in the tray, so the first capture is instant.

use std::str::FromStr;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::AppState;

/// Which window a hotkey opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Which {
    Capture,
    Picker,
}

impl Which {
    /// The setting: absent means the default, empty means off.
    fn setting(self) -> &'static str {
        match self {
            Which::Capture => "capture.hotkey",
            Which::Picker => "picker.hotkey",
        }
    }
    fn default(self) -> &'static str {
        match self {
            Which::Capture => DEFAULT_HOTKEY,
            Which::Picker => DEFAULT_PICKER_HOTKEY,
        }
    }
}
/// Ctrl+Alt is AltGr on Windows, and AltGr with a letter types a character on many layouts (AltGr+N is `}` on
/// Croatian and Bosnian ones). AltGr+Space types nothing on common layouts, and few apps use Ctrl+Alt+Space.
pub const DEFAULT_HOTKEY: &str = "Ctrl+Alt+Space";
/// Not Ctrl+Alt with a letter: that is AltGr, and AltGr+V is `@` on the Bosnian and Croatian layouts, so the
/// picker took every `@` typed anywhere. Shift needs no AltGr on any layout.
pub const DEFAULT_PICKER_HOTKEY: &str = "Ctrl+Shift+Space";
/// The picker's first default; a stored copy of it is read as the new default.
const OLD_PICKER_HOTKEY: &str = "Ctrl+Alt+V";
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
    picker_hotkey: Option<String>,
    picker_hotkey_default: &'static str,
    picker_hotkey_active: bool,
    picker_hotkey_error: Option<String>,
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

fn slot(state: &AppState, which: Which) -> &Mutex<Hotkey> {
    match which {
        Which::Capture => &state.hotkey,
        Which::Picker => &state.picker_hotkey,
    }
}

/// The chosen hotkey from the store, the default if never set.
fn stored_hotkey(app: &AppHandle, which: Which) -> Option<String> {
    let state = app.state::<AppState>();
    let stored = state.store.lock().ok().and_then(|s| s.setting(which.setting()).ok().flatten());
    match stored {
        None => Some(which.default().to_string()),
        Some(s) if s.trim().is_empty() => None,
        Some(s) if which == Which::Picker && s == OLD_PICKER_HOTKEY => Some(which.default().to_string()),
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

/// Registers the stored hotkeys at start. Failures are kept for the settings to show, never fatal.
pub fn init(app: &AppHandle) {
    for which in [Which::Capture, Which::Picker] {
        let chosen = stored_hotkey(app, which);
        let mut hk = Hotkey { chosen: chosen.clone(), ..Default::default() };
        if let Some(text) = chosen.filter(|_| hotkey_supported()) {
            match register(app, &text) {
                Ok(s) => hk.registered = Some(s),
                Err(e) => {
                    log::warn!("{which:?} hotkey {text}: {e:#}");
                    hk.error = Some(format!("{e:#}"));
                }
            }
        }
        slot(&app.state::<AppState>(), which).lock().map(|mut h| *h = hk).ok();
    }
}

fn register(app: &AppHandle, text: &str) -> Result<Shortcut> {
    let s = parse(text)?;
    app.global_shortcut()
        .register(s)
        .with_context(|| format!("{text} is taken by another app or the system"))?;
    Ok(s)
}

/// The plugin calls this for every registered key: the capture hotkey or the picker's.
pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    let st = app.state::<AppState>();
    let paused = st.hotkey.lock().map(|h| h.paused).unwrap_or(false);
    if paused {
        return;
    }
    let picker = st.picker_hotkey.lock().ok().and_then(|h| h.registered);
    if picker.as_ref() == Some(shortcut) {
        crate::open_picker(app);
    } else {
        crate::open_capture(app);
    }
}

/// Changes the hotkey (`None` or empty: off). The new one is registered before the old one goes, so a key that
/// is taken leaves the working one in place.
pub fn set_hotkey(app: &AppHandle, which: Which, text: Option<String>) -> Result<()> {
    let text = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let state = app.state::<AppState>();
    let other = match which {
        Which::Capture => Which::Picker,
        Which::Picker => Which::Capture,
    };
    if let Some(t) = &text {
        if lock(slot(&state, other))?.registered == Some(parse(t)?) {
            anyhow::bail!("{t} already opens the other window");
        }
    }
    let old = lock(slot(&state, which))?.registered;
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
        .set_setting(which.setting(), text.as_deref().unwrap_or(""))?;
    let mut hk = lock(slot(&state, which))?;
    hk.chosen = text;
    hk.registered = new;
    hk.error = None;
    Ok(())
}

fn lock(m: &Mutex<Hotkey>) -> Result<std::sync::MutexGuard<'_, Hotkey>> {
    m.lock().map_err(|_| anyhow!("hotkey lock poisoned"))
}

/// The tray's "Pause hotkeys": a game or a remote desktop session may want the keys for a while. Kept on the
/// capture slot; it pauses both.
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
    let (picker, picker_active, picker_error) = match state.picker_hotkey.lock() {
        Ok(h) => (h.chosen.clone(), h.registered.is_some() && !paused, h.error.clone()),
        Err(_) => (None, false, Some("hotkey lock poisoned".into())),
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
        picker_hotkey: picker,
        picker_hotkey_default: DEFAULT_PICKER_HOTKEY,
        picker_hotkey_active: picker_active,
        picker_hotkey_error: picker_error,
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
        for ok in [DEFAULT_HOTKEY, DEFAULT_PICKER_HOTKEY, "Ctrl+Shift+N", "Alt+Shift+F2", "Ctrl+Alt+ArrowUp"]
        {
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
