//! Everything an action touches outside the database goes through `Host` (docs/design/actions.md). The window
//! implements it with dialogs (`TauriHost`, package 03's UI slice), the CLI with the terminal (package 07), and
//! tests with `RecordingHost`. The `system` module holds the file and process code a real host shares.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

/// Set from any thread to stop a run; the engine checks it between steps and a running command is killed.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WriteMode {
    /// Fails if the file exists.
    #[default]
    Create,
    Append,
    Prepend,
    Overwrite,
}

/// `sh` by default on Linux, PowerShell on Windows (actions.md Decisions). `$SHELL` is the user's shell; `none`
/// runs the command's first word with the rest as arguments, without a shell.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shell {
    Sh,
    Bash,
    Zsh,
    Fish,
    #[serde(rename = "$SHELL")]
    Login,
    Powershell,
    Cmd,
    None,
}

impl Default for Shell {
    fn default() -> Shell {
        if cfg!(windows) {
            Shell::Powershell
        } else {
            Shell::Sh
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Command {
    pub command: String,
    pub stdin: String,
    pub shell: Shell,
    pub timeout: Duration,
    pub cwd: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommandOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageKind {
    Info,
    Success,
    Warning,
    Error,
}

/// What an untrusted action is about to do, shown once before it runs (actions.md "Trust").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "text", rename_all = "camelCase")]
pub enum ScopeItem {
    Command(String),
    Path(String),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldKind {
    #[default]
    Text,
    Textarea,
    Select,
    Switch,
    Date,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PromptField {
    pub key: String,
    pub kind: FieldKind,
    pub label: String,
    pub default: String,
    pub options: Vec<String>,
}

/// A `prompt` step, rendered.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSpec {
    pub title: String,
    pub message: String,
    pub buttons: Vec<String>,
    pub fields: Vec<PromptField>,
    pub cancel_button: bool,
}

/// The button pressed and each field's value; a switch is `"true"` or `"false"`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptReply {
    pub button: String,
    pub values: BTreeMap<String, String>,
}

pub trait Host {
    fn clipboard_get(&mut self) -> Result<String>;
    fn clipboard_set(&mut self, text: &str) -> Result<()>;
    /// `browser` asks for the web browser even when another app claims the URL's scheme.
    fn open_url(&mut self, url: &str, browser: bool) -> Result<()>;
    /// `None` when the file does not exist.
    fn read_file(&mut self, path: &Path) -> Result<Option<String>>;
    fn write_file(&mut self, path: &Path, text: &str, mode: WriteMode, create_dirs: bool) -> Result<()>;
    /// A non-zero exit is an `Ok` output; timing out or being cancelled is an error.
    fn run_command(&mut self, command: &Command, cancel: &CancelToken) -> Result<CommandOutput>;
    fn confirm(&mut self, title: &str, message: &str) -> Result<bool>;
    /// Shown once for an untrusted action; `true` runs it and trusts it.
    fn confirm_scope(&mut self, action: &str, items: &[ScopeItem]) -> Result<bool>;
    /// `None` when the prompt was dismissed.
    fn prompt(&mut self, prompt: &PromptSpec) -> Result<Option<PromptReply>>;
    /// Shows rendered HTML; `false` when it was closed instead of continued.
    fn preview(&mut self, html: &str, css: &str, continue_button: bool) -> Result<bool>;
    fn message(&mut self, kind: MessageKind, text: &str);
}

// ---- the recording host -------------------------------------------------------------------------------------

/// One thing an action asked of the host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Call {
    ClipboardSet(String),
    OpenUrl(String),
    WriteFile(PathBuf, WriteMode),
    RunCommand(Command),
    Confirm(String),
    ConfirmScope(String, Vec<ScopeItem>),
    Prompt(PromptSpec),
    Preview(String),
    Message(MessageKind, String),
}

/// A host with an in-memory clipboard and file system that records every call. Replies are queued; with none
/// queued it says yes, presses the first button, continues, and a command echoes its stdin.
#[derive(Default)]
pub struct RecordingHost {
    pub calls: Vec<Call>,
    pub clipboard: String,
    pub files: HashMap<PathBuf, String>,
    pub confirms: VecDeque<bool>,
    pub prompts: VecDeque<Option<PromptReply>>,
    pub previews: VecDeque<bool>,
    pub commands: VecDeque<Result<CommandOutput, String>>,
}

impl Host for RecordingHost {
    fn clipboard_get(&mut self) -> Result<String> {
        Ok(self.clipboard.clone())
    }

    fn clipboard_set(&mut self, text: &str) -> Result<()> {
        self.calls.push(Call::ClipboardSet(text.to_string()));
        self.clipboard = text.to_string();
        Ok(())
    }

    fn open_url(&mut self, url: &str, _browser: bool) -> Result<()> {
        self.calls.push(Call::OpenUrl(url.to_string()));
        Ok(())
    }

    fn read_file(&mut self, path: &Path) -> Result<Option<String>> {
        Ok(self.files.get(path).cloned())
    }

    fn write_file(&mut self, path: &Path, text: &str, mode: WriteMode, _create_dirs: bool) -> Result<()> {
        self.calls.push(Call::WriteFile(path.to_path_buf(), mode));
        let old = self.files.get(path).cloned();
        let new = combine(old, text, mode, path)?;
        self.files.insert(path.to_path_buf(), new);
        Ok(())
    }

    fn run_command(&mut self, command: &Command, _cancel: &CancelToken) -> Result<CommandOutput> {
        self.calls.push(Call::RunCommand(command.clone()));
        match self.commands.pop_front() {
            Some(Ok(out)) => Ok(out),
            Some(Err(e)) => bail!(e),
            None => Ok(CommandOutput { status: 0, stdout: command.stdin.clone(), stderr: String::new() }),
        }
    }

    fn confirm(&mut self, title: &str, _message: &str) -> Result<bool> {
        self.calls.push(Call::Confirm(title.to_string()));
        Ok(self.confirms.pop_front().unwrap_or(true))
    }

    fn confirm_scope(&mut self, action: &str, items: &[ScopeItem]) -> Result<bool> {
        self.calls.push(Call::ConfirmScope(action.to_string(), items.to_vec()));
        Ok(self.confirms.pop_front().unwrap_or(true))
    }

    fn prompt(&mut self, prompt: &PromptSpec) -> Result<Option<PromptReply>> {
        self.calls.push(Call::Prompt(prompt.clone()));
        Ok(self.prompts.pop_front().unwrap_or_else(|| {
            Some(PromptReply {
                button: prompt.buttons.first().cloned().unwrap_or_default(),
                values: prompt.fields.iter().map(|f| (f.key.clone(), f.default.clone())).collect(),
            })
        }))
    }

    fn preview(&mut self, html: &str, _css: &str, _continue_button: bool) -> Result<bool> {
        self.calls.push(Call::Preview(html.to_string()));
        Ok(self.previews.pop_front().unwrap_or(true))
    }

    fn message(&mut self, kind: MessageKind, text: &str) {
        self.calls.push(Call::Message(kind, text.to_string()));
    }
}

/// The file's new text for a write `mode`, given what is there (`None`: no file).
pub fn combine(old: Option<String>, text: &str, mode: WriteMode, path: &Path) -> Result<String> {
    Ok(match (mode, old) {
        (WriteMode::Create, Some(_)) => bail!("{} already exists", path.display()),
        (WriteMode::Append, Some(old)) => old + text,
        (WriteMode::Prepend, Some(old)) => text.to_string() + &old,
        _ => text.to_string(),
    })
}

// ---- real files and processes -------------------------------------------------------------------------------

pub mod system {
    use std::io::{Read, Write};
    use std::path::Path;
    use std::process::Stdio;
    use std::sync::RwLock;
    use std::time::{Duration, Instant};

    use anyhow::{anyhow, bail, Context, Result};

    use super::{combine, CancelToken, Command, CommandOutput, Shell, WriteMode};

    /// Output past this is dropped (actions.md: 1 MB cap).
    pub const OUTPUT_MAX: usize = 1 << 20;

    static PATH: RwLock<Option<String>> = RwLock::new(None);

    /// The `PATH` every command gets: the login shell's, so `~/.local/bin` and the like work from a desktop
    /// launch, where the session's `PATH` is often the bare system one (actions.md "Shell").
    pub fn use_path(path: Option<String>) {
        if let Ok(mut p) = PATH.write() {
            *p = path;
        }
    }

    pub fn command_path() -> Option<String> {
        PATH.read().ok().and_then(|p| p.clone())
    }

    /// Asks the login shell for its `PATH` (`$SHELL -l`). Slow (rc files, 50–300 ms), so the shell caches the
    /// answer and calls this off the start path. `None` on Windows, with no `$SHELL`, or when the answer does
    /// not look like a `PATH`.
    pub fn login_path() -> Option<String> {
        if cfg!(windows) {
            return None;
        }
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
        // A marker, because rc files may print things; fish keeps PATH as a list.
        let print = if shell.ends_with("fish") {
            "printf '\\n%s%s' __PETREL_PATH__ (string join : $PATH)"
        } else {
            "printf '\\n%s%s' __PETREL_PATH__ \"$PATH\""
        };
        let mut cmd = std::process::Command::new(&shell);
        cmd.args(["-l", "-c", print]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().ok()?;
        let out = child.stdout.take().map(|o| std::thread::spawn(move || read_capped(o)));
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                _ => {
                    kill(&mut child);
                    let _ = child.wait();
                    return None;
                }
            }
        }
        let text = out?.join().ok()?;
        let path = text.rsplit("__PETREL_PATH__").next()?.trim();
        (text.contains("__PETREL_PATH__") && path.contains('/')).then(|| path.to_string())
    }

    pub fn read_file(path: &Path) -> Result<Option<String>> {
        match std::fs::read_to_string(path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(anyhow!(e).context(format!("reading {}", path.display()))),
        }
    }

    /// Append is an append (no read); prepend reads and rewrites; create refuses an existing file atomically.
    pub fn write_file(path: &Path, text: &str, mode: WriteMode, create_dirs: bool) -> Result<()> {
        if create_dirs {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
            }
        }
        let ctx = || format!("writing {}", path.display());
        match mode {
            WriteMode::Create => {
                let mut f =
                    std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| {
                        if e.kind() == std::io::ErrorKind::AlreadyExists {
                            anyhow!("{} already exists", path.display())
                        } else {
                            anyhow!(e).context(ctx())
                        }
                    })?;
                f.write_all(text.as_bytes()).with_context(ctx)?;
            }
            WriteMode::Append => {
                let mut f =
                    std::fs::OpenOptions::new().append(true).create(true).open(path).with_context(ctx)?;
                f.write_all(text.as_bytes()).with_context(ctx)?;
            }
            WriteMode::Prepend | WriteMode::Overwrite => {
                let new = combine(read_file(path)?, text, mode, path)?;
                std::fs::write(path, new).with_context(ctx)?;
            }
        }
        Ok(())
    }

