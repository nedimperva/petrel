//! AI on request. Nothing here runs unless the person asks: a key in the OS keyring turns it on, and every call
//! is one button, one `Ctrl J` choice or one question in `Ctrl K`. Requests go from Rust straight to the Claude
//! API (there is no Rust SDK, so this is the plain Messages HTTP call); the webview never sees the key and its
//! CSP still allows no network.
//!
//! A rewrite never lands on its own: the UI shows it in place and the person keeps or drops it, and the note's
//! current text is kept as a version first (`snapshot_note`).

use std::collections::HashMap;
use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use petrel_core::notes::Note;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};

use crate::AppState;

type R<T> = Result<T, String>;

const KEYRING_SERVICE: &str = "petrel";
const KEYRING_USER: &str = "anthropic-api-key";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";
/// On a safety decline the API runs the request again on Anthropic's recommended fallback model, in the same
/// call, instead of handing back a refusal.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MODEL: &str = "claude-opus-5-5";
const MODEL_SETTING: &str = "ai.model";
/// Small jobs (a title, tidying, a list, where a capture goes) go to a faster, cheaper model.
const FAST_MODEL: &str = "claude-haiku-5-5";
const FAST_MODEL_SETTING: &str = "ai.model_fast";
/// How much of a note goes to the model, at most. Long notes are cut at a line, from the end.
const NOTE_CHARS: usize = 12_000;

const SYSTEM: &str = "You work inside Petrel, a personal notes app. The text you get is the user's own \
Markdown notes. Keep their language (if a note is in Bosnian, answer in Bosnian), their voice and their \
Markdown. Reply with only what was asked for: no preamble, no closing remarks, no code fences around the \
whole reply.";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Task {
    /// Replaces the selection.
    Tidy,
    Shorten,
    List,
    Checklist,
    /// The selection rewritten by the person's own instruction.
    Custom,
    /// Shown beside the text; inserted only if asked.
    Explain,
    /// Inserted at the cursor.
    Continue,
    Summarize,
    Title,
    /// One of the owner's own prompts (the Prompts collection, blanks filled), run on the selection or the note.
    Prompt,
}

impl Task {
    fn instruction(self) -> &'static str {
        match self {
            Task::Tidy => {
                "Tidy the formatting of this Markdown: headings, lists, spacing, punctuation and obvious \
                typos. Keep every idea and the wording where it already works. Return the tidied Markdown."
            }
            Task::Shorten => {
                "Make this shorter, about half the length, keeping every point that matters. Return \
                the shorter text."
            }
            Task::List => "Turn this into a clear Markdown bullet list, one idea per item. Return the list.",
            Task::Checklist => {
                "Turn this into a Markdown checklist (`- [ ] `), one task per line, each starting \
                with a verb. Return the checklist."
            }
            Task::Custom => "Rewrite this text as the instruction says. Return only the rewritten text.",
            Task::Explain => {
                "Explain this simply, in a few short sentences, for someone who wrote it in a hurry \
                and comes back later."
            }
            Task::Continue => {
                "Continue writing from where the text stops, in the same voice and format: one to \
                three short paragraphs, or the next few items if it is a list. Return only the new text."
            }
            Task::Summarize => "Summarize this in two to four sentences. Return only the summary.",
            Task::Title => {
                "Suggest one short title for this note, at most six words, no quotes and no full \
                stop. Return only the title."
            }
            Task::Prompt => "Do what the prompt below asks with this text. Return only the result.",
        }
    }

    /// The small mechanical jobs, which the fast model does as well and sooner.
    fn is_small(self) -> bool {
        matches!(self, Task::Tidy | Task::List | Task::Checklist | Task::Shorten | Task::Title)
    }

    /// Rewrites want speed; reading and answering is given more thought.
    fn effort(self) -> &'static str {
        match self {
            Task::Explain | Task::Summarize | Task::Continue | Task::Prompt => "medium",
            _ => "low",
        }
    }
}

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| anyhow!("the keyring: {e}"))
}

