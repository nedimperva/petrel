//! What you were looking at when you pressed the capture key: the text selected there and the window it was in,
//! so a capture can bring the quote and where it came from. Read once, before the capture window takes the focus,
//! and handed to that window once (`capture_context`). Nothing is sent anywhere; it only lands in the capture,
//! where it can be deleted like any other text.
//!
//! Windows reads the selection through UI Automation (no key presses are faked, the clipboard is not touched,
//! password fields are skipped), and in a browser the page's address from its address bar. Linux reads the primary
//! selection, which only holds what was selected, and asks Hyprland which window was active; it has no address.
//! Either side may know nothing, and then the capture is just empty.

use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

/// Longest quote taken; a whole page selected by mistake is not a quote.
const QUOTE_MAX: usize = 4_000;
/// How long the capture window waits for the selection and the address before it opens without them.
const WAIT: Duration = Duration::from_millis(700);
/// Browsers whose address bar is read for the page's link.
const BROWSERS: &[&str] = &["Firefox", "Chrome", "Edge", "Brave", "Zen", "Opera", "Vivaldi"];

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
    /// The page's address, when the window is a browser and its address bar could be read.
    pub link: Option<String>,
}

/// Starts reading the context. The window's name is read now, while the other app is still in front; the
/// selection may take longer and arrives on the channel.
pub fn start(last_primary: Option<String>) -> Pending {
    let (tx, rx) = mpsc::channel();
    let (app, title, own, handle) = platform::front_window();
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
        let browser = app.as_deref().is_some_and(|a| BROWSERS.contains(&a));
        let link = if browser { platform::address(handle).and_then(|a| as_url(&a)) } else { None };
        let _ = tx.send((CaptureContext { text, app, title, link }, primary));
    });
    rx
}

/// Waits a little for what `start` reads.
pub fn wait(rx: &Pending) -> Option<(CaptureContext, Option<String>)> {
    rx.recv_timeout(WAIT).ok()
}

/// What an address bar holds, as a link: browsers hide `https://`, so a bare host gets it back. A search typed
/// there (spaces, no dot) is not an address.
fn as_url(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() || s.len() > 2048 || s.chars().any(char::is_whitespace) {
        return None;
    }
    let low = s.to_lowercase();
    if ["http://", "https://", "file://"].iter().any(|p| low.starts_with(p)) {
        return Some(s.to_string());
    }
    let host = low.split(['/', '?', '#']).next().unwrap_or("");
    let hosty = host.contains('.') && host.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c));
    hosty.then(|| format!("https://{s}"))
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
        CUIAutomation, IUIAutomation, IUIAutomationTextPattern, IUIAutomationValuePattern,
        UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_TextPatternId, UIA_ValuePatternId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    /// The app and title of the window in front, whether it is one of Petrel's own, and its handle (for the
    /// address bar).
    pub fn front_window() -> (Option<String>, Option<String>, bool, isize) {
        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.is_invalid() {
                return (None, None, false, 0);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == std::process::id() {
                return (None, None, true, 0);
            }
            let mut buf = [0u16; 512];
            let n = GetWindowTextW(hwnd, &mut buf);
            let title = (n > 0).then(|| String::from_utf16_lossy(&buf[..n as usize]));
            (exe_of(pid).map(|e| super::app_name(&e)), title, false, hwnd.0 as isize)
        }
    }

    /// A browser's address bar: the first edit field in the window outside the page itself. The walk is short
    /// (a few hundred elements, a quarter of a second) and never goes into the page, which can be huge.
    pub fn address(handle: isize) -> Option<String> {
        if handle == 0 {
            return None;
        }
        unsafe {
            let inited = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let found = (|| -> windows::core::Result<Option<String>> {
                let ua: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
                let walker = ua.ControlViewWalker()?;
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
                let mut stack = vec![ua.ElementFromHandle(HWND(handle as *mut _))?];
                let mut seen = 0;
                while let Some(el) = stack.pop() {
                    seen += 1;
                    if seen > 400 || std::time::Instant::now() > deadline {
                        break;
                    }
                    let kind = el.CurrentControlType()?;
                    if kind == UIA_DocumentControlTypeId {
                        continue;
                    }
                    if kind == UIA_EditControlTypeId {
                        if let Ok(v) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        {
                            let text = v.CurrentValue()?.to_string();
                            if super::as_url(&text).is_some() {
                                return Ok(Some(text));
                            }
                        }
                        continue;
                    }
                    let mut kids = Vec::new();
                    let mut next = walker.GetFirstChildElement(&el).ok();
                    while let Some(k) = next {
                        next = walker.GetNextSiblingElement(&k).ok();
                        kids.push(k);
                    }
                    stack.extend(kids.into_iter().rev());
                }
                Ok(None)
            })()
            .ok()
            .flatten();
            if inited {
                CoUninitialize();
            }
            found
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
    pub fn front_window() -> (Option<String>, Option<String>, bool, isize) {
        if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none() {
            return (None, None, false, 0);
        }
        let Ok(out) = std::process::Command::new("hyprctl").args(["activewindow", "-j"]).output() else {
            return (None, None, false, 0);
        };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
            return (None, None, false, 0);
        };
        let class = v["class"].as_str().unwrap_or("").to_string();
        let title = v["title"].as_str().map(str::to_string);
        if class.to_lowercase().contains("petrel") || v["pid"].as_u64() == Some(std::process::id() as u64) {
            return (None, None, true, 0);
        }
        ((!class.is_empty()).then(|| super::app_name(&class)), title, false, 0)
    }

    /// No address bar to read on Linux.
    pub fn address(_handle: isize) -> Option<String> {
        None
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
    pub fn front_window() -> (Option<String>, Option<String>, bool, isize) {
        (None, None, false, 0)
    }
    pub fn address(_handle: isize) -> Option<String> {
        None
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

    #[test]
    fn addresses() {
        assert_eq!(as_url("example.com/bread?x=1").as_deref(), Some("https://example.com/bread?x=1"));
        assert_eq!(as_url("https://a.b/c").as_deref(), Some("https://a.b/c"));
        assert_eq!(as_url("localhost:5173").as_deref(), None);
        assert_eq!(as_url("sourdough recipe"), None);
        assert_eq!(as_url("sourdough"), None);
        assert_eq!(as_url(""), None);
    }
}
