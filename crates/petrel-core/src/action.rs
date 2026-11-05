//! Actions and the run algorithm (docs/design/actions.md). A run has three phases so the store lock is never held
//! while a step waits on a person or a process: `prepare` (store: load, take the `before_action` version),
//! `execute` (no store: steps edit a working copy through `Host`), `finish` (store: commit, after-success, trust,
//! log). `run` does all three for callers that own the store outright (tests, the CLI).
//!
//! The stored draft is not touched until `finish`, and only when every step succeeded.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::host::{
    CancelToken, Command, Host, MessageKind, PromptField, PromptSpec, ScopeItem, Shell, WriteMode,
};
use crate::store::{Folder, Store};
use crate::store_actions::Commit;
use crate::template::{self, Encoding, TagSource};

/// The default limits (actions.md "Run algorithm"); per-action settings later.
pub const RUN_LIMIT: Duration = Duration::from_secs(60);
pub const COMMAND_LIMIT: Duration = Duration::from_secs(30);
/// `runAction` nests at most this deep.
pub const NESTING_MAX: usize = 8;
/// The run log kept in `action_runs.message`.
const LOG_MAX: usize = 8 * 1024;

// ---- the model ----------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AfterSuccess {
    #[default]
    Nothing,
    Archive,
    Trash,
    /// Open a new, empty draft after the run.
    New,
}