/// The key from the keyring, or `ANTHROPIC_API_KEY` for a development build.
fn api_key() -> Result<Option<String>> {
    match entry()?.get_password() {
        Ok(k) if !k.trim().is_empty() => return Ok(Some(k)),
        Ok(_) | Err(keyring::Error::NoEntry) => {}
        Err(e) => {
            if cfg!(debug_assertions) {
                log::warn!("reading the AI key from the keyring: {e}");
            } else {
                bail!("cannot read the AI key from the keyring: {e}")
            }
        }
    }
    Ok(std::env::var("ANTHROPIC_API_KEY").ok().filter(|k| !k.trim().is_empty()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    ready: bool,
    model: String,
    fast_model: String,
    /// Why the key can't be read (no keyring running, say).
    error: Option<String>,
}

fn setting_or(state: &AppState, key: &str, default: &str) -> String {
    state
        .store
        .lock()
        .ok()
        .and_then(|s| s.setting(key).ok().flatten())
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| default.into())
}

fn model(state: &AppState) -> String {
    setting_or(state, MODEL_SETTING, MODEL)
}

fn fast_model(state: &AppState) -> String {
    setting_or(state, FAST_MODEL_SETTING, FAST_MODEL)
}

#[tauri::command]
pub fn ai_status(state: State<AppState>) -> AiStatus {
    let (ready, error) = match api_key() {
        Ok(k) => (k.is_some(), None),
        Err(e) => (false, Some(format!("{e:#}"))),
    };
    AiStatus { ready, model: model(&state), fast_model: fast_model(&state), error }
}

/// Stores the key in the OS keyring (`None` or empty removes it). It is never written to the database or a file.
#[tauri::command]
pub fn set_ai_key(state: State<AppState>, key: Option<String>) -> R<AiStatus> {
    let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    let e = entry().map_err(|e| format!("{e:#}"))?;
    match key {
        Some(k) => {
            if !k.starts_with("sk-ant-") {
                return Err("that does not look like a Claude API key (they start with sk-ant-)".into());
            }
            e.set_password(&k).map_err(|e| format!("saving the key in the keyring: {e}"))?
        }
        None => match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("removing the key: {e}")),
        },
    }
    Ok(ai_status(state))
}

/// The two models (Settings › AI): the one for writing and answering, the fast one for small jobs. Empty puts
/// the default back.
#[tauri::command]
pub fn set_ai_models(state: State<AppState>, model: String, fast_model: String) -> R<AiStatus> {
    for m in [&model, &fast_model] {
        let m = m.trim();
        if !m.is_empty() && (!m.starts_with("claude-") || m.len() > 64 || m.contains(char::is_whitespace)) {
            return Err(format!("{m} does not look like a Claude model name (they start with claude-)"));
        }
    }
    {
        let store = state.store.lock().map_err(|_| "store lock poisoned".to_string())?;
        store.set_setting(MODEL_SETTING, model.trim()).map_err(|e| format!("{e:#}"))?;
        store.set_setting(FAST_MODEL_SETTING, fast_model.trim()).map_err(|e| format!("{e:#}"))?;
    }
    Ok(ai_status(state))
}

/// One agent for every call, so the connection to the API is kept between asks.
fn agent() -> ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            ureq::Agent::config_builder()
                .http_status_as_error(false)
                .timeout_connect(Some(Duration::from_secs(20)))
                // A streamed reply sends something every few seconds; a long silence means the line is gone.
                .timeout_recv_body(Some(Duration::from_secs(600)))
                .build()
                .into()
        })
        .clone()
}

/// What a call used, for the line under an answer.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
}

impl Usage {
    fn add(&mut self, u: &Value) {
        let n = |k: &str| u[k].as_u64();
        if let Some(v) = n("input_tokens") {
            self.input_tokens = v;
        }
        if let Some(v) = n("output_tokens") {
            self.output_tokens = v;
        }
        if let Some(v) = n("cache_read_input_tokens") {
            self.cache_read_tokens = v;
        }
        if let Some(v) = n("cache_creation_input_tokens") {
            self.cache_write_tokens = v;
        }
    }
}

