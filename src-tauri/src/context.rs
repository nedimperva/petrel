//! What you were looking at when you pressed the capture key: the text selected there and the window it was in,
//! so a capture can bring the quote and where it came from. Read once, before the capture window takes the focus,
//! and handed to that window once (`capture_context`). Nothing is sent anywhere; it only lands in the capture,
//! where it can be deleted like any other text.
//!
//! Windows reads the selection through UI Automation (no key presses are faked, the clipboard is not touched,
//! password fields are skipped). Linux reads the primary selection, which only holds what was selected, and asks
//! Hyprland which window was active. Either side may know nothing, and then the capture is just empty.

use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

/// Longest quote taken; a whole page selected by mistake is not a quote.
const QUOTE_MAX: usize = 4_000;
/// How long the capture window waits for the selection before it opens without one.
const WAIT: Duration = Duration::from_millis(400);

/// The context on its way, and the primary selection Linux saw (for the next capture's stale check).
pub type Pending = mpsc::Receiver<(CaptureContext, Option<String>)>;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureContext {
    /// The selected text, trimmed.
    pub text: Option<String>,
    /// The app, in words: `Firefox`, `Code`.
    pub app: Option<String>,
    /// The window's title without the app's name at the end: usually the page or document.
    pub title: Option<String>,
}

/// Starts reading the context. The window's name is read now, while the other app is still in front; the
/// selection may take longer and arrives on the channel.
pub fn start(last_primary: Option<String>) -> Pending {
    let (tx, rx) = mpsc::channel();
    let (app, title, own) = platform::front_window();
    if own {
        let _ = tx.send((CaptureContext::default(), last_primary));
        return rx;
    }
    std::thread::spawn(move || {
        let (text, primary) = platform::selection(last_primary);
        let text = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty() && t.len() <= QUOTE_MAX);
        let title = match (&title, &app) {
            (Some(t), Some(a)) => Some(strip_app(t, a)),
            _ => title,
        }
        .filter(|t| !t.is_empty());
        let _ = tx.send((CaptureContext { text, app, title }, primary));
    });
    rx
}

/// Waits a little for what `start` reads.
pub fn wait(
    rx: &mpsc::Receiver<(CaptureContext, Option<String>)>,
) -> Option<(CaptureContext, Option<String>)> {
    rx.recv_timeout(WAIT).ok()
}

/// `The Bread Book — Mozilla Firefox` → `The Bread Book`: browsers and editors end their titles with their name.
fn strip_app(title: &str, app: &str) -> String {
    let t = title.trim();
    for sep in [" — ", " – ", " - ", " | "] {
        if let Some((head, last)) = t.rsplit_once(sep) {
            let l = last.to_lowercase();
            let a = app.to_lowercase();
            if l.contains(&a) || a.contains(&l) || l.starts_with("mozilla") || l.starts_with("google") {
                return head.trim().to_string();
            }
        }
    }
    t.to_string()
}