    fn program(command: &Command) -> Result<std::process::Command> {
        let shell = |name: &str, flag: &str| {
            let mut c = std::process::Command::new(name);
            c.arg(flag).arg(&command.command);
            c
        };
        Ok(match command.shell {
            Shell::Sh => shell("sh", "-c"),
            Shell::Bash => shell("bash", "-c"),
            Shell::Zsh => shell("zsh", "-c"),
            Shell::Fish => shell("fish", "-c"),
            Shell::Login => shell(&std::env::var("SHELL").unwrap_or_else(|_| "sh".into()), "-c"),
            Shell::Powershell => {
                let mut c = std::process::Command::new(if cfg!(windows) { "powershell" } else { "pwsh" });
                c.args(["-NoProfile", "-NonInteractive", "-Command", &command.command]);
                c
            }
            Shell::Cmd => shell("cmd", "/C"),
            Shell::None => {
                let mut words = command.command.split_whitespace();
                let Some(first) = words.next() else { bail!("the command is empty") };
                let mut c = std::process::Command::new(first);
                c.args(words);
                c
            }
        })
    }

    fn read_capped(mut from: impl Read) -> String {
        let mut kept = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match from.read(&mut buf) {
                Ok(0) | Err(_) => break,
                // Keep reading past the cap so the child never blocks on a full pipe.
                Ok(n) => kept.extend_from_slice(&buf[..n.min(OUTPUT_MAX.saturating_sub(kept.len()))]),
            }
        }
        String::from_utf8_lossy(&kept).into_owned()
    }

    /// Runs `command`, feeding `stdin`, until it exits, times out or is cancelled. A stopped command's whole
    /// process group is sent SIGTERM, then SIGKILL after half a second (Linux), or the tree is killed (Windows).
    pub fn run_command(command: &Command, cancel: &CancelToken) -> Result<CommandOutput> {
        let mut cmd = program(command)?;
        if let Some(path) = command_path() {
            cmd.env("PATH", path);
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(cwd) = &command.cwd {
            cmd.current_dir(cwd);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().with_context(|| format!("starting {}", command.command))?;
        let stdin = child.stdin.take();
        let text = command.stdin.clone();
        let feeder = std::thread::spawn(move || {
            if let Some(mut stdin) = stdin {
                // A command that does not read stdin closes the pipe; that is not an error.
                let _ = stdin.write_all(text.as_bytes());
            }
        });
        let out = child.stdout.take().map(|o| std::thread::spawn(move || read_capped(o)));
        let err = child.stderr.take().map(|e| std::thread::spawn(move || read_capped(e)));
        let started = Instant::now();
        let stopped = loop {
            if let Some(status) = child.try_wait()? {
                break Ok(status);
            }
            if cancel.is_cancelled() {
                break Err(anyhow!("cancelled"));
            }
            if started.elapsed() >= command.timeout {
                break Err(anyhow!("timed out after {} s", command.timeout.as_secs()));
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let status = match stopped {
            Ok(status) => status,
            Err(e) => {
                kill(&mut child);
                let _ = child.wait();
                return Err(e);
            }
        };
        let _ = feeder.join();
        let stdout = out.and_then(|t| t.join().ok()).unwrap_or_default();
        let stderr = err.and_then(|t| t.join().ok()).unwrap_or_default();
        Ok(CommandOutput { status: status.code().unwrap_or(-1), stdout, stderr })
    }

    #[cfg(unix)]
    fn kill(child: &mut std::process::Child) {
        let group = -(child.id() as i32);
        // SAFETY: plain signal calls on a process group this function's caller created.
        unsafe {
            libc::kill(group, libc::SIGTERM);
        }
        let until = Instant::now() + Duration::from_millis(500);
        while Instant::now() < until {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        unsafe {
            libc::kill(group, libc::SIGKILL);
        }
    }

    #[cfg(windows)]
    fn kill(child: &mut std::process::Child) {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .output();
        let _ = child.kill();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::system::*;
    use super::*;

    fn sh(cmd: &str, stdin: &str, secs: u64) -> Command {
        Command {
            command: cmd.to_string(),
            stdin: stdin.to_string(),
            shell: Shell::Sh,
            timeout: Duration::from_secs(secs),
            cwd: None,
        }
    }

    #[test]
    fn commands_get_stdin_and_report_exit_and_stderr() {
        let out = run_command(&sh("tr a-z A-Z", "hello", 5), &CancelToken::default()).unwrap();
        assert_eq!((out.status, out.stdout.as_str()), (0, "HELLO"));
        let out = run_command(&sh("echo oops >&2; exit 3", "", 5), &CancelToken::default()).unwrap();
        assert_eq!((out.status, out.stderr.trim()), (3, "oops"));
        let out = run_command(&sh("true", &"x".repeat(1 << 20), 5), &CancelToken::default()).unwrap();
        assert_eq!(out.status, 0, "a command that ignores a large stdin still finishes");
    }

    #[test]
    fn a_slow_command_is_stopped_with_its_children() {
        let t = std::time::Instant::now();
        let err = run_command(&sh("sleep 30 | cat", "", 1), &CancelToken::default()).unwrap_err();
        assert!(err.to_string().contains("timed out"), "{err}");
        assert!(t.elapsed() < Duration::from_secs(5), "the pipe's children were killed too");

        let cancel = CancelToken::default();
        let c = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            c.cancel();
        });
        let err = run_command(&sh("sleep 30", "", 60), &cancel).unwrap_err();
        assert_eq!(err.to_string(), "cancelled");
    }

    #[test]
    fn commands_get_the_login_path() {
        if let Some(p) = login_path() {
            assert!(p.contains('/') && !p.contains('\n'), "{p:?}");
        }
        let base = std::env::var("PATH").unwrap_or_default();
        use_path(Some(format!("{base}:/petrel-test")));
        let out = run_command(&sh("printf %s \"$PATH\"", "", 5), &CancelToken::default()).unwrap();
        use_path(None);
        assert!(out.stdout.ends_with(":/petrel-test"), "{}", out.stdout);
    }

    #[test]
    fn output_is_capped() {
        let out = run_command(&sh("head -c 3000000 /dev/zero", "", 10), &CancelToken::default()).unwrap();
        assert_eq!(out.stdout.len(), OUTPUT_MAX);
    }

    #[test]
    fn file_modes() {
        let dir = std::env::temp_dir().join(format!("petrel-host-{}", uuid::Uuid::new_v4()));
        let p = dir.join("a/b.md");
        write_file(&p, "one", WriteMode::Create, true).unwrap();
        assert!(write_file(&p, "two", WriteMode::Create, true).unwrap_err().to_string().contains("exists"));
        write_file(&p, "+end", WriteMode::Append, false).unwrap();
        write_file(&p, "start+", WriteMode::Prepend, false).unwrap();
        assert_eq!(read_file(&p).unwrap().unwrap(), "start+one+end");
        write_file(&p, "new", WriteMode::Overwrite, false).unwrap();
        assert_eq!(read_file(&p).unwrap().unwrap(), "new");
        assert_eq!(read_file(&dir.join("missing")).unwrap(), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
