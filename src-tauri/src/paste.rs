//! The picker's Ctrl Enter: after the copy, the picker goes away and Petrel presses Ctrl V in the app that was
//! in front (Ctrl Shift V with Shift, for a terminal). Windows sends the keys with `SendInput`; Linux asks
//! `wtype` on Wayland and `xdotool` on X11, since a Wayland app cannot type into another one by itself.

use std::time::Duration;

/// Hides the picker, waits for the app it came from to have the keyboard again, and pastes there.
#[tauri::command]
pub async fn paste_into_front(app: tauri::AppHandle, shift: bool) -> Result<(), String> {
    crate::warm::hide(&app, "picker");
    tauri::async_runtime::spawn_blocking(move || {
        // The window manager gives focus back on its own; this is the time it takes, with room to spare.
        std::thread::sleep(Duration::from_millis(180));
        press(shift)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn press(shift: bool) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY, VK_CONTROL, VK_SHIFT,
    };
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let v = VIRTUAL_KEY(b'V' as u16);
    let mut keys = vec![key(VK_CONTROL, false)];
    if shift {
        keys.push(key(VK_SHIFT, false));
    }
    keys.extend([key(v, false), key(v, true)]);
    if shift {
        keys.push(key(VK_SHIFT, true));
    }
    keys.push(key(VK_CONTROL, true));
    let sent = unsafe { SendInput(&keys, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == keys.len() {
        Ok(())
    } else {
        Err("Windows did not take the keys. It is copied; press Ctrl V.".into())
    }
}

#[cfg(target_os = "linux")]
fn press(shift: bool) -> Result<(), String> {
    use std::process::Command;
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    let run = if wayland {
        let mut c = Command::new("wtype");
        c.args(["-M", "ctrl"]);
        if shift {
            c.args(["-M", "shift"]);
        }
        c.args(["-k", "v"]);
        if shift {
            c.args(["-m", "shift"]);
        }
        c.args(["-m", "ctrl"]);
        c.status()
    } else {
        Command::new("xdotool")
            .args(["key", "--clearmodifiers", if shift { "ctrl+shift+v" } else { "ctrl+v" }])
            .status()
    };
    match run {
        Ok(s) if s.success() => Ok(()),
        Ok(_) => Err("Could not paste. It is copied; press Ctrl V.".into()),
        Err(_) => Err(format!(
            "Pasting needs {} installed. It is copied; press Ctrl V.",
            if wayland { "wtype" } else { "xdotool" }
        )),
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
fn press(_shift: bool) -> Result<(), String> {
    Err("It is copied; press Ctrl V.".into())
}