/// A reply shown as it is written: each piece of text goes to the window as `petrel-ai` with this id, and
/// `ai_cancel` with the id stops it.
struct Live {
    app: tauri::AppHandle,
    id: String,
    cancel: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
struct Piece<'a> {
    id: &'a str,
    text: &'a str,
}

fn running() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

impl Live {
    fn new(app: &tauri::AppHandle, id: Option<String>) -> Option<Live> {
        let id = id.filter(|i| !i.is_empty())?;
        let cancel = Arc::new(AtomicBool::new(false));
        if let Ok(mut r) = running().lock() {
            r.insert(id.clone(), cancel.clone());
        }
        Some(Live { app: app.clone(), id, cancel })
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        if let Ok(mut r) = running().lock() {
            r.remove(&self.id);
        }
    }
}

/// Stops a reply that is being written. The connection is dropped, so the model stops too.
#[tauri::command]
pub fn ai_cancel(id: String) {
    if let Some(c) = running().lock().ok().and_then(|r| r.get(&id).cloned()) {
        c.store(true, Ordering::Relaxed);
    }
}

/// One Messages call, streamed. `content` is the user turn: a string, or blocks (so a long part that repeats
/// can be cached). Returns the reply's text and what it used.
fn complete(
    model: &str,
    effort: &str,
    system: &str,
    content: Value,
    max_tokens: u32,
    live: Option<&Live>,
) -> Result<(String, Usage)> {
    let key = api_key()?.context("add a Claude API key in Settings (Ctrl ,) to use AI")?;
    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "output_config": { "effort": effort },
        "stream": true,
        "messages": [{ "role": "user", "content": content }],
    });
    // Haiku has no server-side fallback and refuses the field.
    let fallback = !model.contains("haiku");
    if fallback {
        body["fallbacks"] = json!("default");
    }
    let mut req = agent()
        .post(API_URL)
        .header("x-api-key", &key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json");
    if fallback {
        req = req.header("anthropic-beta", FALLBACK_BETA);
    }
    let mut resp = req.send_json(&body).map_err(|e| anyhow!("cannot reach the Claude API: {e}"))?;
    let status = resp.status().as_u16();
    if status != 200 {
        let v: Value = resp.body_mut().read_json().unwrap_or(Value::Null);
        let msg = v["error"]["message"].as_str().unwrap_or("no message");
        bail!(match status {
            401 => "the Claude API key was refused; check it in Settings".to_string(),
            429 => format!("the Claude API is rate limiting this key; try again shortly ({msg})"),
            529 | 503 => "the Claude API is overloaded; try again in a moment".to_string(),
            _ => format!("the Claude API said {status}: {msg}"),
        });
    }
    let mut usage = Usage { model: model.to_string(), ..Usage::default() };
    let mut text = String::new();
    let mut stop = String::new();
    let reader = std::io::BufReader::new(resp.body_mut().as_reader());
    for line in reader.lines() {
        if live.is_some_and(|l| l.cancel.load(Ordering::Relaxed)) {
            bail!("stopped");
        }
        let line = line.map_err(|e| anyhow!("reading the reply: {e}"))?;
        let Some(data) = line.strip_prefix("data:") else { continue };
        let Ok(v) = serde_json::from_str::<Value>(data.trim()) else { continue };
        match v["type"].as_str().unwrap_or("") {
            "message_start" => usage.add(&v["message"]["usage"]),
            "content_block_delta" if v["delta"]["type"] == "text_delta" => {
                let piece = v["delta"]["text"].as_str().unwrap_or("");
                text.push_str(piece);
                if let Some(l) = live {
                    let _ = l.app.emit("petrel-ai", Piece { id: &l.id, text: piece });
                }
            }
            "message_delta" => {
                usage.add(&v["usage"]);
                if let Some(r) = v["delta"]["stop_reason"].as_str() {
                    stop = r.to_string();
                }
            }
            "error" => {
                let msg = v["error"]["message"].as_str().unwrap_or("no message");
                bail!(if v["error"]["type"] == "overloaded_error" {
                    "the Claude API is overloaded; try again in a moment".to_string()
                } else {
                    format!("the Claude API stopped: {msg}")
                });
            }
            "message_stop" => break,
            _ => {}
        }
    }
    if stop == "refusal" {
        bail!("Claude declined this one");
    }
    if stop == "max_tokens" {
        log::warn!("AI reply cut at max_tokens");
    }
    let text = strip_fence(text.trim()).to_string();
    if text.is_empty() {
        bail!("Claude sent back nothing");
    }
    Ok((text, usage))
}

