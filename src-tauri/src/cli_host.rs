//! The terminal's `Host`, for `petrel run` (package 07). Files and commands are the same as in the window
//! (`petrel_core::host::system`). Anything that needs the person (the trust dialog, a confirm, a prompt) asks
//! on the terminal; when there is no terminal (a script, a pipe), it answers no, so a run from cron never
//! trusts an action or a path on its own. A preview needs the window and stops the run.

use std::io::{BufRead, IsTerminal, Write};
use std::path::Path;

use anyhow::{anyhow, Result};
use petrel_core::host::{
    system, CancelToken, Command, CommandOutput, FieldKind, Host, MessageKind, PromptReply, PromptSpec,
    ScopeItem, WriteMode,
};

pub struct CliHost {
    /// Questions go to stderr and answers come from stdin, only when both are a terminal.
    interactive: bool,
    #[cfg(not(target_os = "linux"))]
    clipboard: Option<arboard::Clipboard>,
}

impl CliHost {
    pub fn new() -> CliHost {
        CliHost {
            interactive: std::io::stdin().is_terminal() && std::io::stderr().is_terminal(),
            #[cfg(not(target_os = "linux"))]
            clipboard: None,
        }
    }

    /// One line from the terminal, trimmed. `None` with no terminal or at end of input.
    fn ask(&self, question: &str) -> Option<String> {
        if !self.interactive {
            return None;
        }
        eprint!("{question}");
        let _ = std::io::stderr().flush();
        let mut line = String::new();
        match std::io::stdin().lock().read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(line.trim_end_matches(['\r', '\n']).to_string()),
        }
    }

    fn yes(&self, question: &str) -> bool {
        self.ask(&format!("{question} [y/N] "))
            .is_some_and(|a| matches!(a.trim().to_ascii_lowercase().as_str(), "y" | "yes"))
    }

    #[cfg(not(target_os = "linux"))]
    fn clipboard(&mut self) -> Result<&mut arboard::Clipboard> {
        if self.clipboard.is_none() {
            self.clipboard = Some(arboard::Clipboard::new().map_err(|e| anyhow!("no clipboard: {e}"))?);
        }
        Ok(self.clipboard.as_mut().expect("set above"))
    }
}

/// On Linux the copied text is served by the process that copied it, and `petrel run` exits at once. So the
/// clipboard goes through `wl-copy` or `xclip`, which stay behind to serve it.
#[cfg(target_os = "linux")]
mod linux_clipboard {
    use super::*;
    use anyhow::bail;
    use std::process::{Command as Proc, Stdio};

    fn wayland() -> bool {
        std::env::var_os("WAYLAND_DISPLAY").is_some()
    }

