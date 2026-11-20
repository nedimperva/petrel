//! The command line. Only what needs no window is handled here, before Tauri starts: `--new TEXT` and
//! `--stdin` write a capture file into `inbox/` and exit, so `git log -1 | petrel --stdin` never opens a window.
//! Everything else (`--capture`, `--picker`, a bare `petrel`) goes on to the app, where a second launch is
//! forwarded to the running one by the single-instance plugin.
//!
//! Hand-parsed rather than `clap`: a few flags do not earn a dependency on the launch path.

use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use petrel_core::Store;

/// The app identifier from `tauri.conf.json`; Tauri's app data directory is `<data dir>/<identifier>`.
pub const IDENTIFIER: &str = "io.github.nedimperva.petrel";

/// More than this from stdin is almost certainly a mistake (a binary piped in), not a note.
const STDIN_LIMIT: u64 = 16 * 1024 * 1024;

pub const HELP: &str = "\
Petrel: quick capture and notes, as Markdown files in one folder.

Usage:
  petrel                     open Petrel, or bring it to the front
  petrel --capture           open the capture window
  petrel --picker            open the quick picker (find a prompt or snippet, fill it in, copy)
  petrel --new TEXT          save TEXT as a capture in inbox/, no window
  petrel --stdin             save what is piped in as a capture in inbox/, no window
  petrel --hidden            start in the tray, no window (start at login uses this)
  petrel --help              this text

From a terminal, without a window:
  petrel find WORDS          notes that match, best first (--limit N)
  petrel read NAME           a note's text: a title, a path, today or 2026-11-19
  petrel add [@PLACE] TEXT   add to today (@today), a day, a collection (@Travel), a note (@Groceries)
                             or, with no place, the inbox
  petrel copy CARD [--blank NAME=VALUE]...
                             a card from a collection with its blanks filled, onto the clipboard
                             (--print writes it out instead)
  petrel mcp                 the MCP server for Claude Desktop and Claude Code (Settings, Claude)

Options for --new TEXT and --stdin:
  --tag NAME, -t NAME        tag the capture (repeatable, or comma-separated)

Examples:
  git log -1 | petrel --stdin --tag git
  petrel --new \"call the bank about the card\"

PETREL_DB=path uses another database (and, unless a folder was picked, notes next to it).";

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    /// Start (or forward to) the app.
    App,
    Help,
    /// Write a capture without a window. `None` text means read stdin.
    Write {
        text: Option<String>,
        tags: Vec<String>,
    },
    Find {
        text: String,
        limit: usize,
    },
    Read {
        name: String,
    },
    /// `place` is empty for the inbox.
    Add {
        place: String,
        text: String,
    },
    Copy {
        card: String,
        blanks: Vec<(String, String)>,
        print: bool,
    },
    Mcp,
}

/// `find`, `read`, `add`, `copy` and `mcp`: the words after the program name.
fn parse_sub(sub: &str, rest: &[String]) -> Result<Command> {
    let words =
        |from: &[String]| from.iter().filter(|w| w.as_str() != "--").cloned().collect::<Vec<_>>().join(" ");
    match sub {
        "find" => {
            let mut limit = 10;
            let mut text = Vec::new();
            let mut it = rest.iter();
            while let Some(a) = it.next() {
                if a == "--limit" || a == "-l" {
                    limit = it
                        .next()
                        .and_then(|n| n.parse().ok())
                        .ok_or_else(|| anyhow::anyhow!("--limit needs a number"))?;
                } else {
                    text.push(a.clone());
                }
            }
            if text.is_empty() {
                bail!("find needs words to look for");
            }
            Ok(Command::Find { text: words(&text), limit })
        }
        "read" if !rest.is_empty() => Ok(Command::Read { name: words(rest) }),
        "read" => bail!("read needs a note's name"),
        "add" => {
            let (place, text) = match rest.first() {
                Some(p) if p.starts_with('@') && p.len() > 1 => (p[1..].to_string(), words(&rest[1..])),
                _ => (String::new(), words(rest)),
            };
            if text.trim().is_empty() {
                bail!("add needs the text to add");
            }
            Ok(Command::Add { place, text })
        }
        "copy" => {
            let mut card = Vec::new();
            let mut blanks = Vec::new();
            let mut print = false;
            let mut it = rest.iter();
            while let Some(a) = it.next() {
                let pair = if a == "--blank" || a == "-b" {
                    Some(it.next().ok_or_else(|| anyhow::anyhow!("--blank needs NAME=VALUE"))?.clone())
                } else {
                    a.strip_prefix("--blank=").map(str::to_string)
                };
                if let Some(p) = pair {
                    let (k, v) = p
                        .split_once('=')
                        .ok_or_else(|| anyhow::anyhow!("--blank needs NAME=VALUE, not {p}"))?;
                    blanks.push((k.trim().to_string(), v.to_string()));
                } else if a == "--print" || a == "-p" {
                    print = true;
                } else {
                    card.push(a.clone());
                }
            }
            if card.is_empty() {
                bail!("copy needs a card's name");
            }
            Ok(Command::Copy { card: words(&card), blanks, print })
        }
        "mcp" => Ok(Command::Mcp),
        _ => unreachable!(),
    }
}