impl AfterSuccess {
    pub fn as_str(self) -> &'static str {
        match self {
            AfterSuccess::Nothing => "nothing",
            AfterSuccess::Archive => "archive",
            AfterSuccess::Trash => "trash",
            AfterSuccess::New => "new",
        }
    }

    pub fn parse(s: &str) -> AfterSuccess {
        match s {
            "archive" => AfterSuccess::Archive,
            "trash" => AfterSuccess::Trash,
            "new" => AfterSuccess::New,
            _ => AfterSuccess::Nothing,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InsertAt {
    #[default]
    Cursor,
    Start,
    End,
    ReplaceSelection,
    ReplaceAll,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardMode {
    #[default]
    Replace,
    Prepend,
    Append,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenIn {
    #[default]
    Default,
    Browser,
}

fn draft_tag() -> String {
    "[[draft]]".into()
}

fn yes() -> bool {
    true
}

fn ignore() -> String {
    "ignore".into()
}

/// One step. Names are stable once shipped; new fields get defaults; unknown fields are ignored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Step {
    InsertText {
        text: String,
        #[serde(default)]
        position: InsertAt,
        #[serde(default)]
        move_cursor: bool,
    },
    Clipboard {
        #[serde(default = "draft_tag")]
        text: String,
        #[serde(default)]
        mode: ClipboardMode,
    },
    Url {
        url: String,
        #[serde(default = "yes")]
        encode: bool,
        #[serde(default)]
        open_in: OpenIn,
    },
    File {
        path: String,
        #[serde(default = "draft_tag")]
        text: String,
        #[serde(default)]
        mode: WriteMode,
        #[serde(default = "yes")]
        create_dirs: bool,
    },
    RunCommand {
        command: String,
        #[serde(default = "draft_tag")]
        stdin: String,
        #[serde(default)]
        shell: Option<Shell>,
        #[serde(default)]
        timeout_secs: Option<u64>,
        /// `ignore | insert | replace | clipboard | templateTag:<name>`.
        #[serde(default = "ignore")]
        output: String,
        #[serde(default)]
        cwd: Option<String>,
    },
    RunAction {
        action: String,
        #[serde(default = "yes")]
        stop_on_fail: bool,
    },
    Prompt {
        #[serde(default)]
        title: String,
        #[serde(default)]
        message: String,
        #[serde(default)]
        buttons: Vec<String>,
        #[serde(default)]
        fields: Vec<PromptField>,
        #[serde(default = "yes")]
        cancel_button: bool,
    },
    HtmlPreview {
        #[serde(default = "draft_tag")]
        template: String,
        #[serde(default)]
        html: bool,
        #[serde(default)]
        css: Option<String>,
        #[serde(default = "yes")]
        continue_button: bool,
    },
    Script {
        #[serde(default)]
        script: String,
        #[serde(default)]
        timeout_secs: Option<u64>,
        #[serde(default)]
        allow_shell: bool,
        #[serde(default)]
        allow_files: bool,
        #[serde(default)]
        allow_http: bool,
    },
    Unsupported {
        original_type: String,
        #[serde(default)]
        original: serde_json::Value,
    },
    Mail {
        #[serde(default)]
        to: String,
        #[serde(default)]
        cc: String,
        #[serde(default)]
        bcc: String,
        #[serde(default)]
        subject: String,
        #[serde(default)]
        body: String,
    },
    SetTags {
        #[serde(default)]
        add: Vec<String>,
        #[serde(default)]
        remove: Vec<String>,
    },
    SetFlag {
        flagged: bool,
    },
    Move {
        folder: Folder,
    },
    OpenDraft {
        #[serde(default)]
        uuid: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        new_if_missing: bool,
    },
}

impl Step {
    /// The `type` as written in JSON, for messages.
    pub fn kind(&self) -> &'static str {
        match self {
            Step::InsertText { .. } => "insertText",
            Step::Clipboard { .. } => "clipboard",
            Step::Url { .. } => "url",
            Step::File { .. } => "file",
            Step::RunCommand { .. } => "runCommand",
            Step::RunAction { .. } => "runAction",
            Step::Prompt { .. } => "prompt",
            Step::HtmlPreview { .. } => "htmlPreview",
            Step::Script { .. } => "script",
            Step::Unsupported { .. } => "unsupported",
            Step::Mail { .. } => "mail",
            Step::SetTags { .. } => "setTags",
            Step::SetFlag { .. } => "setFlag",
            Step::Move { .. } => "move",
            Step::OpenDraft { .. } => "openDraft",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Action {
    pub uuid: String,
    pub name: String,
    /// The group's name; actions with no group show under "Actions".
    pub group: String,
    pub description: String,
    pub icon: String,
    pub color: String,
    pub shortcut: Option<String>,
    pub steps: Vec<Step>,
    pub after_success: AfterSuccess,
    pub add_tags: Vec<String>,
    pub confirm: bool,
    pub hidden: bool,
    /// Turned off by the user. An action with an `unsupported` step is disabled whatever this says.
    pub disabled: bool,
    /// Its steps are the ones the user last saw: saved in the editor or confirmed once (actions.md "Trust").
    /// Set by the store from `trusted_hash`; ignored on the way in.
    pub trusted: bool,
}

impl Action {
    /// SHA-256 of the steps' JSON: what trust is granted to.
    pub fn steps_hash(&self) -> String {
        let json = serde_json::to_string(&self.steps).unwrap_or_default();
        Sha256::digest(json.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }

    pub fn unsupported_steps(&self) -> Vec<String> {
        self.steps
            .iter()
            .filter_map(|s| match s {
                Step::Unsupported { original_type, .. } => Some(original_type.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn is_disabled(&self) -> bool {
        self.disabled || !self.unsupported_steps().is_empty()
    }
}

// ---- a run --------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    #[default]
    Ui,
    Shortcut,
    Cli,
    Uri,
    Action,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Ui => "ui",
            Source::Shortcut => "shortcut",
            Source::Cli => "cli",
            Source::Uri => "uri",
            Source::Action => "action",
        }
    }
}

/// Positions are UTF-16 code units, as CodeMirror reports them (and as `drafts.cursor` is stored).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorState {
    pub anchor: usize,
    pub head: usize,
}

/// The draft as the steps see and change it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDraft {
    pub id: i64,
    pub uuid: String,
    pub content: String,
    /// Sorted, lower-case.
    pub tags: Vec<String>,
    pub flagged: bool,
    pub folder: Folder,
    pub created_at: i64,
    pub modified_at: i64,
    /// UTF-16 offsets; equal when nothing is selected.
    pub anchor: usize,
    pub head: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RunOutcome {
    Ok,
    /// A prompt or preview was dismissed: nothing written, no error, no after-success.
    Stopped,
    Cancelled,
    /// `step` is 1-based, of the top-level action (a nested failure names its action in `message`).
    Failed {
        step: usize,
        message: String,
    },
    /// The draft's text was saved while the steps ran, so committing would overwrite it. Nothing is written; the
    /// action's text is kept as a version instead.
    Conflict {
        message: String,
    },
}

impl RunOutcome {
    fn status(&self) -> &'static str {
        match self {
            RunOutcome::Ok => "ok",
            RunOutcome::Stopped => "stopped",
            RunOutcome::Cancelled => "cancelled",
            RunOutcome::Failed { .. } => "failed",
            RunOutcome::Conflict { .. } => "conflict",
        }
    }
}

/// Which draft to show after the run (`openDraft`, a `petrel://open` URL).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTarget {
    pub uuid: Option<String>,
    pub title: Option<String>,
    pub new_if_missing: bool,
}

/// Phase one's result: what to run on what.
pub struct Prepared {
    pub action: Action,
    pub draft: WorkingDraft,
    pub source: Source,
    pub started_at: i64,
}

/// Phase two's result, for `finish`.
pub struct Executed {
    pub action: Action,
    /// As `prepare` read it; `finish` writes only what differs.
    pub before: WorkingDraft,
    pub draft: WorkingDraft,
    pub source: Source,
    pub started_at: i64,
    pub outcome: RunOutcome,
    pub open: Option<OpenTarget>,
    /// Actions (by uuid) the user trusted during the run, with the hash of the steps they saw.
    pub trusted: Vec<(String, String)>,
    pub unknown_tags: Vec<String>,
    pub log: Vec<String>,
}

/// What the caller shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub run_id: i64,
    pub action: String,
    pub draft_id: i64,
    pub outcome: RunOutcome,
    /// The draft to show next, if a step asked for one.
    pub open_draft: Option<i64>,
    /// After-success is `new`: the editor opens an empty draft.
    pub new_draft: bool,
    pub unknown_tags: Vec<String>,
    pub log: Vec<String>,
    /// The selection after the steps, in UTF-16 units, so the editor can put it back after reloading the text.
    pub selection: EditorState,
    /// The stored content changed; the editor reloads it.
    pub changed: bool,
}

/// Where `runAction` finds actions.
pub trait Library {
    fn find_action(&self, key: &str) -> Option<Action>;
}

impl Library for Store {
    fn find_action(&self, key: &str) -> Option<Action> {
        self.action(key).ok().flatten()
    }
}

/// Where things live: `<data dir>/files` for relative paths, `templates/`, `css/`. `None` for a store in memory.
#[derive(Clone, Debug, Default)]
pub struct Paths {
    pub data_dir: Option<PathBuf>,
}

impl Paths {
    pub fn for_store(store: &Store) -> Paths {
        Paths { data_dir: store.path().and_then(Path::parent).map(Path::to_path_buf) }
    }
}

/// Phase one, under the store lock: load the action and the draft, take the `before_action` version.
pub fn prepare(
    store: &Store,
    action_key: &str,
    draft_id: i64,
    editor: Option<EditorState>,
    source: Source,
) -> Result<Prepared> {
    let action = store.action(action_key)?.ok_or_else(|| anyhow!("there is no action named {action_key}"))?;
    let d = store.draft(draft_id)?;
    let now = store.clock_now();
    store.snapshot(d.id, &format!("before_action:{}", action.uuid), now)?;
    let cursor = d.cursor.max(0) as usize;
    let (anchor, head) = editor.map_or((cursor, cursor), |e| (e.anchor, e.head));
    let mut tags = d.tags;
    tags.sort();
    Ok(Prepared {
        draft: WorkingDraft {
            id: d.id,
            uuid: d.uuid,
            content: d.content,
            tags,
            flagged: d.flagged,
            folder: d.folder,
            created_at: d.created_at,
            modified_at: d.modified_at,
            anchor,
            head,
        },
        action,
        source,
        started_at: now,
    })
}

/// Phase two, with no store: runs the steps.
pub fn execute(
    p: Prepared,
    host: &mut dyn Host,
    library: &dyn Library,
    paths: &Paths,
    cancel: &CancelToken,
) -> Executed {
    let Prepared { action, draft, source, started_at } = p;
    let before = draft.clone();
    let mut ctx = Ctx {
        draft,
        tags: HashMap::new(),
        host,
        library,
        paths,
        cancel,
        deadline: Instant::now() + RUN_LIMIT,
        stack: Vec::new(),
        open: None,
        trusted: Vec::new(),
        checking: Vec::new(),
        allowed: Vec::new(),
        unknown: Vec::new(),
        log: Vec::new(),
    };
    let outcome = ctx.run_top(&action, source);
    match &outcome {
        RunOutcome::Failed { step, message } => {
            ctx.host.message(MessageKind::Error, &format!("{}: step {step} failed: {message}", action.name))
        }
        RunOutcome::Ok if source == Source::Ui => ctx.host.message(MessageKind::Success, &action.name),
        _ => {}
    }
    let Ctx { draft, open, trusted, unknown, log, .. } = ctx;
    Executed { action, before, draft, source, started_at, outcome, open, trusted, unknown_tags: unknown, log }
}

/// Phase three, under the store lock: commit (only on success), after-success, trust, the log row.
pub fn finish(store: &mut Store, mut e: Executed) -> Result<RunReport> {
    for (uuid, hash) in &e.trusted {
        store.trust_action(uuid, hash)?;
    }
    let mut open_draft = None;
    let mut new_draft = false;
    let mut changed = false;
    if e.outcome == RunOutcome::Ok {
        let mut draft = e.draft.clone();
        match e.action.after_success {
            AfterSuccess::Archive => draft.folder = Folder::Archive,
            AfterSuccess::Trash => draft.folder = Folder::Trash,
            AfterSuccess::New => new_draft = true,
            AfterSuccess::Nothing => {}
        }
        add_tags(&mut draft.tags, &e.action.add_tags);
        match store.commit_draft(&e.before, &draft)? {
            Commit::Written(_) => {
                changed = draft.content != e.before.content;
                if let Some(t) = &e.open {
                    open_draft = store.resolve_open(t)?;
                }
            }
            Commit::Conflict => {
                let now = store.clock_now();
                store.add_version(
                    draft.id,
                    &draft.content,
                    &format!("action_conflict:{}", e.action.uuid),
                    now,
                )?;
                new_draft = false;
                e.outcome = RunOutcome::Conflict {
                    message: "the draft was edited while it ran; its result is kept as a version".into(),
                };
            }
        }
    }
    let message = match &e.outcome {
        RunOutcome::Failed { message, .. } | RunOutcome::Conflict { message } => message.clone(),
        _ => tail(&e.log.join("\n"), LOG_MAX),
    };
    let step = match &e.outcome {
        RunOutcome::Failed { step, .. } => Some(*step as i64),
        _ => None,
    };
    let run_id = store.log_run(
        &e.action.uuid,
        e.draft.id,
        e.started_at,
        e.outcome.status(),
        step,
        &message,
        e.source,
    )?;
    Ok(RunReport {
        run_id,
        action: e.action.name.clone(),
        draft_id: e.draft.id,
        outcome: e.outcome,
        open_draft,
        new_draft,
        unknown_tags: e.unknown_tags,
        log: e.log,
        selection: EditorState { anchor: e.draft.anchor, head: e.draft.head },
        changed,
    })
}

/// All three phases, for a caller that owns the store.
pub fn run(
    store: &mut Store,
    action_key: &str,
    draft_id: i64,
    editor: Option<EditorState>,
    source: Source,
    host: &mut dyn Host,
    cancel: &CancelToken,
) -> Result<RunReport> {
    let prepared = prepare(store, action_key, draft_id, editor, source)?;
    let paths = Paths::for_store(store);
    let executed = execute(prepared, host, &*store, &paths, cancel);
    finish(store, executed)
}

/// `scheme:` as in RFC 3986, so `https://…`, `mailto:…` and `obsidian://…` pass and `Hello world` and
/// `Todo: milk` do not.
fn has_scheme(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else { return false };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        && rest.starts_with(|c: char| !c.is_whitespace())
}

/// The first `max` characters, with an ellipsis when cut.
fn tail_chars(s: &str, max: usize) -> String {
    let cut: String = s.chars().take(max).collect();
    if cut.len() < s.len() {
        format!("{cut}…")
    } else {
        cut
    }
}

fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

fn add_tags(tags: &mut Vec<String>, names: &[String]) {
    for n in names {
        let n = n.trim().to_lowercase();
        if !n.is_empty() && !tags.contains(&n) {
            tags.push(n);
        }
    }
    tags.sort();
}

/// How a step ended, short of an error.
enum Flow {
    Continue,
    Stop,
}

/// A step error. `Cancelled` and `Stop` travel through nested actions unchanged.
enum StepError {
    Failed(String),
    Stopped,
    Cancelled,
}

impl From<anyhow::Error> for StepError {
    fn from(e: anyhow::Error) -> StepError {
        StepError::Failed(format!("{e:#}"))
    }
}

struct Ctx<'a> {
    draft: WorkingDraft,
    tags: HashMap<String, String>,
    host: &'a mut dyn Host,
    library: &'a dyn Library,
    paths: &'a Paths,
    cancel: &'a CancelToken,
    deadline: Instant,
    /// Uuids of the actions running, outermost first.
    stack: Vec<String>,
    open: Option<OpenTarget>,
    trusted: Vec<(String, String)>,
    /// Uuids of the actions that were untrusted when this run reached them. Their commands and out-of-scope
    /// paths are checked again at the call, because a prompt or an earlier step can change what they render to.
    checking: Vec<String>,
    /// What the person allowed in this run.
    allowed: Vec<ScopeItem>,
    unknown: Vec<String>,
    log: Vec<String>,
}

impl Ctx<'_> {
    fn run_top(&mut self, action: &Action, source: Source) -> RunOutcome {
        if action.is_disabled() {
            let unsupported = action.unsupported_steps();
            let message = if unsupported.is_empty() {
                "the action is turned off".to_string()
            } else {
                format!("contains unsupported steps: {}", unsupported.join(", "))
            };
            return RunOutcome::Failed { step: 0, message };
        }
        if action.confirm && source != Source::Action {
            let message = format!("Run {} on “{}”?", action.name, self.title());
            match self.asking(|h| h.confirm(&action.name, &message)) {
                Ok(true) => {}
                Ok(false) => return RunOutcome::Cancelled,
                Err(e) => return RunOutcome::Failed { step: 0, message: format!("{e:#}") },
            }
        }
        match self.run_action(action) {
            Ok(()) => RunOutcome::Ok,
            Err((_, StepError::Stopped)) => RunOutcome::Stopped,
            Err((_, StepError::Cancelled)) => RunOutcome::Cancelled,
            Err((step, StepError::Failed(message))) => RunOutcome::Failed { step, message },
        }
    }

    /// A host call that waits on the person. Their reading time does not count against the run's limit.
    fn asking<T>(&mut self, f: impl FnOnce(&mut dyn Host) -> T) -> T {
        let started = Instant::now();
        let r = f(&mut *self.host);
        self.deadline += started.elapsed();
        r
    }

    fn title(&self) -> String {
        crate::title::title(&self.draft.content)
    }

    /// Runs one action's steps on the shared context. The error carries the 1-based step that failed.
    fn run_action(&mut self, action: &Action) -> Result<(), (usize, StepError)> {
        if self.stack.contains(&action.uuid) {
            return Err((0, StepError::Failed(format!("{} runs itself (a cycle)", action.name))));
        }
        if self.stack.len() >= NESTING_MAX {
            return Err((0, StepError::Failed(format!("actions nest more than {NESTING_MAX} deep"))));
        }
        self.check_trust(action).map_err(|e| (0, e))?;
        self.stack.push(action.uuid.clone());
        let result = (|| {
            for (i, step) in action.steps.iter().enumerate() {
                if self.cancel.is_cancelled() {
                    return Err((i + 1, StepError::Cancelled));
                }
                if Instant::now() >= self.deadline {
                    let limit = RUN_LIMIT.as_secs();
                    return Err((i + 1, StepError::Failed(format!("the run took longer than {limit} s"))));
                }
                match self.step(action, step) {
                    Ok(Flow::Continue) => {}
                    Ok(Flow::Stop) => return Err((i + 1, StepError::Stopped)),
                    // A host error during a cancel is the cancel.
                    Err(_) if self.cancel.is_cancelled() => return Err((i + 1, StepError::Cancelled)),
                    Err(e) => return Err((i + 1, e)),
                }
            }
            Ok(())
        })();
        self.stack.pop();
        result
    }

    /// An untrusted action shows every rendered command and every path outside `files/` once, before
    /// its first step (actions.md "Trust").
    fn check_trust(&mut self, action: &Action) -> Result<(), StepError> {
        if action.trusted {
            return Ok(());
        }
        if !self.checking.contains(&action.uuid) {
            self.checking.push(action.uuid.clone());
        }
        if self.trusted.iter().any(|(u, _)| u == &action.uuid) {
            return Ok(());
        }
        let mut items = Vec::new();
        for step in &action.steps {
            match step {
                Step::RunCommand { command, .. } => {
                    items.push(ScopeItem::Command(self.render(command, Encoding::Raw)))
                }
                Step::File { path, .. } => {
                    let rendered = self.render(path, Encoding::Raw);
                    let p = self.resolve_path(&rendered);
                    if !self.in_scope(&p) {
                        items.push(ScopeItem::Path(p.display().to_string()));
                    }
                }
                _ => {}
            }
        }
        let mut seen = Vec::new();
        items.retain(|i| {
            !self.allowed.contains(i) && !seen.contains(i) && {
                seen.push(i.clone());
                true
            }
        });
        if items.is_empty() {
            return Ok(());
        }
        self.confirm_scope(action, items)
    }

    /// The check at the call: a command or path of an untrusted action that the person has not seen in this
    /// run asks again, so a value from a prompt or a command never reaches the shell or the disk unseen.
    fn check_call(&mut self, action: &Action, item: ScopeItem) -> Result<(), StepError> {
        if !self.checking.contains(&action.uuid) || self.allowed.contains(&item) {
            return Ok(());
        }
        self.confirm_scope(action, vec![item])
    }

    fn confirm_scope(&mut self, action: &Action, items: Vec<ScopeItem>) -> Result<(), StepError> {
        match self.asking(|h| h.confirm_scope(&action.name, &items)) {
            Ok(true) => {
                if !self.trusted.iter().any(|(u, _)| u == &action.uuid) {
                    self.trusted.push((action.uuid.clone(), action.steps_hash()));
                }
                self.allowed.extend(items);
                Ok(())
            }
            Ok(false) => Err(StepError::Cancelled),
            Err(e) => Err(e.into()),
        }
    }

    /// Only `<data dir>/files/` is in scope: the database, the action mirror and the templates sit beside it.
    /// `p` comes from `resolve_path`, so `..` is already gone.
    fn in_scope(&self, p: &Path) -> bool {
        self.paths.data_dir.as_deref().is_some_and(|d| p.starts_with(normalize(&d.join("files"))))
    }

    fn render(&mut self, input: &str, encoding: Encoding) -> String {
        let content = self.draft.content.as_str();
        let (a, b) = (self.draft.anchor.min(self.draft.head), self.draft.anchor.max(self.draft.head));
        let (sa, sb) = (byte_at(content, a), byte_at(content, b));
        let selection = (sa < sb).then(|| &content[sa..sb]);
        let cursor_line = content[..byte_at(content, self.draft.head)].matches('\n').count();
        let host = RefCell::new(&mut *self.host);
        let templates = self.paths.data_dir.as_ref().map(|d| d.join("templates"));
        let mut clipboard = || host.borrow_mut().clipboard_get().ok();
        let mut template = |name: &str| {
            let dir = templates.as_ref()?;
            // A template name is a file in the folder, never a path out of it.
            if name.contains(['/', '\\']) || name.starts_with('.') {
                return None;
            }
            host.borrow_mut().read_file(&dir.join(name)).ok().flatten()
        };
        let env = |name: &str| std::env::var(name).ok();
        let time = |ms: i64| Local.timestamp_millis_opt(ms).single().unwrap_or_else(Local::now);
        let mut source = TagSource {
            content,
            uuid: &self.draft.uuid,
            tags: &self.draft.tags,
            created: time(self.draft.created_at),
            modified: time(self.draft.modified_at),
            selection,
            cursor_line,
            now: Local::now(),
            custom: &self.tags,
            clipboard: &mut clipboard,
            template: &mut template,
            env: &env,
        };
        let out = template::render(input, &mut source, encoding);
        for u in out.unknown {
            if !self.unknown.contains(&u) {
                self.log.push(format!("unknown template tag {u}, left as written"));
                self.unknown.push(u);
            }
        }
        out.text
    }

    /// `~` and `$VAR`/`${VAR}` expanded; a relative path is under `<data dir>/files/`.
    fn resolve_path(&self, raw: &str) -> PathBuf {
        let expanded = expand_vars(raw.trim());
        let p = PathBuf::from(&expanded);
        if p.is_absolute() {
            return normalize(&p);
        }
        match &self.paths.data_dir {
            Some(d) => normalize(&d.join("files").join(p)),
            None => normalize(&p),
        }
    }

    fn step(&mut self, action: &Action, step: &Step) -> Result<Flow, StepError> {
        match step {
            Step::InsertText { text, position, move_cursor } => {
                let text = self.render(text, Encoding::Raw);
                self.insert(&text, *position, *move_cursor);
            }
            Step::Clipboard { text, mode } => {
                let text = self.render(text, Encoding::Raw);
                let text = match mode {
                    ClipboardMode::Replace => text,
                    ClipboardMode::Prepend => text + &self.host.clipboard_get()?,
                    ClipboardMode::Append => self.host.clipboard_get()? + &text,
                };
                self.host.clipboard_set(&text)?;
                self.log.push("copied to the clipboard".into());
            }
            Step::Url { url, encode, open_in } => {
                let url = self.render(url, if *encode { Encoding::Url } else { Encoding::Raw });
                if let Some(rest) = url.strip_prefix("petrel://") {
                    self.open = Some(petrel_url(rest)?);
                } else if !has_scheme(&url) {
                    // Handing plain text to the system opener can start an app that then quits.
                    return Err(StepError::Failed(format!("“{}” is not a link", tail_chars(&url, 80))));
                } else {
                    self.host.open_url(&url, *open_in == OpenIn::Browser)?;
                    self.log.push(format!("opened {url}"));
                }
            }
            Step::File { path, text, mode, create_dirs } => {
                let rendered = self.render(path, Encoding::Raw);
                let path = self.resolve_path(&rendered);
                if !self.in_scope(&path) {
                    self.check_call(action, ScopeItem::Path(path.display().to_string()))?;
                }
                let text = self.render(text, Encoding::Raw);
                self.host.write_file(&path, &text, *mode, *create_dirs)?;
                self.log.push(format!("saved to {}", path.display()));
            }
            Step::RunCommand { command, stdin, shell, timeout_secs, output, cwd } => {
                let command = self.render(command, Encoding::Raw);
                self.check_call(action, ScopeItem::Command(command.clone()))?;
                let stdin = self.render(stdin, Encoding::Raw);
                let left = self.deadline.saturating_duration_since(Instant::now());
                let timeout = timeout_secs.map_or(COMMAND_LIMIT, Duration::from_secs).min(left);
                let cwd = cwd.as_ref().map(|c| {
                    let c = self.render(c, Encoding::Raw);
                    self.resolve_path(&c)
                });
                let cmd = Command {
                    command: command.clone(),
                    stdin,
                    shell: shell.unwrap_or_default(),
                    timeout,
                    cwd,
                };
                let out = self.host.run_command(&cmd, self.cancel)?;
                if out.status != 0 {
                    let why = out.stderr.trim();
                    let why = if why.is_empty() { out.stdout.trim() } else { why };
                    return Err(StepError::Failed(format!(
                        "`{command}` exited with {}: {}",
                        out.status,
                        tail(why, 500)
                    )));
                }
                self.log.push(format!("ran `{command}`"));
                let text = out.stdout.strip_suffix('\n').unwrap_or(&out.stdout).to_string();
                match output.as_str() {
                    "" | "ignore" => {}
                    "insert" => self.insert(&text, InsertAt::Cursor, true),
                    "replace" => self.insert(&text, InsertAt::ReplaceAll, false),
                    "clipboard" => self.host.clipboard_set(&text)?,
                    other => match other.strip_prefix("templateTag:") {
                        Some(name) if !name.trim().is_empty() => {
                            self.tags.insert(name.trim().to_lowercase(), text);
                        }
                        _ => return Err(StepError::Failed(format!("unknown output {other:?}"))),
                    },
                }
            }
            Step::RunAction { action, stop_on_fail } => {
                let key = self.render(action, Encoding::Raw);
                let nested = self
                    .library
                    .find_action(&key)
                    .ok_or_else(|| StepError::Failed(format!("there is no action named {key}")))?;
                if nested.is_disabled() {
                    return Err(StepError::Failed(format!(
                        "{} is turned off or has unsupported steps",
                        nested.name
                    )));
                }
                match self.run_action(&nested) {
                    Ok(()) => add_tags(&mut self.draft.tags, &nested.add_tags),
                    Err((step, StepError::Failed(m))) => {
                        let m = format!("in {}, step {step}: {m}", nested.name);
                        if *stop_on_fail {
                            return Err(StepError::Failed(m));
                        }
                        self.log.push(format!("{m} (continuing)"));
                    }
                    Err((_, other)) => return Err(other),
                }
            }
            Step::Prompt { title, message, buttons, fields, cancel_button } => {
                let spec = PromptSpec {
                    title: self.render(title, Encoding::Raw),
                    message: self.render(message, Encoding::Raw),
                    buttons: buttons.iter().map(|b| self.render(b, Encoding::Raw)).collect(),
                    fields: fields
                        .iter()
                        .map(|f| PromptField { default: self.render(&f.default, Encoding::Raw), ..f.clone() })
                        .collect(),
                    cancel_button: *cancel_button,
                };
                let Some(reply) = self.asking(|h| h.prompt(&spec))? else { return Ok(Flow::Stop) };
                self.tags.insert("prompt_button".into(), reply.button);
                for (k, v) in reply.values {
                    self.tags.insert(format!("prompt_{}", k.to_lowercase()), v);
                }
            }
            Step::HtmlPreview { template, html, css, continue_button } => {
                let text = self.render(template, Encoding::Raw);
                let body = if *html { text } else { markdown(&text) };
                let css = match (css, &self.paths.data_dir) {
                    (Some(name), Some(dir)) if !name.contains(['/', '\\']) => {
                        self.host.read_file(&dir.join("css").join(name))?.unwrap_or_default()
                    }
                    _ => String::new(),
                };
                if !self.asking(|h| h.preview(&body, &css, *continue_button))? {
                    return Ok(Flow::Stop);
                }
            }
            Step::Script { .. } => return Err(StepError::Failed("scripting arrives in 0.3".into())),
            Step::Unsupported { original_type, .. } => {
                return Err(StepError::Failed(format!("{original_type} steps are not supported")))
            }
            Step::Mail { to, cc, bcc, subject, body } => {
                let mut query = Vec::new();
                for (k, v) in [("cc", cc), ("bcc", bcc), ("subject", subject), ("body", body)] {
                    let v = self.render(v, Encoding::Raw);
                    if !v.is_empty() {
                        query.push(format!("{k}={}", template::percent_encode(&v)));
                    }
                }
                let to = self.render(to, Encoding::Raw);
                let to: Vec<String> = to.split(',').map(|a| template::percent_encode(a.trim())).collect();
                let mut url = format!("mailto:{}", to.join(","));
                if !query.is_empty() {
                    url = format!("{url}?{}", query.join("&"));
                }
                self.host.open_url(&url, false)?;
                self.log.push("opened a new mail".into());
            }
            Step::SetTags { add, remove } => {
                let add: Vec<String> = add.iter().map(|t| self.render(t, Encoding::Raw)).collect();
                let remove: Vec<String> =
                    remove.iter().map(|t| self.render(t, Encoding::Raw).trim().to_lowercase()).collect();
                self.draft.tags.retain(|t| !remove.contains(t));
                add_tags(&mut self.draft.tags, &add);
            }
            Step::SetFlag { flagged } => self.draft.flagged = *flagged,
            Step::Move { folder } => self.draft.folder = *folder,
            Step::OpenDraft { uuid, title, new_if_missing } => {
                let uuid = uuid.as_ref().map(|u| self.render(u, Encoding::Raw)).filter(|u| !u.is_empty());
                let title = title.as_ref().map(|t| self.render(t, Encoding::Raw)).filter(|t| !t.is_empty());
                if uuid.is_none() && title.is_none() {
                    return Err(StepError::Failed("openDraft needs a uuid or a title".into()));
                }
                self.open = Some(OpenTarget { uuid, title, new_if_missing: *new_if_missing });
            }
        }
        Ok(Flow::Continue)
    }

    /// Edits the working copy as an editor would: the selection collapses, the cursor follows the text it was in.
    fn insert(&mut self, text: &str, at: InsertAt, move_cursor: bool) {
        let content = &self.draft.content;
        let (a, b) = (self.draft.anchor.min(self.draft.head), self.draft.anchor.max(self.draft.head));
        let units = utf16_len(content);
        let (from, to) = match at {
            InsertAt::Cursor => (self.draft.head, self.draft.head),
            InsertAt::Start => (0, 0),
            InsertAt::End => (units, units),
            InsertAt::ReplaceSelection => (a, b),
            InsertAt::ReplaceAll => (0, units),
        };
        let (bf, bt) = (byte_at(content, from), byte_at(content, to));
        self.draft.content = format!("{}{}{}", &content[..bf], text, &content[bt..]);
        let len = utf16_len(text);
        let old = self.draft.head;
        let cursor = if move_cursor {
            from + len
        } else if at == InsertAt::ReplaceAll {
            old.min(len)
        } else if old >= to {
            old - (to - from) + len
        } else {
            old.min(from)
        };
        self.draft.anchor = cursor;
        self.draft.head = cursor;
    }
}

/// `petrel://open?uuid=…` (or `title=`); other petrel URLs arrive with package 07's URI handler.
fn petrel_url(rest: &str) -> Result<OpenTarget, StepError> {
    let (verb, query) = rest.split_once('?').unwrap_or((rest, ""));
    if verb.trim_end_matches('/') != "open" {
        return Err(StepError::Failed(format!("petrel://{verb} links are not handled inside actions yet")));
    }
    let mut t = OpenTarget::default();
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v = percent_decode(v);
        match k {
            "uuid" => t.uuid = Some(v),
            "title" => t.title = Some(v),
            _ => {}
        }
    }
    if t.uuid.is_none() && t.title.is_none() {
        return Err(StepError::Failed("petrel://open needs a uuid or a title".into()));
    }
    Ok(t)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(v) => {
                    out.push(v);
                    i += 3;
                    continue;
                }
                Err(_) => out.push(b'%'),
            },
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn markdown(text: &str) -> String {
    let parser = pulldown_cmark::Parser::new_ext(text, pulldown_cmark::Options::all());
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    html
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// The byte offset of a UTF-16 position, clamped to the text.
fn byte_at(s: &str, units: usize) -> usize {
    let mut n = 0;
    for (i, c) in s.char_indices() {
        if n >= units {
            return i;
        }
        n += c.len_utf16();
    }
    s.len()
}

/// `.` and `..` resolved without touching the disk, so `files/../../x` is checked as the place it writes to.
/// `..` above the root stays at the root, as the system does.
fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    // A path without them is kept as written, so the dialog shows the separators the action used.
    if !p.components().any(|c| matches!(c, Component::CurDir | Component::ParentDir)) {
        return p.to_path_buf();
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                // Above the root is the root.
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            c => out.push(c),
        }
    }
    out
}

