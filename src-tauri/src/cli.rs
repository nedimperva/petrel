//! The command line (package 07). Only what needs no window is handled here, before Tauri starts:
//! `--new TEXT` and `--stdin` write a draft straight to the store and exit, so `git log -1 | petrel --stdin`
//! never opens a window. Everything else (`--capture`, a bare `petrel`, `--new` with no text) goes on to the
//! app, where a second launch is forwarded to the running one by the single-instance plugin.
//!
//! Hand-parsed rather than `clap`: four flags do not earn a dependency on the launch path.

use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use petrel_core::Store;

/// The app identifier from `tauri.conf.json`; Tauri's app data directory is `<data dir>/<identifier>`.
pub const IDENTIFIER: &str = "io.github.nedimperva.petrel";

/// More than this from stdin is almost certainly a mistake (a binary piped in), not a note.
const STDIN_LIMIT: u64 = 16 * 1024 * 1024;

pub const HELP: &str = "\
Petrel: capture text first, act on it later.

Usage:
  petrel                     open Petrel, or bring it to the front
  petrel --capture           open the capture window
  petrel --new               open Petrel on a new, empty draft
  petrel --new TEXT          save TEXT as a new draft in the Inbox, no window
  petrel --stdin             save what is piped in as a new draft, no window
  petrel --hidden            start in the tray, no window (start at login uses this)
  petrel run ACTION --draft UUID
                             run an action on a draft, no window
  petrel run ACTION --stdin  save what is piped in as a new draft, then run the action on it
  petrel --help              this text

Options for --new TEXT and --stdin:
  --tag NAME, -t NAME        tag the new draft (repeatable, or comma-separated)

An action that runs commands or writes outside its folder asks once before it is trusted. With no
terminal to ask on, it does not run: run it once from a terminal or the app first.

Examples:
  git log -1 | petrel --stdin --tag git
  petrel run \"Save to file\" --draft 0193f2c4-…
  echo hi | petrel run Copy --stdin

PETREL_DB=path uses another database.";

/// `petrel run` exits with this when the action failed or conflicted, and with `RUN_STOPPED` when a prompt
/// was dismissed, a preview needed the window or the action was not trusted, so a script can tell them apart.
pub const RUN_FAILED: i32 = 1;
pub const RUN_STOPPED: i32 = 3;

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    /// Start (or forward to) the app.
    App,
    Help,
    /// Write a draft without a window. `None` text means read stdin.
    Write {
        text: Option<String>,
        tags: Vec<String>,
    },
    /// Run an action without a window, on a draft by uuid or on a new one from stdin (`draft: None`).
    Run {
        action: String,
        draft: Option<String>,
        tags: Vec<String>,
    },
}