/// `args` includes the program name, as `std::env::args()` gives it.
pub fn parse(args: &[String]) -> Result<Command> {
    if let Some(sub) = args.get(1).filter(|a| matches!(a.as_str(), "find" | "read" | "add" | "copy" | "mcp"))
    {
        return parse_sub(sub, &args[2..]);
    }
    let mut rest = args.iter().skip(1);
    let mut new = false;
    let mut stdin = false;
    let mut words: Vec<String> = Vec::new();
    let mut tags: Vec<String> = Vec::new();
    while let Some(a) = rest.next() {
        match a.as_str() {
            "--help" | "-h" => return Ok(Command::Help),
            "--new" | "-n" => new = true,
            "--stdin" => stdin = true,
            "--tag" | "-t" => {
                let Some(t) = rest.next() else { bail!("--tag needs a name") };
                tags.extend(split_tags(t));
            }
            s if s.starts_with("--tag=") => tags.extend(split_tags(&s["--tag=".len()..])),
            // Everything after `--` is text, even if it looks like a flag.
            "--" => words.extend(rest.by_ref().cloned()),
            s if new && !s.starts_with('-') => words.push(s.to_string()),
            // `--capture`, and whatever a desktop launcher or the OS adds: the app decides.
            _ => {}
        }
    }
    if stdin {
        if !words.is_empty() {
            bail!("--stdin takes its text from the pipe; leave out TEXT");
        }
        return Ok(Command::Write { text: None, tags });
    }
    if new && !words.is_empty() {
        return Ok(Command::Write { text: Some(words.join(" ")), tags });
    }
    if !tags.is_empty() {
        bail!("--tag goes with --new TEXT or --stdin");
    }
    Ok(Command::App)
}

fn split_tags(s: &str) -> impl Iterator<Item = String> + '_ {
    s.split(',').map(str::trim).filter(|t| !t.is_empty()).map(str::to_string)
}

/// `PETREL_DB`, else where the app keeps it (see `main::db_path`, which must agree).
pub fn db_path() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("PETREL_DB") {
        return Ok(PathBuf::from(p));
    }
    let dir = dirs::data_dir().context("no data directory for this user")?.join(IDENTIFIER);
    Ok(if cfg!(debug_assertions) { dir.join("dev").join("petrel.db") } else { dir.join("petrel.db") })
}

pub fn read_stdin() -> Result<String> {
    let mut text = String::new();
    std::io::stdin()
        .take(STDIN_LIMIT + 1)
        .read_to_string(&mut text)
        .context("reading stdin (is it text?)")?;
    if text.len() as u64 > STDIN_LIMIT {
        bail!("stdin is over {} MB; not saved", STDIN_LIMIT / 1024 / 1024);
    }
    Ok(text)
}

/// Saves `text` as a new capture file in `inbox/` with `tags`. A running Petrel shares the database (SQLite
/// WAL) and finds the file when it next looks at the folder. Returns the file's path inside the notes folder.
pub fn write_capture(db: &Path, text: &str, tags: &[String]) -> Result<String> {
    if text.trim().is_empty() {
        bail!("nothing to save: the text is empty");
    }
    let mut store = Store::open(db).with_context(|| format!("opening {}", db.display()))?;
    let root = store.notes_root_or(&crate::notes::default_root(db))?;
    std::fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;
    let mut note = store.capture_note(text)?;
    if !tags.is_empty() {
        note = store.set_note_tags(note.id, tags)?;
    }
    Ok(note.path)
}

/// Runs `find`, `read`, `add` and `copy`: what they print, or why not.
pub fn run(command: Command) -> Result<String> {
    use petrel_core::outside;
    let db = db_path()?;
    let mut store = Store::open(&db).with_context(|| format!("opening {}", db.display()))?;
    let root = store.notes_root_or(&crate::notes::default_root(&db))?;
    std::fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;
    // Files written while Petrel was closed (or by Drive) are found before anything is looked up.
    store.scan_notes()?;
    let all = outside::Scope::all();
    match command {
        Command::Find { text, limit } => {
            let hits = outside::find(&store, &all, &text, limit)?;
            if hits.is_empty() {
                return Ok(format!("Nothing found for {text}."));
            }
            Ok(hits
                .iter()
                .map(|h| format!("{}  ({})\n    {}", h.title, h.path, h.line))
                .collect::<Vec<_>>()
                .join("\n"))
        }
        Command::Read { name } => Ok(outside::read(&store, &all, &name)?.body),
        Command::Add { place, text } => {
            outside::add(&mut store, &all, &place, &text).map(|w| format!("Petrel: {w}"))
        }
        Command::Copy { card, blanks, print } => {
            let (note, text) = outside::card(&store, &all, &card, &blanks)?;
            let left: Vec<String> = petrel_core::outside::blanks_left(&text);
            if print {
                return Ok(text);
            }
            put_on_clipboard(&text)?;
            let _ = store.record_copy(note.id, Some("terminal"));
            Ok(if left.is_empty() {
                format!("Copied {}.", note.title)
            } else {
                format!("Copied {}. Not filled: {} (--blank NAME=VALUE).", note.title, left.join(", "))
            })
        }
        _ => bail!("not a command for the terminal"),
    }
}

