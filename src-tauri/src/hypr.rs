//! Hyprland (Omarchy) tiles every new window, and its window-rule syntax changed between releases, so a rule in
//! the README is not enough. When the capture window or the picker is shown under Hyprland, Petrel asks it
//! directly (`hyprctl`) to float the window, size it, centre it and pin it, so it shows on every workspace and
//! stays above the tiled windows. Nothing happens anywhere else, or if `hyprctl` is missing.

/// Arranges the window with this title, once it is mapped. Runs in the background; failures are logged.
pub fn arrange(title: &'static str, width: u32, height: u32) {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none() {
            return;
        }
        std::thread::spawn(move || {
            if let Err(e) = linux::arrange(title, width, height) {
                log::warn!("arranging {title} on Hyprland: {e:#}");
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (title, width, height);
}

/// The dispatches for one window, given what Hyprland says about it. `pin` toggles, so it is sent only when the
/// window is not pinned yet.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn batch(address: &str, floating: bool, pinned: bool, width: u32, height: u32) -> String {
    let mut out = Vec::new();
    if !floating {
        out.push(format!("dispatch setfloating address:{address}"));
    }
    out.push(format!("dispatch resizewindowpixel exact {width} {height},address:{address}"));
    out.push(format!("dispatch focuswindow address:{address}"));
    out.push("dispatch centerwindow".to_string());
    if !pinned {
        out.push(format!("dispatch pin address:{address}"));
    }
    out.join(" ; ")
}

#[cfg(target_os = "linux")]
mod linux {
    use std::process::Command;
    use std::time::Duration;

    use anyhow::{bail, Context, Result};
    use serde_json::Value;

    pub fn arrange(title: &str, width: u32, height: u32) -> Result<()> {
        // The window is mapped a moment after Tauri shows it.
        for _ in 0..20 {
            let out = Command::new("hyprctl").args(["clients", "-j"]).output().context("running hyprctl")?;
            let clients: Value = serde_json::from_slice(&out.stdout).context("reading hyprctl clients")?;
            let found = clients.as_array().and_then(|cs| {
                cs.iter()
                    .find(|c| c["title"] == title && c["pid"].as_u64() == Some(u64::from(std::process::id())))
            });
            if let Some(c) = found {
                let address = c["address"].as_str().context("a client without an address")?;
                let cmd = super::batch(
                    address,
                    c["floating"].as_bool().unwrap_or(false),
                    c["pinned"].as_bool().unwrap_or(false),
                    width,
                    height,
                );
                let status = Command::new("hyprctl").args(["--batch", &cmd]).status()?;
                if !status.success() {
                    bail!("hyprctl said {status}");
                }
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        bail!("no window called {title} appeared")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn pins_only_once() {
        let b = super::batch("0xabc", false, false, 620, 440);
        assert!(b.starts_with("dispatch setfloating address:0xabc ; "));
        assert!(b.contains("resizewindowpixel exact 620 440,address:0xabc"));
        assert!(b.ends_with("dispatch pin address:0xabc"));
        let again = super::batch("0xabc", true, true, 620, 440);
        assert!(!again.contains("setfloating") && !again.contains("pin "));
    }
}