/// A reply wrapped in one ```markdown fence, despite being asked not to.
fn strip_fence(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("```") else { return text };
    let Some(nl) = rest.find('\n') else { return text };
    let inner = &rest[nl + 1..];
    inner.strip_suffix("```").map(str::trim_end).unwrap_or(text)
}

/// The end of a long text, cut at a line.
fn tail(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut from = text.len() - max;
    while !text.is_char_boundary(from) {
        from += 1;
    }
    let cut = &text[from..];
    cut.find('\n').map(|i| &cut[i + 1..]).unwrap_or(cut)
}

fn head(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut to = max;
    while !text.is_char_boundary(to) {
        to -= 1;
    }
    &text[..to]
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("the AI call stopped: {e}"))?
        .map_err(|e| format!("{e:#}"))
}

/// One writing task on `text` (the selection, or the text above the cursor). `context` is the whole note, for
/// tasks that read better knowing where the text sits. `instruction` is the person's own, for `custom`.
#[tauri::command]
pub async fn ai_write(
    app: tauri::AppHandle,
    task: Task,
    text: String,
    context: Option<String>,
    instruction: Option<String>,
    note_id: Option<i64>,
    stream_id: Option<String>,
) -> R<Written> {
    if text.trim().is_empty() {
        return Err("there is no text to work on".into());
    }
    let state = app.state::<AppState>();
    let model = if task.is_small() { fast_model(&state) } else { model(&state) };
    let live = Live::new(&app, stream_id);
    // A rewrite may replace text: keep what the note is now, whether or not the person keeps the result.
    if let (Some(id), false) = (note_id, matches!(task, Task::Explain | Task::Title)) {
        let mut store = state.store.lock().map_err(|_| "store lock poisoned".to_string())?;
        if let Err(e) = store.snapshot_note(id, "ai") {
            log::warn!("version before AI: {e:#}");
        }
    }
    blocking(move || {
        let mut user = String::new();
        if let Some(c) = context.as_deref().filter(|c| c.trim() != text.trim()) {
            user += &format!("<note>\n{}\n</note>\n\n", head(c, NOTE_CHARS));
        }
        let text = if task == Task::Continue { tail(&text, NOTE_CHARS) } else { head(&text, NOTE_CHARS) };
        user += &format!("<text>\n{text}\n</text>\n\n{}", task.instruction());
        if task == Task::Custom {
            let i = instruction.filter(|i| !i.trim().is_empty()).context("say what to do with the text")?;
            user += &format!("\n\nInstruction: {i}");
        } else if task == Task::Prompt {
            let i = instruction.filter(|i| !i.trim().is_empty()).context("the prompt is empty")?;
            user += &format!("\n\n<prompt>\n{}\n</prompt>", head(&i, NOTE_CHARS));
        }
        let (text, usage) = complete(&model, task.effort(), SYSTEM, json!(user), 8_000, live.as_ref())?;
        Ok(Written { text, usage })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    text: String,
    usage: Usage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    id: i64,
    title: String,
    folder: String,
    preview: String,
}

impl From<&Note> for Source {
    fn from(n: &Note) -> Self {
        Source {
            id: n.id,
            title: n.title.clone(),
            folder: n.folder.clone(),
            preview: head(n.body.trim(), 160).to_string(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    answer: String,
    sources: Vec<Source>,
    /// Every note the answer was given from, for a question that follows it.
    read: Vec<i64>,
    usage: Option<Usage>,
}

/// A question already asked in this exchange, and its answer.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    question: String,
    answer: String,
}

/// Turns of an exchange sent back, at most: a long talk is a note, not a question.
const EARLIER_MAX: usize = 6;

const ASK_NOTES: usize = 8;

/// Answers a question from the notes: the best-matching notes go to the model and it answers from them alone,
/// naming the ones it used. The sources are the notes it named (or all it read if it named none). A follow-up
/// (Tab after an answer) sends the earlier turns and the same notes (`notes`) instead of searching again.
#[tauri::command]
pub async fn ai_ask(
    app: tauri::AppHandle,
    question: String,
    earlier: Option<Vec<Exchange>>,
    notes: Option<Vec<i64>>,
    stream_id: Option<String>,
) -> R<Answer> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("ask something".into());
    }
    let state = app.state::<AppState>();
    let model = model(&state);
    let live = Live::new(&app, stream_id);
    let earlier = earlier.unwrap_or_default();
    let notes = {
        let store = state.store.lock().map_err(|_| "store lock poisoned".to_string())?;
        match notes.filter(|ids| !ids.is_empty()) {
            Some(ids) => ids.iter().take(ASK_NOTES).filter_map(|&id| store.peek_note(id).ok()).collect(),
            None => store.notes_about(&question, ASK_NOTES).map_err(|e| format!("{e:#}"))?,
        }
    };
    blocking(move || {
        if notes.is_empty() {
            return Ok(Answer {
                answer: "Nothing in your notes seems to be about that.".into(),
                sources: Vec::new(),
                read: Vec::new(),
                usage: None,
            });
        }
        let mut shown = String::from("Here are the notes that matched best:\n\n");
        for (i, n) in notes.iter().enumerate() {
            shown += &format!(
                "<note n=\"{}\" title=\"{}\" folder=\"{}\">\n{}\n</note>\n\n",
                i + 1,
                n.title.replace('"', "'"),
                n.folder,
                head(&n.body, NOTE_CHARS / 2)
            );
        }
        let mut user = String::new();
        let skip = earlier.len().saturating_sub(EARLIER_MAX);
        for e in earlier.iter().skip(skip) {
            user += &format!(
                "<earlier>\nQuestion: {}\nAnswer: {}\n</earlier>\n\n",
                head(e.question.trim(), 2_000),
                head(e.answer.trim(), 6_000)
            );
        }
        if !earlier.is_empty() {
            user += "The question below follows the earlier ones; read it in their light.\n\n";
        }
        user += &format!(
            "Question: {question}\n\nAnswer from these notes only, briefly, in Markdown. If they do not say, \
             say so in one sentence. After a sentence that comes from a note, put the note's number in \
             brackets, like `[2]`. End with a last line `Sources: ` and the numbers of the notes you used, \
             like `Sources: 2, 5`."
        );
        // The notes come first and stay the same through a follow-up, so they are marked for the cache: a
        // second question on them is read at a tenth of the price.
        let content = json!([
            { "type": "text", "text": shown, "cache_control": { "type": "ephemeral" } },
            { "type": "text", "text": user },
        ]);
        let (reply, usage) = complete(&model, "medium", SYSTEM, content, 8_000, live.as_ref())?;
        let (answer, used) = split_sources(&reply, notes.len());
        let titles: Vec<&str> = notes.iter().map(|n| n.title.as_str()).collect();
        let answer = cite(&answer, &titles);
        let sources: Vec<Source> = if used.is_empty() {
            notes.iter().take(3).map(Source::from).collect()
        } else {
            used.iter().map(|&i| Source::from(&notes[i])).collect()
        };
        let read = notes.iter().map(|n| n.id).collect();
        Ok(Answer { answer, sources, read, usage: Some(usage) })
    })
    .await
}

/// `[2]` and `[1, 3]` in an answer become links to those notes, `[[Title]]`, so the answer names where each
/// sentence came from and a saved answer keeps working links. Numbers that name no note are dropped; other
/// brackets (a `[[link]]`, a Markdown `[text](url)`, a checkbox) are left alone.
fn cite(answer: &str, titles: &[&str]) -> String {
    let mut out = String::with_capacity(answer.len());
    let mut rest = answer;
    while let Some(i) = rest.find('[') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let before_bracket = out.ends_with('[');
        let close = after.find(']');
        let inner = close.map(|c| &after[..c]).unwrap_or("");
        let is_cite = !before_bracket
            && !inner.is_empty()
            && inner.chars().all(|c| c.is_ascii_digit() || c == ',' || c == ' ')
            && inner.chars().any(|c| c.is_ascii_digit())
            && !after[close.unwrap() + 1..].starts_with(['(', ']'])
            && !after.starts_with('[');
        if !is_cite {
            out.push('[');
            rest = after;
            continue;
        }
        let links: Vec<String> = inner
            .split(|c: char| !c.is_ascii_digit())
            .filter_map(|w| w.parse::<usize>().ok())
            .filter_map(|n| titles.get(n.wrapping_sub(1)))
            .map(|t| format!("[[{t}]]"))
            .collect();
        if !links.is_empty() {
            if !out.ends_with(' ') && !out.is_empty() {
                out.push(' ');
            }
            out.push_str(&links.join(" "));
        } else if out.ends_with(' ') {
            out.pop();
        }
        rest = &after[close.unwrap() + 1..];
    }
    out.push_str(rest);
    out
}

/// The answer without its `Sources:` line, and the 0-based notes it named.
fn split_sources(reply: &str, count: usize) -> (String, Vec<usize>) {
    let trimmed = reply.trim_end();
    let (body, last) = match trimmed.rfind('\n') {
        Some(i) => (&trimmed[..i], trimmed[i + 1..].trim()),
        None => ("", trimmed),
    };
    let Some(list) = last.strip_prefix("Sources:").or_else(|| last.strip_prefix("**Sources:**")) else {
        return (trimmed.to_string(), Vec::new());
    };
    let mut used = Vec::new();
    for n in list.split(|c: char| !c.is_ascii_digit()).filter_map(|w| w.parse::<usize>().ok()) {
        if (1..=count).contains(&n) && !used.contains(&(n - 1)) {
            used.push(n - 1);
        }
    }
    (body.trim_end().to_string(), used)
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// `merge` into an existing note (`note_id`), or `move` to a folder as its own note.
    pub kind: String,
    pub note_id: Option<i64>,
    pub folder: String,
    pub title: String,
    pub why: String,
}

/// Where a capture in the inbox could go (the inbox's `s`): up to three places among the notes that look
/// related and the folders that exist. Only asked for, never run on its own.
#[tauri::command]
pub async fn ai_suggest_home(app: tauri::AppHandle, note_id: i64) -> R<Vec<Suggestion>> {
    let state = app.state::<AppState>();
    let model = fast_model(&state);
    let (capture, candidates, folders) = {
        let store = state.store.lock().map_err(|_| "store lock poisoned".to_string())?;
        let capture = store.peek_note(note_id).map_err(|e| format!("{e:#}"))?;
        let candidates: Vec<Note> = store
            .notes_about(&capture.body, 16)
            .map_err(|e| format!("{e:#}"))?
            .into_iter()
            .filter(|n| n.id != note_id && n.folder != petrel_core::notes::INBOX_DIR)
            .take(10)
            .collect();
        let folders: Vec<String> = store
            .note_folders()
            .map_err(|e| format!("{e:#}"))?
            .into_iter()
            .map(|f| f.path)
            .filter(|p| !p.is_empty() && p != petrel_core::notes::INBOX_DIR)
            .collect();
        (capture, candidates, folders)
    };
    blocking(move || {
        let mut user = format!("<capture>\n{}\n</capture>\n\nNotes that may be related:\n", head(&capture.body, 4000));
        for n in &candidates {
            user += &format!(
                "- id {} \"{}\" in \"{}\": {}\n",
                n.id,
                n.title,
                n.folder,
                head(n.body.trim(), 200).replace('\n', " ")
            );
        }
        user += &format!("\nFolders: {}\n\n", folders.join(", "));
        user += "Where should this capture go? Give one to three choices, best first, as a JSON array only. \
            Each item is {\"kind\": \"merge\", \"noteId\": <id>, \"why\": \"...\"} to add it to a listed note, or \
            {\"kind\": \"move\", \"folder\": \"<an existing folder, or a short new one>\", \"title\": \"<a title \
            for it as its own note>\", \"why\": \"...\"}. `why` is at most ten words.";
        let (reply, _) = complete(&model, "low", SYSTEM, json!(user), 2_000, None)?;
        Ok(parse_suggestions(&reply, &candidates))
    })
    .await
}

fn parse_suggestions(reply: &str, candidates: &[Note]) -> Vec<Suggestion> {
    let (Some(a), Some(b)) = (reply.find('['), reply.rfind(']')) else { return Vec::new() };
    let Ok(items) = serde_json::from_str::<Vec<Value>>(&reply[a..=b]) else { return Vec::new() };
    items
        .into_iter()
        .filter_map(|v| {
            let why = v["why"].as_str().unwrap_or("").to_string();
            match v["kind"].as_str()? {
                "merge" => {
                    let id = v["noteId"].as_i64()?;
                    let n = candidates.iter().find(|n| n.id == id)?;
                    Some(Suggestion {
                        kind: "merge".into(),
                        note_id: Some(id),
                        folder: n.folder.clone(),
                        title: n.title.clone(),
                        why,
                    })
                }
                "move" => Some(Suggestion {
                    kind: "move".into(),
                    note_id: None,
                    folder: petrel_core::notes::clean_folder(v["folder"].as_str()?),
                    title: petrel_core::notes::clean_title(v["title"].as_str().unwrap_or("")),
                    why,
                }),
                _ => None,
            }
        })
        .take(3)
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Related {
    id: i64,
    title: String,
    folder: String,
    why: String,
}

/// The writing page's "Find related notes": notes that share words with this one, and the model's one line on
/// how each relates. Notes it finds unrelated are left out.
#[tauri::command]
pub async fn ai_related(app: tauri::AppHandle, note_id: i64) -> R<Vec<Related>> {
    let state = app.state::<AppState>();
    let model = fast_model(&state);
    let (note, candidates) = {
        let store = state.store.lock().map_err(|_| "store lock poisoned".to_string())?;
        let note = store.peek_note(note_id).map_err(|e| format!("{e:#}"))?;
        let words = format!("{} {}", note.title, head(&note.body, 2000));
        let c: Vec<Note> = store
            .notes_about(&words, 14)
            .map_err(|e| format!("{e:#}"))?
            .into_iter()
            .filter(|n| n.id != note_id)
            .take(10)
            .collect();
        (note, c)
    };
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    blocking(move || {
        let mut user = format!("<note title=\"{}\">\n{}\n</note>\n\nOther notes:\n", note.title, head(&note.body, 6000));
        for n in &candidates {
            user += &format!("- id {} \"{}\": {}\n", n.id, n.title, head(n.body.trim(), 240).replace('\n', " "));
        }
        user += "\nWhich of the other notes really relate to this one? Reply with a JSON array only, best first, \
            at most five: [{\"id\": <id>, \"why\": \"<how it relates, at most eight words>\"}]. Leave out notes that \
            only share a word.";
        let (reply, _) = complete(&model, "low", SYSTEM, json!(user), 2_000, None)?;
        let (Some(a), Some(b)) = (reply.find('['), reply.rfind(']')) else { return Ok(Vec::new()) };
        let items: Vec<Value> = serde_json::from_str(&reply[a..=b]).unwrap_or_default();
        Ok(items
            .iter()
            .filter_map(|v| {
                let n = candidates.iter().find(|n| Some(n.id) == v["id"].as_i64())?;
                Some(Related {
                    id: n.id,
                    title: n.title.clone(),
                    folder: n.folder.clone(),
                    why: v["why"].as_str().unwrap_or("").to_string(),
                })
            })
            .collect())
    })
    .await
}

/// How much of the week goes to the model, at most, all notes together.
const WEEK_CHARS: usize = 40_000;

/// "The week, when you ask": a few sentences on what the notes changed between `from` and `to` were about. The
/// counts and the open tasks are worked out on the page, without AI; this is only the prose. Never runs by itself.
#[tauri::command]
pub async fn ai_week(app: tauri::AppHandle, from: i64, to: i64) -> R<String> {
    let state = app.state::<AppState>();
    let model = model(&state);
    let notes = {
        let store = state.store.lock().map_err(|_| "store lock poisoned".to_string())?;
        store.notes_between(from, to).map_err(|e| format!("{e:#}"))?
    };
    if notes.is_empty() {
        return Err("nothing was written in these days".into());
    }
    blocking(move || {
        let mut user = String::from("These are the notes the user wrote or changed this week, newest first:\n\n");
        let each = (WEEK_CHARS / notes.len()).clamp(400, 4_000);
        for n in &notes {
            let what = if n.folder == petrel_core::notes::INBOX_DIR { "capture" } else { "note" };
            user += &format!(
                "<{what} title=\"{}\" folder=\"{}\">\n{}\n</{what}>\n\n",
                n.title.replace('"', "'"),
                n.folder,
                head(n.body.trim(), each)
            );
            if user.len() > WEEK_CHARS {
                break;
            }
        }
        user += "Write a short look back on this week for the user: what the week went to and what moved \
            forward, in two short paragraphs at most, warm and plain, speaking to them as you. Name notes as \
            [[Title]] links where it helps (only titles listed above, never captures, which have only a time as \
            a title). Do not list open tasks or count things: the page shows those. No headings, no bullet list.";
        Ok(complete(&model, "medium", SYSTEM, json!(user), 2_000, None)?.0)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fences_and_cuts() {
        assert_eq!(strip_fence("```markdown\n# Hi\n- a\n```"), "# Hi\n- a");
        assert_eq!(strip_fence("plain"), "plain");
        assert_eq!(tail("one\ntwo\nthree", 7), "three");
        assert_eq!(head("čćž", 3), "č");
    }

    #[test]
    fn citations_become_links() {
        let t = ["Trip to Mostar", "Summer 2026"];
        assert_eq!(cite("Park above the old town [1]. Photos are in June [2, 1].", &t), "Park above the old town [[Trip to Mostar]]. Photos are in June [[Summer 2026]] [[Trip to Mostar]].");
        assert_eq!(
            cite("See [[Trip to Mostar]] and [a](b) and [ ] done [9].", &t),
            "See [[Trip to Mostar]] and [a](b) and [ ] done."
        );
    }

    #[test]
    fn sources_line() {
        let (a, used) = split_sources("Tomatoes need sun.\n\nSources: 2, 1, 2, 9", 3);
        assert_eq!(a, "Tomatoes need sun.");
        assert_eq!(used, vec![1, 0]);
        let (a, used) = split_sources("No idea.", 3);
        assert_eq!((a.as_str(), used.len()), ("No idea.", 0));
    }

    #[test]
    fn suggestions_keep_only_real_notes() {
        let note = |id, title: &str| Note {
            id,
            path: format!("work/{title}.md"),
            folder: "work".into(),
            title: title.into(),
            body: String::new(),
            tags: vec![],
            pinned: false,
            hash: String::new(),
            created_at: 0,
            modified_at: 0,
            version_count: 0,
        };
        let c = [note(4, "Tern release")];
        let got = parse_suggestions(
            "Here: [{\"kind\":\"merge\",\"noteId\":4,\"why\":\"same release\"},\
             {\"kind\":\"merge\",\"noteId\":99,\"why\":\"made up\"},\
             {\"kind\":\"move\",\"folder\":\"ideas/\",\"title\":\"Bank card\",\"why\":\"new topic\"}]",
            &c,
        );
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].title, "Tern release");
        assert_eq!((got[1].folder.as_str(), got[1].title.as_str()), ("ideas", "Bank card"));
        assert!(parse_suggestions("no json", &c).is_empty());
    }
}