/// The clipboard from a process that ends right after: on Linux a clipboard owned by a process that exits is
/// gone, so `wl-copy` (Wayland) or `xclip` (X11) keep it; elsewhere the system keeps it.
fn put_on_clipboard(text: &str) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        use std::process::{Command as Run, Stdio};
        let tools: [(&str, &[&str]); 2] = [("wl-copy", &[]), ("xclip", &["-selection", "clipboard"])];
        for (tool, args) in tools {
            let Ok(mut child) = Run::new(tool)
                .args(args)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            else {
                continue;
            };
            child.stdin.take().context("no pipe")?.write_all(text.as_bytes())?;
            if child.wait()?.success() {
                return Ok(());
            }
        }
        bail!("no wl-copy or xclip to hold the clipboard; use --print")
    }
    #[cfg(not(target_os = "linux"))]
    {
        arboard::Clipboard::new()?.set_text(text.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &[&str]) -> Vec<String> {
        std::iter::once("petrel").chain(s.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn bare_and_capture_start_the_app() {
        assert_eq!(parse(&args(&[])).unwrap(), Command::App);
        assert_eq!(parse(&args(&["--capture"])).unwrap(), Command::App);
        assert_eq!(parse(&args(&["--new"])).unwrap(), Command::App);
    }

    #[test]
    fn new_with_text_writes() {
        assert_eq!(
            parse(&args(&["--new", "buy", "milk", "-t", "home,errand", "--tag=x"])).unwrap(),
            Command::Write {
                text: Some("buy milk".into()),
                tags: vec!["home".into(), "errand".into(), "x".into()]
            }
        );
        assert_eq!(
            parse(&args(&["--new", "--", "--not-a-flag"])).unwrap(),
            Command::Write { text: Some("--not-a-flag".into()), tags: vec![] }
        );
    }

    #[test]
    fn stdin_writes_and_refuses_text() {
        assert_eq!(
            parse(&args(&["--stdin", "--tag", "git"])).unwrap(),
            Command::Write { text: None, tags: vec!["git".into()] }
        );
        assert!(parse(&args(&["--stdin", "--new", "hi"])).is_err());
        assert!(parse(&args(&["--tag", "x"])).is_err());
        assert!(parse(&args(&["--new", "x", "--tag"])).is_err());
    }

    #[test]
    fn terminal_commands() {
        assert_eq!(
            parse(&args(&["find", "tern", "release", "-l", "3"])).unwrap(),
            Command::Find { text: "tern release".into(), limit: 3 }
        );
        assert_eq!(
            parse(&args(&["add", "@today", "call", "the", "bank"])).unwrap(),
            Command::Add { place: "today".into(), text: "call the bank".into() }
        );
        assert_eq!(
            parse(&args(&["add", "milk"])).unwrap(),
            Command::Add { place: "".into(), text: "milk".into() }
        );
        assert_eq!(
            parse(&args(&["copy", "Meeting", "link", "--blank", "day=Friday", "--blank=room=a b"])).unwrap(),
            Command::Copy {
                card: "Meeting link".into(),
                blanks: vec![("day".into(), "Friday".into()), ("room".into(), "a b".into())],
                print: false
            }
        );
        assert_eq!(parse(&args(&["mcp"])).unwrap(), Command::Mcp);
        assert!(parse(&args(&["add", "@today"])).is_err());
        assert!(parse(&args(&["copy", "x", "--blank", "novalue"])).is_err());
        assert!(parse(&args(&["find"])).is_err());
    }

    #[test]
    fn help() {
        assert_eq!(parse(&args(&["--capture", "--help"])).unwrap(), Command::Help);
    }

    #[test]
    fn write_capture_saves_a_tagged_file_and_refuses_empty() {
        let dir = std::env::temp_dir().join(format!("petrel-cli-{}", std::process::id()));
        let db = dir.join("petrel.db");
        let path = write_capture(&db, "from the pipe\nsecond line", &["git".into()]).unwrap();
        assert!(path.starts_with("inbox/"), "{path}");
        assert!(write_capture(&db, "  \n", &[]).is_err());
        let text = std::fs::read_to_string(dir.join("notes").join(&path)).unwrap();
        assert!(text.contains("git") && text.ends_with("from the pipe\nsecond line"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