/// `args` includes the program name, as `std::env::args()` gives it.
pub fn parse(args: &[String]) -> Result<Command> {
    // `run` is a subcommand only in first place, so `petrel --new run` is still a draft that says "run".
    if args.get(1).map(String::as_str) == Some("run") {
        return parse_run(&args[2..]);
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

fn parse_run(args: &[String]) -> Result<Command> {
    let mut rest = args.iter();
    let mut action: Option<String> = None;
    let mut draft: Option<String> = None;
    let mut stdin = false;
    let mut tags: Vec<String> = Vec::new();
    while let Some(a) = rest.next() {
        match a.as_str() {
            "--help" | "-h" => return Ok(Command::Help),
            "--draft" | "-d" => {
                let Some(d) = rest.next() else { bail!("--draft needs a draft's uuid") };
                draft = Some(d.trim().to_string());
            }
            s if s.starts_with("--draft=") => draft = Some(s["--draft=".len()..].trim().to_string()),
            "--stdin" => stdin = true,
            "--tag" | "-t" => {
                let Some(t) = rest.next() else { bail!("--tag needs a name") };
                tags.extend(split_tags(t));
            }
            s if s.starts_with("--tag=") => tags.extend(split_tags(&s["--tag=".len()..])),
            s if s.starts_with('-') && s.len() > 1 => bail!("petrel run does not know {s}"),
            s if action.is_none() => action = Some(s.to_string()),
            s => bail!(
                "one action at a time (got \"{}\" and \"{s}\"; quote a name with spaces)",
                action.unwrap()
            ),
        }
    }
    let Some(action) = action.filter(|a| !a.trim().is_empty()) else {
        bail!("petrel run needs an action's name")
    };
    match (draft, stdin) {
        (Some(_), true) => bail!("use --draft UUID or --stdin, not both"),
        (None, false) => bail!("which draft? Add --draft UUID, or pipe text in with --stdin"),
        (Some(_), false) if !tags.is_empty() => bail!("--tag goes with --stdin (it tags the new draft)"),
        (draft, _) => Ok(Command::Run { action, draft, tags }),
    }
}

/// How a `petrel run` ended, for the exit code.
#[derive(Debug, PartialEq, Eq)]
pub enum RunEnd {
    Ok,
    Stopped,
    Failed,
}

/// Runs `action` on the draft `uuid`, or on a new draft from `text`, from the terminal. The app may be open
/// on the same database: the store notices a draft edited in the window meanwhile and keeps the action's text
/// as a version instead (a conflict), as it does for a slow run in the window.
pub fn run_action(
    db: &Path,
    action: &str,
    draft: Option<&str>,
    text: Option<&str>,
    tags: &[String],
    host: &mut dyn petrel_core::host::Host,
) -> Result<(RunEnd, String)> {
    use petrel_core::action::{self, RunOutcome, Source};
    use petrel_core::host::CancelToken;

    let mut store = Store::open(db).with_context(|| format!("opening {}", db.display()))?;
    // A first `petrel run` on a new database finds the same actions the app would.
    store.seed_default_actions()?;
    if store.action(action)?.is_none() {
        bail!("there is no action named \"{action}\"");
    }
    let (id, uuid) = match (draft, text) {
        (Some(uuid), _) => (
            store.find_by_uuid(uuid)?.with_context(|| format!("there is no draft {uuid}"))?,
            uuid.to_string(),
        ),
        (None, Some(text)) => {
            if text.trim().is_empty() {
                bail!("nothing to run on: the text is empty");
            }
            let d = store.new_draft(text)?;
            if !tags.is_empty() {
                store.set_tags(d.id, tags)?;
            }
            (d.id, d.uuid)
        }
        (None, None) => bail!("no draft"),
    };
    let report = action::run(&mut store, action, id, None, Source::Cli, host, &CancelToken::default())?;
    Ok(match report.outcome {
        RunOutcome::Ok => (RunEnd::Ok, uuid),
        RunOutcome::Stopped | RunOutcome::Cancelled => {
            (RunEnd::Stopped, format!("{}: stopped", report.action))
        }
        RunOutcome::Failed { step, message } => {
            (RunEnd::Failed, format!("{}: failed at step {step}: {message}", report.action))
        }
        RunOutcome::Conflict { message } => (RunEnd::Failed, format!("{}: {message}", report.action)),
    })
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

/// Saves `text` as a new Inbox draft with `tags`. A running Petrel shares the database (SQLite WAL), and
/// its list shows the draft the next time it loads. Returns the new draft's uuid.
pub fn write_draft(db: &Path, text: &str, tags: &[String]) -> Result<String> {
    if text.trim().is_empty() {
        bail!("nothing to save: the text is empty");
    }
    let mut store = Store::open(db).with_context(|| format!("opening {}", db.display()))?;
    let draft = store.new_draft(text)?;
    if !tags.is_empty() {
        store.set_tags(draft.id, tags)?;
    }
    Ok(draft.uuid)
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
    fn run_takes_an_action_and_a_draft() {
        assert_eq!(
            parse(&args(&["run", "Save to file", "--draft", "abc"])).unwrap(),
            Command::Run { action: "Save to file".into(), draft: Some("abc".into()), tags: vec![] }
        );
        assert_eq!(
            parse(&args(&["run", "--stdin", "-t", "git", "Copy to clipboard"])).unwrap(),
            Command::Run { action: "Copy to clipboard".into(), draft: None, tags: vec!["git".into()] }
        );
        assert!(parse(&args(&["run", "Copy"])).is_err(), "no draft");
        assert!(parse(&args(&["run", "--draft", "abc"])).is_err(), "no action");
        assert!(parse(&args(&["run", "Copy", "--draft", "a", "--stdin"])).is_err());
        assert!(parse(&args(&["run", "Save", "to", "file", "--draft", "a"])).is_err(), "unquoted name");
        assert!(parse(&args(&["run", "Copy", "--draft", "a", "--tag", "x"])).is_err());
        assert!(parse(&args(&["run", "Copy", "--bogus"])).is_err());
        // Only in first place: here it is the text of a new draft.
        assert_eq!(
            parse(&args(&["--new", "run"])).unwrap(),
            Command::Write { text: Some("run".into()), tags: vec![] }
        );
    }

    #[test]
    fn run_action_runs_on_a_draft_or_on_new_text() {
        use petrel_core::host::{Call, RecordingHost};
        let dir = std::env::temp_dir().join(format!("petrel-cli-run-{}", std::process::id()));
        let db = dir.join("petrel.db");
        let mut h = RecordingHost::default();

        let (end, uuid) =
            run_action(&db, "Copy to clipboard", None, Some("piped in"), &["git".into()], &mut h).unwrap();
        assert_eq!(end, RunEnd::Ok);
        assert_eq!(h.clipboard, "piped in");

        let (end, again) = run_action(&db, "Copy to clipboard", Some(&uuid), None, &[], &mut h).unwrap();
        assert_eq!((end, again.as_str()), (RunEnd::Ok, uuid.as_str()));
        assert_eq!(h.calls.iter().filter(|c| matches!(c, Call::ClipboardSet(_))).count(), 2);

        assert!(run_action(&db, "No such action", Some(&uuid), None, &[], &mut h).is_err());
        assert!(run_action(&db, "Copy to clipboard", Some("not-a-uuid"), None, &[], &mut h).is_err());
        assert!(run_action(&db, "Copy to clipboard", None, Some("  "), &[], &mut h).is_err());

        let store = Store::open(&db).unwrap();
        let id = store.find_by_uuid(&uuid).unwrap().unwrap();
        assert_eq!(store.peek(id).unwrap().tags, vec!["git".to_string()]);
        let runs = store.list(&Default::default()).unwrap();
        assert_eq!(runs.rows.len(), 1, "the failed runs made no drafts");
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn help() {
        assert_eq!(parse(&args(&["--capture", "--help"])).unwrap(), Command::Help);
    }

    #[test]
    fn write_draft_saves_tagged_text_and_refuses_empty() {
        let dir = std::env::temp_dir().join(format!("petrel-cli-{}", std::process::id()));
        let db = dir.join("petrel.db");
        let uuid = write_draft(&db, "from the pipe\nsecond line", &["git".into()]).unwrap();
        assert!(write_draft(&db, "  \n", &[]).is_err());
        let store = Store::open(&db).unwrap();
        let page = store.list(&Default::default()).unwrap();
        assert_eq!(page.rows.len(), 1);
        let d = store.peek(page.rows[0].id).unwrap();
        assert_eq!(d.uuid, uuid);
        assert_eq!(d.title, "from the pipe");
        assert_eq!(d.tags, vec!["git".to_string()]);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