    pub fn get() -> Result<String> {
        let out = if wayland() {
            Proc::new("wl-paste").arg("--no-newline").output()
        } else {
            Proc::new("xclip").args(["-selection", "clipboard", "-o"]).output()
        }
        .map_err(|e| anyhow!("reading the clipboard needs wl-clipboard (Wayland) or xclip (X11): {e}"))?;
        // An empty clipboard is a non-zero exit for both; that is not an error for a step.
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub fn set(text: &str) -> Result<()> {
        let mut child = if wayland() {
            Proc::new("wl-copy").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
        } else {
            Proc::new("xclip")
                .args(["-selection", "clipboard", "-i"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
        }
        .map_err(|e| anyhow!("copying needs wl-clipboard (Wayland) or xclip (X11): {e}"))?;
        child.stdin.take().expect("piped").write_all(text.as_bytes())?;
        // Both fork a server and exit once they have the text.
        let status = child.wait()?;
        if !status.success() {
            bail!("the clipboard tool failed ({status})");
        }
        Ok(())
    }
}

impl Host for CliHost {
    fn clipboard_get(&mut self) -> Result<String> {
        #[cfg(target_os = "linux")]
        return linux_clipboard::get();
        #[cfg(not(target_os = "linux"))]
        match self.clipboard()?.get_text() {
            Ok(t) => Ok(t),
            Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
            Err(e) => Err(anyhow!("clipboard: {e}")),
        }
    }

    fn clipboard_set(&mut self, text: &str) -> Result<()> {
        #[cfg(target_os = "linux")]
        return linux_clipboard::set(text);
        #[cfg(not(target_os = "linux"))]
        self.clipboard()?.set_text(text).map_err(|e| anyhow!("clipboard: {e}"))
    }

    fn open_url(&mut self, url: &str, _browser: bool) -> Result<()> {
        open::that_detached(url).map_err(|e| anyhow!("opening {url}: {e}"))
    }

    fn read_file(&mut self, path: &Path) -> Result<Option<String>> {
        system::read_file(path)
    }

    fn write_file(&mut self, path: &Path, text: &str, mode: WriteMode, create_dirs: bool) -> Result<()> {
        system::write_file(path, text, mode, create_dirs)
    }

    fn run_command(&mut self, command: &Command, cancel: &CancelToken) -> Result<CommandOutput> {
        system::run_command(command, cancel)
    }

    fn confirm(&mut self, title: &str, message: &str) -> Result<bool> {
        let question = if message.is_empty() { title.to_string() } else { format!("{title}\n{message}\n") };
        Ok(self.yes(&question))
    }

    fn confirm_scope(&mut self, action: &str, items: &[ScopeItem]) -> Result<bool> {
        if !self.interactive {
            eprintln!(
                "petrel: \"{action}\" has not been trusted yet; run it once from a terminal or the app"
            );
            return Ok(false);
        }
        eprintln!("\"{action}\" will:");
        for item in items {
            match item {
                ScopeItem::Command(c) => eprintln!("  run   {c}"),
                ScopeItem::Path(p) => eprintln!("  write {p}"),
            }
        }
        Ok(self.yes("Run it, and trust it from now on?"))
    }

    fn prompt(&mut self, p: &PromptSpec) -> Result<Option<PromptReply>> {
        if !self.interactive {
            eprintln!("petrel: \"{}\" asks a question, and there is no terminal to answer it", p.title);
            return Ok(None);
        }
        if !p.title.is_empty() {
            eprintln!("{}", p.title);
        }
        if !p.message.is_empty() {
            eprintln!("{}", p.message);
        }
        let mut reply = PromptReply::default();
        for f in &p.fields {
            let label = if f.label.is_empty() { &f.key } else { &f.label };
            let value = match f.kind {
                FieldKind::Switch => {
                    let on = f.default == "true";
                    let Some(a) = self.ask(&format!("{label} [{}] ", if on { "Y/n" } else { "y/N" })) else {
                        return Ok(None);
                    };
                    match a.trim().to_ascii_lowercase().as_str() {
                        "" => on,
                        a => a == "y" || a == "yes",
                    }
                    .to_string()
                }
                FieldKind::Select if !f.options.is_empty() => {
                    for (i, o) in f.options.iter().enumerate() {
                        eprintln!("  {}. {o}", i + 1);
                    }
                    let Some(a) = self.ask(&format!("{label} (number, Enter for {}) ", f.default)) else {
                        return Ok(None);
                    };
                    pick(&a, &f.options).unwrap_or_else(|| f.default.clone())
                }
                // A textarea is one line here; a script that needs more can pipe a file in instead.
                _ => {
                    let hint = if f.default.is_empty() { String::new() } else { format!(" [{}]", f.default) };
                    let Some(a) = self.ask(&format!("{label}{hint}: ")) else { return Ok(None) };
                    if a.is_empty() {
                        f.default.clone()
                    } else {
                        a
                    }
                }
            };
            reply.values.insert(f.key.clone(), value);
        }
        reply.button = match p.buttons.len() {
            0 => "OK".into(),
            1 => p.buttons[0].clone(),
            _ => {
                for (i, b) in p.buttons.iter().enumerate() {
                    eprintln!("  {}. {b}", i + 1);
                }
                let Some(a) = self.ask("Choose (number, Enter for 1) ") else { return Ok(None) };
                if a.trim().is_empty() {
                    p.buttons[0].clone()
                } else {
                    match pick(&a, &p.buttons) {
                        Some(b) => b,
                        None => return Ok(None),
                    }
                }
            }
        };
        Ok(Some(reply))
    }

    fn preview(&mut self, _html: &str, _css: &str, _continue_button: bool) -> Result<bool> {
        eprintln!("petrel: a preview step needs the window; the run stops here");
        Ok(false)
    }

    fn message(&mut self, kind: MessageKind, text: &str) {
        // The outcome is printed by `run` itself.
        if matches!(kind, MessageKind::Info | MessageKind::Warning) {
            eprintln!("{text}");
        }
    }
}

/// `"2"` → the second option; an option's own text also counts.
fn pick(answer: &str, options: &[String]) -> Option<String> {
    let a = answer.trim();
    if let Ok(n) = a.parse::<usize>() {
        return options.get(n.checked_sub(1)?).cloned();
    }
    options.iter().find(|o| o.eq_ignore_ascii_case(a)).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_takes_a_number_or_the_text() {
        let o = vec!["Work".to_string(), "Home".to_string()];
        assert_eq!(pick("2", &o).as_deref(), Some("Home"));
        assert_eq!(pick(" home ", &o).as_deref(), Some("Home"));
        assert_eq!(pick("0", &o), None);
        assert_eq!(pick("3", &o), None);
        assert_eq!(pick("garden", &o), None);
    }

    #[test]
    fn with_no_terminal_nothing_is_trusted_or_answered() {
        let mut h = CliHost {
            interactive: false,
            #[cfg(not(target_os = "linux"))]
            clipboard: None,
        };
        assert!(!h.confirm_scope("Run command", &[ScopeItem::Command("rm -rf ~".into())]).unwrap());
        assert!(!h.confirm("Delete?", "").unwrap());
        let spec = PromptSpec { title: "Where?".into(), buttons: vec!["OK".into()], ..Default::default() };
        assert_eq!(h.prompt(&spec).unwrap(), None);
        assert!(!h.preview("<p>x</p>", "", true).unwrap());
    }
}