/// An executable's name in words: `firefox.exe` → `Firefox`, `msedge` → `Edge`.
fn app_name(exe: &str) -> String {
    let stem = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    let stem = stem.strip_suffix(".exe").or_else(|| stem.strip_suffix(".EXE")).unwrap_or(stem);
    let known = [
        ("msedge", "Edge"),
        ("chrome", "Chrome"),
        ("firefox", "Firefox"),
        ("code", "Code"),
        ("winword", "Word"),
        ("excel", "Excel"),
        ("outlook", "Outlook"),
        ("olk", "Outlook"),
        ("acrord32", "Acrobat"),
        ("explorer", "Explorer"),
        ("windowsterminal", "Terminal"),
        ("obsidian", "Obsidian"),
        ("thunderbird", "Thunderbird"),
        ("zen", "Zen"),
        ("brave", "Brave"),
    ];
    let low = stem.to_lowercase();
    if let Some((_, n)) = known.iter().find(|(k, _)| low == *k || low.ends_with(&format!(".{k}"))) {
        return (*n).to_string();
    }
    // `org.gnome.Nautilus` → `Nautilus`
    let last = stem.rsplit('.').next().unwrap_or(stem);
    let mut c = last.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

#[cfg(windows)]
mod platform {
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    /// The app and title of the window in front, and whether it is one of Petrel's own.
    pub fn front_window() -> (Option<String>, Option<String>, bool) {
        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.is_invalid() {
                return (None, None, false);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == std::process::id() {
                return (None, None, true);
            }
            let mut buf = [0u16; 512];
            let n = GetWindowTextW(hwnd, &mut buf);
            let title = (n > 0).then(|| String::from_utf16_lossy(&buf[..n as usize]));
            (exe_of(pid).map(|e| super::app_name(&e)), title, false)
        }
    }

    unsafe fn exe_of(pid: u32) -> Option<String> {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            h,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(h);
        ok.ok().map(|_| String::from_utf16_lossy(&buf[..len as usize]))
    }

    /// The focused control's selected text, through UI Automation. Password fields and Petrel's own windows give
    /// nothing. The second value is for Linux's stale-selection check and unused here.
    pub fn selection(_last: Option<String>) -> (Option<String>, Option<String>) {
        unsafe {
            let inited = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let text = (|| -> windows::core::Result<Option<String>> {
                let ua: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
                let el = ua.GetFocusedElement()?;
                if el.CurrentProcessId()? as u32 == std::process::id() || el.CurrentIsPassword()?.as_bool() {
                    return Ok(None);
                }
                let pattern: IUIAutomationTextPattern = el.GetCurrentPatternAs(UIA_TextPatternId)?;
                let ranges = pattern.GetSelection()?;
                let mut out = String::new();
                for i in 0..ranges.Length()? {
                    let t = ranges.GetElement(i)?.GetText((super::QUOTE_MAX + 1) as i32)?;
                    out.push_str(&t.to_string());
                }
                Ok(Some(out))
            })()
            .ok()
            .flatten();
            // The interface pointers were dropped inside the closure, before COM goes.
            if inited {
                CoUninitialize();
            }
            (text, None)
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    /// Hyprland knows the active window; other desktops are not asked.
    pub fn front_window() -> (Option<String>, Option<String>, bool) {
        if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none() {
            return (None, None, false);
        }
        let Ok(out) = std::process::Command::new("hyprctl").args(["activewindow", "-j"]).output() else {
            return (None, None, false);
        };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
            return (None, None, false);
        };
        let class = v["class"].as_str().unwrap_or("").to_string();
        let title = v["title"].as_str().map(str::to_string);
        if class.to_lowercase().contains("petrel") || v["pid"].as_u64() == Some(std::process::id() as u64) {
            return (None, None, true);
        }
        ((!class.is_empty()).then(|| super::app_name(&class)), title, false)
    }

    /// The primary selection: what is selected now, or what was selected last. The second value is what it
    /// held, kept so the same old selection is not brought into the next capture too.
    pub fn selection(last: Option<String>) -> (Option<String>, Option<String>) {
        use arboard::{GetExtLinux, LinuxClipboardKind};
        let now = arboard::Clipboard::new()
            .ok()
            .and_then(|mut c| c.get().clipboard(LinuxClipboardKind::Primary).text().ok());
        match now {
            Some(t) if Some(&t) != last.as_ref() => (Some(t.clone()), Some(t)),
            other => (None, other.or(last)),
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    pub fn front_window() -> (Option<String>, Option<String>, bool) {
        (None, None, false)
    }
    pub fn selection(last: Option<String>) -> (Option<String>, Option<String>) {
        (None, last)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_and_names() {
        assert_eq!(strip_app("The Bread Book — Mozilla Firefox", "Firefox"), "The Bread Book");
        assert_eq!(strip_app("main.rs - petrel - Visual Studio Code", "Code"), "main.rs - petrel");
        assert_eq!(
            strip_app("Inbox (3) - me@example.com - Gmail - Google Chrome", "Chrome"),
            "Inbox (3) - me@example.com - Gmail"
        );
        assert_eq!(strip_app("Notes", "Obsidian"), "Notes");
        assert_eq!(app_name(r"C:\Program Files\Mozilla Firefox\firefox.exe"), "Firefox");
        assert_eq!(app_name("msedge.exe"), "Edge");
        assert_eq!(app_name("org.gnome.Nautilus"), "Nautilus");
        assert_eq!(app_name("kitty"), "Kitty");
    }
}