/// `~/x`, `$VAR/x`, `${VAR}/x`; an unset variable expands to nothing, as in a shell.
fn expand_vars(s: &str) -> String {
    let home = || std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let s = if s == "~" {
        home()
    } else if let Some(rest) = s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")) {
        format!("{}/{rest}", home())
    } else {
        s.to_string()
    };
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        let braced = chars.peek() == Some(&'{');
        if braced {
            chars.next();
        }
        let mut name = String::new();
        // A name starts with a letter or `_`, so "$5" stays text.
        while let Some(&n) = chars.peek() {
            if n.is_alphabetic() || n == '_' || (!name.is_empty() && n.is_ascii_digit()) {
                name.push(n);
                chars.next();
            } else {
                break;
            }
        }
        if braced {
            chars.next_if_eq(&'}');
        }
        if name.is_empty() {
            out.push('$');
        } else {
            out.push_str(&std::env::var(&name).unwrap_or_default());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{Call, CommandOutput, PromptReply, RecordingHost};
    use serde_json::json;

    fn steps(v: serde_json::Value) -> Vec<Step> {
        serde_json::from_value(v).unwrap()
    }

    fn act(name: &str, v: serde_json::Value) -> Action {
        Action { name: name.into(), steps: steps(v), ..Action::default() }
    }

    /// A file-backed store (so paths and mirrors are real) with one draft; returns the store, its dir, the draft.
    fn setup() -> (Store, PathBuf, i64) {
        let dir = std::env::temp_dir().join(format!("petrel-action-{}", uuid::Uuid::new_v4()));
        let mut s = Store::open(&dir.join("petrel.db")).unwrap();
        let d = s.new_draft("Hello world\nsecond line").unwrap();
        s.set_tags(d.id, &["work".into()]).unwrap();
        (s, dir, d.id)
    }

    fn go(s: &mut Store, key: &str, id: i64, host: &mut RecordingHost) -> RunReport {
        run(s, key, id, None, Source::Ui, host, &CancelToken::default()).unwrap()
    }

    fn save(s: &mut Store, a: Action) -> Action {
        s.save_action(&a, true).unwrap()
    }

    #[test]
    fn a_copy_leaves_the_draft_alone_and_is_logged() {
        let (mut s, dir, id) = setup();
        save(&mut s, act("Copy", json!([{ "type": "clipboard", "text": "[[title]] ([[tags]])" }])));
        let before = s.draft(id).unwrap();
        let mut h = RecordingHost::default();
        let r = go(&mut s, "copy", id, &mut h);
        assert_eq!(r.outcome, RunOutcome::Ok);
        assert_eq!(h.clipboard, "Hello world (work)");
        let after = s.draft(id).unwrap();
        assert_eq!(after.modified_at, before.modified_at, "copying is not an edit");
        assert!(h.calls.contains(&Call::Message(MessageKind::Success, "Copy".into())));
        let log = s.action_log(10).unwrap();
        assert_eq!(
            (log[0].action.as_str(), log[0].status.as_str(), log[0].source.as_str()),
            ("Copy", "ok", "ui")
        );
        let versions = s.versions(id).unwrap();
        assert!(versions.iter().any(|v| v.reason.starts_with("before_action:")), "a version is taken first");
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_step_leaves_the_stored_draft_untouched() {
        let (mut s, dir, id) = setup();
        save(
            &mut s,
            Action {
                after_success: AfterSuccess::Archive,
                add_tags: vec!["done".into()],
                ..act(
                    "Edit then fail",
                    json!([
                        { "type": "insertText", "text": "EDITED ", "position": "start" },
                        { "type": "setFlag", "flagged": true },
                        { "type": "runCommand", "command": "false" }
                    ]),
                )
            },
        );
        let before = s.draft(id).unwrap();
        let mut h = RecordingHost::default();
        h.commands.push_back(Ok(CommandOutput { status: 1, stdout: String::new(), stderr: "nope\n".into() }));
        let r = go(&mut s, "Edit then fail", id, &mut h);
        assert_eq!(r.outcome, RunOutcome::Failed { step: 3, message: "`false` exited with 1: nope".into() });
        let after = s.draft(id).unwrap();
        assert_eq!(
            (after.content.as_str(), after.flagged, after.folder, after.tags.clone()),
            (before.content.as_str(), false, Folder::Inbox, vec!["work".to_string()]),
            "content, flag, folder (after-success) and tags (add_tags) are all as before"
        );
        assert!(matches!(h.calls.last(), Some(Call::Message(MessageKind::Error, m)) if m.contains("step 3")));
        let log = s.action_log(1).unwrap();
        assert_eq!((log[0].status.as_str(), log[0].step), ("failed", Some(3)));
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Review finding D: a save between `prepare` and `finish` (autosave keeps working while steps run) was
    /// overwritten by the action's text, and was not in any version either.
    #[test]
    fn a_save_during_the_run_is_never_overwritten() {
        let (mut s, dir, id) = setup();
        save(
            &mut s,
            Action {
                after_success: AfterSuccess::Archive,
                ..act("Shout", json!([{ "type": "insertText", "text": "SHOUT", "position": "replaceAll" }]))
            },
        );
        let p = prepare(&s, "Shout", id, None, Source::Ui).unwrap();
        s.save(id, "newer typing", 0).unwrap();
        let e = execute(p, &mut RecordingHost::default(), &s, &Paths::for_store(&s), &CancelToken::default());
        let r = finish(&mut s, e).unwrap();
        assert!(matches!(r.outcome, RunOutcome::Conflict { .. }), "{:?}", r.outcome);
        assert!(!r.changed && !r.new_draft);
        let d = s.draft(id).unwrap();
        assert_eq!(
            (d.content.as_str(), d.folder),
            ("newer typing", Folder::Inbox),
            "the save wins; no archive"
        );
        let kept = s.versions(id).unwrap();
        let v =
            kept.iter().find(|v| v.reason.starts_with("action_conflict:")).expect("the result is a version");
        assert_eq!(s.version_content(v.id).unwrap(), "SHOUT");
        assert_eq!(s.action_log(1).unwrap()[0].status, "conflict");

        // Folder, flag and tag changes don't touch the text, so they still apply.
        save(&mut s, act("Flag", json!([{ "type": "setFlag", "flagged": true }])));
        let p = prepare(&s, "Flag", id, None, Source::Ui).unwrap();
        s.save(id, "newer still", 0).unwrap();
        let e = execute(p, &mut RecordingHost::default(), &s, &Paths::for_store(&s), &CancelToken::default());
        assert_eq!(finish(&mut s, e).unwrap().outcome, RunOutcome::Ok);
        let d = s.draft(id).unwrap();
        assert_eq!((d.content.as_str(), d.flagged), ("newer still", true));
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn success_commits_edits_after_success_and_tags_together() {
        let (mut s, dir, id) = setup();
        save(
            &mut s,
            Action {
                after_success: AfterSuccess::Archive,
                add_tags: vec!["Done".into()],
                ..act(
                    "File it",
                    json!([
                        { "type": "insertText", "text": "- [x] ", "position": "start" },
                        { "type": "setTags", "add": ["sent"], "remove": ["work"] },
                        { "type": "setFlag", "flagged": true }
                    ]),
                )
            },
        );
        let r = go(&mut s, "File it", id, &mut RecordingHost::default());
        assert_eq!(r.outcome, RunOutcome::Ok);
        let d = s.draft(id).unwrap();
        assert_eq!(d.content, "- [x] Hello world\nsecond line");
        assert_eq!(d.title, "- [x] Hello world");
        assert_eq!((d.folder, d.flagged), (Folder::Archive, true));
        assert_eq!(d.tags, vec!["done", "sent"]);
        assert_eq!(s.count(Folder::Archive).unwrap(), 1, "the counts follow a commit");
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_dismissed_prompt_stops_cleanly() {
        let (mut s, dir, id) = setup();
        save(
            &mut s,
            Action {
                after_success: AfterSuccess::Trash,
                ..act(
                    "Ask",
                    json!([
                        { "type": "insertText", "text": "x" },
                        { "type": "prompt", "title": "Sure?", "buttons": ["Yes"] },
                        { "type": "clipboard" }
                    ]),
                )
            },
        );
        let mut h = RecordingHost::default();
        h.prompts.push_back(None);
        let r = go(&mut s, "Ask", id, &mut h);
        assert_eq!(r.outcome, RunOutcome::Stopped);
        let d = s.draft(id).unwrap();
        assert_eq!((d.content.as_str(), d.folder), ("Hello world\nsecond line", Folder::Inbox));
        assert!(!h.calls.iter().any(|c| matches!(c, Call::ClipboardSet(_))), "no step after the prompt ran");
        assert!(!h.calls.iter().any(|c| matches!(c, Call::Message(..))), "no error shown");
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prompt_answers_become_template_tags() {
        let (mut s, dir, id) = setup();
        save(
            &mut s,
            act(
                "Greet",
                json!([
                    { "type": "prompt", "title": "Who?", "buttons": ["Hi", "Bye"],
                      "fields": [{ "key": "Name", "label": "Name", "default": "[[title]]" }] },
                    { "type": "clipboard", "text": "[[prompt_button]], [[prompt_name]]" }
                ]),
            ),
        );
        let mut h = RecordingHost::default();
        h.prompts.push_back(Some(PromptReply {
            button: "Bye".into(),
            values: [("Name".to_string(), "Ada".to_string())].into(),
        }));
        go(&mut s, "Greet", id, &mut h);
        assert_eq!(h.clipboard, "Bye, Ada");
        let Some(Call::Prompt(p)) = h.calls.first() else { panic!("{:?}", h.calls) };
        assert_eq!(p.fields[0].default, "Hello world", "field defaults are templates");
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn insert_text_works_in_utf16_like_the_editor() {
        let (mut s, dir, id) = setup();
        s.save(id, "a😀b", 0).unwrap();
        save(
            &mut s,
            act(
                "Wrap",
                json!([{ "type": "insertText", "text": "[[[selection]]]", "position": "replaceSelection", "moveCursor": true }]),
            ),
        );
        let mut h = RecordingHost::default();
        // "😀" is two UTF-16 units: positions 1..3.
        let editor = Some(EditorState { anchor: 1, head: 3 });
        run(&mut s, "Wrap", id, editor, Source::Ui, &mut h, &CancelToken::default()).unwrap();
        let d = s.draft(id).unwrap();
        assert_eq!(d.content, "a[😀]b");
        assert_eq!(d.cursor, 5, "after the inserted text, in UTF-16 units");

        let mut w = WorkingDraft {
            id: 0,
            uuid: String::new(),
            content: "hello".into(),
            tags: vec![],
            flagged: false,
            folder: Folder::Inbox,
            created_at: 0,
            modified_at: 0,
            anchor: 3,
            head: 3,
        };
        let lib = NoLibrary;
        let paths = Paths::default();
        let cancel = CancelToken::default();
        let mut host = RecordingHost::default();
        let mut ctx = test_ctx(&mut w, &mut host, &lib, &paths, &cancel);
        ctx.insert(">", InsertAt::Start, false);
        assert_eq!(
            (ctx.draft.content.as_str(), ctx.draft.head),
            (">hello", 4),
            "the cursor follows its text"
        );
        ctx.insert("!", InsertAt::End, false);
        assert_eq!((ctx.draft.content.as_str(), ctx.draft.head), (">hello!", 4));
        ctx.insert("X", InsertAt::Cursor, true);
        assert_eq!((ctx.draft.content.as_str(), ctx.draft.head), (">helXlo!", 5));
        ctx.insert("new", InsertAt::ReplaceAll, false);
        assert_eq!((ctx.draft.content.as_str(), ctx.draft.head), ("new", 3));
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    struct NoLibrary;
    impl Library for NoLibrary {
        fn find_action(&self, _key: &str) -> Option<Action> {
            None
        }
    }

    fn test_ctx<'a>(
        w: &mut WorkingDraft,
        host: &'a mut RecordingHost,
        library: &'a dyn Library,
        paths: &'a Paths,
        cancel: &'a CancelToken,
    ) -> Ctx<'a> {
        Ctx {
            draft: w.clone(),
            tags: HashMap::new(),
            host,
            library,
            paths,
            cancel,
            deadline: Instant::now() + RUN_LIMIT,
            stack: vec![],
            open: None,
            trusted: vec![],
            checking: vec![],
            allowed: vec![],
            unknown: vec![],
            log: vec![],
        }
    }

    #[test]
    fn run_action_nests_shares_the_draft_and_refuses_cycles() {
        let (mut s, dir, id) = setup();
        save(
            &mut s,
            Action {
                add_tags: vec!["inner".into()],
                ..act("Inner", json!([{ "type": "insertText", "text": "<", "position": "end" }]))
            },
        );
        save(
            &mut s,
            act("Outer", json!([{ "type": "runAction", "action": "inner" }, { "type": "clipboard" }])),
        );
        let mut h = RecordingHost::default();
        assert_eq!(go(&mut s, "Outer", id, &mut h).outcome, RunOutcome::Ok);
        assert_eq!(h.clipboard, "Hello world\nsecond line<", "the outer action sees the inner one's edit");
        assert_eq!(s.draft(id).unwrap().tags, vec!["inner", "work"]);

        save(&mut s, act("Ping", json!([{ "type": "runAction", "action": "Pong" }])));
        save(&mut s, act("Pong", json!([{ "type": "runAction", "action": "Ping" }])));
        let r = go(&mut s, "Ping", id, &mut RecordingHost::default());
        let RunOutcome::Failed { step, message } = r.outcome else { panic!() };
        assert_eq!(step, 1);
        assert!(message.contains("cycle"), "{message}");

        save(&mut s, act("Bad", json!([{ "type": "runCommand", "command": "x" }])));
        save(
            &mut s,
            act(
                "Tolerant",
                json!([{ "type": "runAction", "action": "Bad", "stopOnFail": false }, { "type": "clipboard", "text": "after" }]),
            ),
        );
        let mut h = RecordingHost::default();
        h.commands.push_back(Ok(CommandOutput { status: 2, ..Default::default() }));
        let r = go(&mut s, "Tolerant", id, &mut h);
        assert_eq!(r.outcome, RunOutcome::Ok);
        assert_eq!(h.clipboard, "after");
        assert!(r.log.iter().any(|l| l.contains("in Bad, step 1")), "{:?}", r.log);

        let r = go(&mut s, "Outer", id, &mut RecordingHost::default());
        assert_eq!(r.outcome, RunOutcome::Ok);
        save(&mut s, act("Lost", json!([{ "type": "runAction", "action": "Nobody" }])));
        assert!(matches!(
            go(&mut s, "Lost", id, &mut RecordingHost::default()).outcome,
            RunOutcome::Failed { .. }
        ));
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_editors_json_saves_trusted_and_reports_the_selection() {
        let (mut s, dir, id) = setup();
        // What the window's action editor sends: every field, nulls for engine defaults, `trusted` ignored.
        let sent: Action = serde_json::from_value(json!({
            "uuid": "", "name": "Shout", "group": "", "description": "", "icon": "bolt", "color": "grey",
            "shortcut": "Ctrl+Alt+J", "afterSuccess": "nothing", "addTags": [], "confirm": false,
            "hidden": false, "disabled": false, "trusted": false,
            "steps": [
                { "type": "runCommand", "command": "tr a-z A-Z", "stdin": "[[draft]]", "shell": null,
                  "timeoutSecs": null, "output": "replace", "cwd": null },
                { "type": "insertText", "text": "!", "position": "end", "moveCursor": true }
            ]
        }))
        .unwrap();
        let a = s.save_action(&sent, true).unwrap();
        assert!(a.trusted && !a.uuid.is_empty() && a.group == "Actions");
        let mut h = RecordingHost::default();
        h.commands.push_back(Ok(CommandOutput {
            status: 0,
            stdout: "HELLO\n".into(),
            stderr: String::new(),
        }));
        let r = go(&mut s, "Shout", id, &mut h);
        assert_eq!(r.outcome, RunOutcome::Ok);
        assert!(
            !h.calls.iter().any(|c| matches!(c, Call::ConfirmScope(..))),
            "saved from the editor: no prompt"
        );
        assert!(r.changed);
        assert_eq!(s.draft(id).unwrap().content, "HELLO!");
        assert_eq!((r.selection.anchor, r.selection.head), (6, 6), "the cursor after the inserted text");

        s.seed_default_actions().unwrap();
        let copy = go(&mut s, "Copy to clipboard", id, &mut RecordingHost::default());
        assert!(!copy.changed, "a copy leaves the text alone");
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn untrusted_actions_ask_once_and_trust_is_lost_on_change() {
        let (mut s, dir, id) = setup();
        let elsewhere = std::env::temp_dir().join("petrel-elsewhere");
        let imported = act(
            "Imported",
            json!([
                { "type": "runCommand", "command": "echo [[title]]" },
                { "type": "file", "path": format!("{}/[[safe_title]].md", elsewhere.display()) },
                { "type": "file", "path": "notes/[[safe_title]].md" }
            ]),
        );
        let a = s.save_action(&imported, false).unwrap();
        assert!(!a.trusted, "not saved from the editor");

        let mut h = RecordingHost::default();
        h.confirms.push_back(false);
        assert_eq!(go(&mut s, "Imported", id, &mut h).outcome, RunOutcome::Cancelled);
        let Some(Call::ConfirmScope(name, items)) = h.calls.first() else { panic!("{:?}", h.calls) };
        assert_eq!(name, "Imported");
        assert_eq!(
            items,
            &vec![
                ScopeItem::Command("echo Hello world".into()),
                // Forward slashes on Windows too: `\[[` is the template escape, so a Windows path writes `/`.
                ScopeItem::Path(format!("{}/Hello world.md", elsewhere.display()))
            ],
            "the rendered command and the path outside the Petrel folder, not the one inside"
        );
        assert!(!h.calls.iter().any(|c| matches!(c, Call::RunCommand(_))), "declined: nothing ran");

        let mut h = RecordingHost::default();
        assert_eq!(go(&mut s, "Imported", id, &mut h).outcome, RunOutcome::Ok);
        assert!(s.action("Imported").unwrap().unwrap().trusted, "accepted once, trusted after");
        assert!(
            h.files.contains_key(&dir.join("files/notes/Hello world.md")),
            "relative paths are under files/"
        );

        let mut h = RecordingHost::default();
        go(&mut s, "Imported", id, &mut h);
        assert!(!h.calls.iter().any(|c| matches!(c, Call::ConfirmScope(..))), "no second prompt");

        let mut changed = s.action("Imported").unwrap().unwrap();
        changed.steps = steps(json!([{ "type": "runCommand", "command": "rm -rf ~" }]));
        assert!(!s.save_action(&changed, false).unwrap().trusted, "changed outside the editor: untrusted");
        assert!(s.save_action(&changed, true).unwrap().trusted, "saved from the editor: trusted");
        let same = s.action("Imported").unwrap().unwrap();
        assert!(s.save_action(&same, false).unwrap().trusted, "an unchanged save keeps trust");
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn disabled_cancelled_and_confirmed_runs() {
        let (mut s, dir, id) = setup();
        let mut a = act(
            "Old",
            json!([{ "type": "unsupported", "originalType": "Dropbox" }, { "type": "clipboard" }]),
        );
        a = save(&mut s, a);
        assert!(a.is_disabled());
        let r = go(&mut s, "Old", id, &mut RecordingHost::default());
        assert_eq!(
            r.outcome,
            RunOutcome::Failed { step: 0, message: "contains unsupported steps: Dropbox".into() }
        );

        save(&mut s, Action { confirm: true, ..act("Careful", json!([{ "type": "clipboard" }])) });
        let mut h = RecordingHost::default();
        h.confirms.push_back(false);
        assert_eq!(go(&mut s, "Careful", id, &mut h).outcome, RunOutcome::Cancelled);
        assert_eq!(h.clipboard, "");

        let cancel = CancelToken::default();
        cancel.cancel();
        let r =
            run(&mut s, "Careful", id, None, Source::Action, &mut RecordingHost::default(), &cancel).unwrap();
        assert_eq!(
            r.outcome,
            RunOutcome::Cancelled,
            "chained runs skip the confirm; the cancel still stops it"
        );

        save(&mut s, act("Scripted", json!([{ "type": "script", "script": "draft.content" }])));
        let r = go(&mut s, "Scripted", id, &mut RecordingHost::default());
        assert_eq!(r.outcome, RunOutcome::Failed { step: 1, message: "scripting arrives in 0.3".into() });
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn urls_mail_and_opening_drafts() {
        let (mut s, dir, id) = setup();
        let other = s.new_draft("Other note\n").unwrap();
        save(
            &mut s,
            act(
                "Links",
                json!([
                    { "type": "url", "url": "https://x.test/?q=[[title]]&raw=%%title%%" },
                    { "type": "url", "url": "https://x.test/[[title]]", "encode": false },
                    { "type": "mail", "to": "a@x.test, b@x.test", "subject": "[[title]]", "body": "[[body]]" },
                    { "type": "url", "url": format!("petrel://open?uuid={}", other.uuid) }
                ]),
            ),
        );
        let mut h = RecordingHost::default();
        let r = go(&mut s, "Links", id, &mut h);
        assert_eq!(r.outcome, RunOutcome::Ok);
        let urls: Vec<&str> = h
            .calls
            .iter()
            .filter_map(|c| if let Call::OpenUrl(u) = c { Some(u.as_str()) } else { None })
            .collect();
        assert_eq!(
            urls,
            vec![
                "https://x.test/?q=Hello%20world&raw=Hello world",
                "https://x.test/Hello world",
                "mailto:a%40x.test,b%40x.test?subject=Hello%20world&body=second%20line",
            ]
        );
        assert_eq!(r.open_draft, Some(other.id));

        save(
            &mut s,
            act(
                "Journal",
                json!([{ "type": "openDraft", "title": "Journal [[date|%Y]]", "newIfMissing": true }]),
            ),
        );
        let r = go(&mut s, "Journal", id, &mut RecordingHost::default());
        let opened = s.draft(r.open_draft.unwrap()).unwrap();
        assert!(opened.title.starts_with("Journal 20"), "{}", opened.title);
        let again = go(&mut s, "Journal", id, &mut RecordingHost::default());
        assert_eq!(again.open_draft, r.open_draft, "found by title the second time");
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn command_output_goes_where_asked() {
        let (mut s, dir, id) = setup();
        save(
            &mut s,
            act(
                "Shout",
                json!([
                    { "type": "runCommand", "command": "tr a-z A-Z", "output": "templateTag:loud" },
                    { "type": "clipboard", "text": "[[loud]]" },
                    { "type": "runCommand", "command": "date", "output": "replace" }
                ]),
            ),
        );
        let mut h = RecordingHost::default();
        h.commands.push_back(Ok(CommandOutput {
            status: 0,
            stdout: "HELLO\n".into(),
            stderr: String::new(),
        }));
        h.commands.push_back(Ok(CommandOutput {
            status: 0,
            stdout: "today\n".into(),
            stderr: String::new(),
        }));
        assert_eq!(go(&mut s, "Shout", id, &mut h).outcome, RunOutcome::Ok);
        assert_eq!(h.clipboard, "HELLO", "the trailing newline is dropped");
        assert_eq!(s.draft(id).unwrap().content, "today");
        let Some(Call::RunCommand(c)) = h.calls.first() else { panic!() };
        assert_eq!((c.stdin.as_str(), c.timeout), ("Hello world\nsecond line", COMMAND_LIMIT));
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preview_renders_markdown_and_closing_stops() {
        let (mut s, dir, id) = setup();
        s.save(id, "# Title\n\n*hi*", 0).unwrap();
        save(&mut s, act("Look", json!([{ "type": "htmlPreview" }, { "type": "clipboard" }])));
        let mut h = RecordingHost::default();
        h.previews.push_back(false);
        assert_eq!(go(&mut s, "Look", id, &mut h).outcome, RunOutcome::Stopped);
        let Some(Call::Preview(html)) = h.calls.first() else { panic!() };
        assert!(html.contains("<h1>Title</h1>") && html.contains("<em>hi</em>"), "{html}");
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn steps_read_old_and_new_json() {
        let s: Vec<Step> = steps(json!([
            { "type": "clipboard" },
            { "type": "file", "path": "a.md", "someFieldFromTheFuture": 1 },
            { "type": "runCommand", "command": "ls", "shell": "$SHELL" }
        ]));
        assert_eq!(s[0], Step::Clipboard { text: "[[draft]]".into(), mode: ClipboardMode::Replace });
        assert!(matches!(&s[1], Step::File { mode: WriteMode::Create, create_dirs: true, .. }));
        assert!(matches!(&s[2], Step::RunCommand { shell: Some(Shell::Login), .. }));
        let back: Vec<Step> = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        assert!(serde_json::from_value::<Step>(json!({ "type": "teleport" })).is_err());
    }

    #[test]
    fn the_default_group_is_added_once_and_mirrored() {
        let (mut s, dir, _) = setup();
        assert_eq!(s.seed_default_actions().unwrap(), 7);
        let all = s.actions().unwrap();
        assert_eq!(all.len(), 7);
        assert!(all.iter().all(|a| a.trusted && a.group == "Basics" && !a.description.is_empty()));
        assert_eq!(all[0].name, "Copy to clipboard");
        assert_eq!(all[0].shortcut.as_deref(), Some("c"));
        let mirror = dir.join("actions/Basics/Copy as Markdown link.json");
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&mirror).unwrap()).unwrap();
        assert_eq!(doc["format"], "petrel-action");
        assert!(doc["action"].get("trusted").is_none(), "trust is not in the file");
        assert!(s.delete_action(&all[1].uuid).unwrap());
        assert!(!mirror.exists());
        assert_eq!(s.seed_default_actions().unwrap(), 0, "deleting a default sticks");

        let mut renamed = all[0].clone();
        renamed.name = "Copy all".into();
        s.save_action(&renamed, true).unwrap();
        assert!(dir.join("actions/Basics/Copy all.json").exists());
        assert!(!dir.join("actions/Basics/Copy to clipboard.json").exists(), "a rename moves the mirror");
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn default_actions_render_as_intended() {
        let (mut s, dir, id) = setup();
        s.seed_default_actions().unwrap();
        let mut h = RecordingHost::default();
        go(&mut s, "Copy as Markdown link", id, &mut h);
        let uuid = s.draft(id).unwrap().uuid;
        assert_eq!(h.clipboard, format!("[Hello world](petrel://open?uuid={uuid})"));
        let mut h = RecordingHost::default();
        assert_eq!(go(&mut s, "Append to journal", id, &mut h).outcome, RunOutcome::Ok);
        let (path, text) = h.files.iter().next().unwrap();
        assert!(path.parent().unwrap().ends_with("Documents/Petrel/Journal"), "{}", path.display());
        assert!(text.ends_with("\n\nHello world\nsecond line\n"), "{text:?}");
        let r = go(&mut s, "Search the web", id, &mut RecordingHost::default());
        assert_eq!(r.outcome, RunOutcome::Ok);
        let mut h = RecordingHost::default();
        let r = go(&mut s, "Open as URL", id, &mut h);
        assert_eq!(
            r.outcome,
            RunOutcome::Failed { step: 1, message: "“Hello world” is not a link".into() },
            "plain text never reaches the system opener"
        );
        assert!(!h.calls.iter().any(|c| matches!(c, Call::OpenUrl(_))));
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_older_default_list_is_brought_up_to_date_where_unchanged() {
        let (mut s, dir, _) = setup();
        let old =
            |name: &str, steps: serde_json::Value| Action { group: "Basics".into(), ..act(name, steps) };
        save(&mut s, old("Copy", json!([{ "type": "clipboard" }])));
        save(&mut s, old("Copy with wl-copy", json!([{ "type": "runCommand", "command": "wl-copy" }])));
        save(&mut s, old("Save to file", json!([{ "type": "file", "path": "~/Notes/[[safe_title]].md" }])));
        save(
            &mut s,
            old(
                "Append to journal",
                json!([{ "type": "file", "path": "journal/[[date]].md", "mode": "append",
                         "text": "\n## [[time]]\n\n[[draft]]\n" }]),
            ),
        );
        s.conn.execute("INSERT INTO meta (key, value) VALUES ('actions_seeded', '1')", []).unwrap();

        assert_eq!(s.seed_default_actions().unwrap(), 3);
        let names: Vec<String> = s.actions().unwrap().into_iter().map(|a| a.name).collect();
        assert!(names.contains(&"Copy to clipboard".to_string()) && !names.contains(&"Copy".to_string()));
        assert!(!names.iter().any(|n| n.contains("wl-copy")), "the duplicate copy is gone");
        let journal = s.action("Append to journal").unwrap().unwrap();
        assert!(journal.trusted && !journal.description.is_empty());
        assert!(
            matches!(&journal.steps[0], Step::File { path, .. } if path.starts_with("~/Documents/Petrel/Journal"))
        );
        let save_to = s.action("Save to file").unwrap().unwrap();
        assert!(
            matches!(&save_to.steps[0], Step::File { path, .. } if path.starts_with("~/Notes")),
            "an edited default is left alone"
        );
        assert!(save_to.description.is_empty());
        assert_eq!(s.seed_default_actions().unwrap(), 0, "once");
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unknown_tags_are_reported_and_left() {
        let (mut s, dir, id) = setup();
        save(&mut s, act("Typo", json!([{ "type": "clipboard", "text": "[[titel]]" }])));
        let mut h = RecordingHost::default();
        let r = go(&mut s, "Typo", id, &mut h);
        assert_eq!(h.clipboard, "[[titel]]");
        assert_eq!(r.unknown_tags, vec!["[[titel]]"]);
        assert!(s.action_log(1).unwrap()[0].message.contains("unknown template tag [[titel]]"));
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn paths_expand_home_and_variables() {
        std::env::set_var("PETREL_TEST_DIR", "/srv/notes");
        let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
        assert_eq!(expand_vars("~/a"), format!("{home}/a"));
        assert_eq!(expand_vars("$PETREL_TEST_DIR/x"), "/srv/notes/x");
        assert_eq!(expand_vars("${PETREL_TEST_DIR}x"), "/srv/notesx");
        assert_eq!(expand_vars("cost $5"), "cost $5");
        assert_eq!(percent_decode("a%20b+c%2"), "a b c%2");
    }
}
