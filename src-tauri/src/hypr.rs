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

/// The Lua dispatches for one window, given what Hyprland says about it. Omarchy runs Hyprland 0.56, which takes
/// `hl.dsp.*` expressions and rejects the old `setfloating`/`resizewindowpixel` syntax. Floating comes first:
/// Hyprland refuses to pin a tiled window. `pin` is sent only when the window is not pinned yet.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn commands(address: &str, floating: bool, pinned: bool, width: u32, height: u32) -> Vec<String> {
    let window = format!("address:{address}");
    let mut out = Vec::new();
    if !floating {
        out.push(format!(r#"hl.dsp.window.float({{ action = "on", window = "{window}" }})"#));
    }
    out.push(format!(
        r#"hl.dsp.window.resize({{ x = {width}, y = {height}, relative = false, window = "{window}" }})"#
    ));
    out.push(format!(r#"hl.dsp.window.center({{ window = "{window}" }})"#));
    out.push(format!(r#"hl.dsp.focus({{ window = "{window}" }})"#));
    if !pinned {
        out.push(format!(r#"hl.dsp.window.pin({{ action = "on", window = "{window}" }})"#));
    }
    out
}

#[cfg(target_os = "linux")]
mod linux {
    use std::process::Command;
    use std::time::Duration;

    use anyhow::{bail, Context, Result};
    use serde_json::Value;

    pub fn arrange(title: &str, width: u32, height: u32) -> Result<()> {
        let me = u64::from(std::process::id());
        // The window is mapped a moment after Tauri shows it; a first webview can take a few seconds.
        for _ in 0..100 {
            let out = Command::new("hyprctl").args(["clients", "-j"]).output().context("running hyprctl")?;
            let clients: Value = serde_json::from_slice(&out.stdout).context("reading hyprctl clients")?;
            let list = clients.as_array().cloned().unwrap_or_default();
            // Ours by pid when Hyprland says so; by title alone otherwise (some setups report the webview's pid).
            // The webview may retitle the window from the page: the title it opened with counts too.
            let named = |c: &&Value| c["title"] == title || c["initialTitle"] == title;
            let found = list
                .iter()
                .find(|c| named(c) && c["pid"].as_u64() == Some(me))
                .or_else(|| list.iter().find(named));
            if let Some(c) = found {
                let address = c["address"].as_str().context("a client without an address")?;
                let cmds = super::commands(
                    address,
                    c["floating"].as_bool().unwrap_or(false),
                    c["pinned"].as_bool().unwrap_or(false),
                    width,
                    height,
                );
                for cmd in &cmds {
                    // Hyprland's Lua answers a failed dispatch with "error: ..." on stdout, and hyprctl still exits 0.
                    let out = Command::new("hyprctl").args(["dispatch", cmd]).output()?;
                    let said = String::from_utf8_lossy(&out.stdout).trim().replace('\n', " ");
                    log::info!("hyprctl dispatch {cmd} -> {said}");
                    if !out.status.success() || said.contains("error") {
                        bail!("hyprctl dispatch {cmd} said {}: {said}", out.status);
                    }
                }
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        bail!("no window called {title} appeared in hyprctl clients within 5 s")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn floats_then_pins_only_once() {
        let c = super::commands("0xabc", false, false, 620, 440);
        assert!(c[0].starts_with(r#"hl.dsp.window.float({ action = "on", window = "address:0xabc" })"#));
        assert!(c.contains(
            &r#"hl.dsp.window.resize({ x = 620, y = 440, relative = false, window = "address:0xabc" })"#
                .to_string()
        ));
        assert!(c.last().unwrap().starts_with(r#"hl.dsp.window.pin({ action = "on""#));
        let again = super::commands("0xabc", true, true, 620, 440);
        assert!(!again.iter().any(|c| c.contains("float(") || c.contains("pin(")));
    }
}
