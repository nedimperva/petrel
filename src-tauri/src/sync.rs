//! Sync with Google Drive, in the background, only once it is set up in Settings › Sync. One thread runs the
//! engine (`petrel_core::sync`) against Drive (`drive.rs`): a couple of seconds after a save, when the window
//! comes to the front, every 30 seconds while the window is open and every 5 minutes from the tray. Files it
//! writes are read into the index at once and the window is told, as for any change in the folder. What happened
//! is sent to the UI as `petrel-sync` and shown at the foot of the sidebar.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Context, Result};
use petrel_core::sync::{self as engine, State as SyncState};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::drive::{Drive, Offline};
use crate::google::{self, SignInAgain};
use crate::AppState;

pub(crate) const CLIENT_ID: &str = "sync.client_id";
const FOLDER_ID: &str = "sync.folder_id";
const ACCOUNT: &str = "sync.account";
const ON: &str = "sync.on";
/// Typing settles before a save is sent.
const AFTER_SAVE: Duration = Duration::from_secs(2);
const OPEN_EVERY: Duration = Duration::from_secs(30);
const TRAY_EVERY: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// A client id and secret are saved.
    pub configured: bool,
    pub client_id: String,
    pub signed_in: bool,
    pub account: String,
    pub on: bool,
    /// `off`, `idle`, `syncing`, `offline`, `signin` (sign in again), `error`, `blocked`.
    pub state: String,
    pub message: Option<String>,
    /// When the last sync finished well, ms.
    pub last_at: Option<i64>,
    /// What the last sync that did something did, in words.
    pub last: Option<String>,
}

pub struct Sync {
    nudge: Mutex<Option<Sender<Nudge>>>,
    status: Mutex<Status>,
}

enum Nudge {
    /// These files or folders changed here (absolute paths, from the watcher).
    Soon(Vec<PathBuf>),
    /// The person asked, or the window came back: look at everything.
    Now,
    /// Quit: look at everything once more, and say when it is done.
    Last(Sender<()>),
}

/// What the next sync must look at here: only the paths the watcher named, or the whole folder.
#[derive(Default)]
struct Pending {
    full: bool,
    paths: std::collections::BTreeSet<PathBuf>,
    /// Told when this sync is over (Quit waits on it).
    done: Vec<Sender<()>>,
}

impl Pending {
    fn take(&mut self, n: Nudge) {
        match n {
            Nudge::Soon(p) => self.paths.extend(p),
            Nudge::Now => self.full = true,
            Nudge::Last(tx) => {
                self.full = true;
                self.done.push(tx);
            }
        }
    }
}

pub fn state() -> Sync {
    Sync { nudge: Mutex::new(None), status: Mutex::new(Status::default()) }
}

pub(crate) fn setting(app: &tauri::AppHandle, key: &str) -> Option<String> {
    let st = app.state::<AppState>();
    let s = st.store.lock().ok()?;
    s.setting(key).ok().flatten().filter(|v| !v.is_empty())
}

pub(crate) fn set_setting(app: &tauri::AppHandle, key: &str, value: &str) -> Result<()> {
    let st = app.state::<AppState>();
    let s = st.store.lock().map_err(|_| anyhow::anyhow!("store lock poisoned"))?;
    s.set_setting(key, value)
}

fn root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let st = app.state::<AppState>();
    let default = crate::notes::default_root(&st.db_path);
    let mut s = st.store.lock().ok()?;
    s.notes_root_or(&default).ok()
}

/// A folder that Google Drive for desktop already syncs: two sync tools on one folder fight over every file.
pub fn under_drive_for_desktop(root: &Path) -> bool {
    let p = root.to_string_lossy().to_lowercase().replace('\\', "/");
    p.contains("/google drive/")
        || p.contains("/my drive/")
        || p.contains("/googledrive/")
        || p.ends_with("/my drive")
}

/// The sync state's file: one per notes folder, next to the index.
fn state_file(app: &tauri::AppHandle, root: &Path) -> PathBuf {
    let st = app.state::<AppState>();
    let dir = st.db_path.parent().map(Path::to_path_buf).unwrap_or_default();
    let tag = &engine::md5_hex(root.to_string_lossy().as_bytes())[..12];
    dir.join(format!("sync-{tag}.json"))
}

/// One line of the sync log: when, what was done, and to which file.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub at: i64,
    pub what: String,
    pub path: String,
}

/// Lines the log keeps, newest last.
const LOG_LINES: usize = 50;

fn log_file(app: &tauri::AppHandle, root: &Path) -> PathBuf {
    state_file(app, root).with_extension("log.json")
}

fn read_log(path: &Path) -> Vec<LogLine> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Adds what a sync did to the log, keeping the last fifty lines.
fn write_log(app: &tauri::AppHandle, root: &Path, done: &[(String, String)]) {
    if done.is_empty() {
        return;
    }
    let path = log_file(app, root);
    let mut lines = read_log(&path);
    let at = now_ms();
    lines.extend(done.iter().map(|(what, p)| LogLine { at, what: what.clone(), path: p.clone() }));
    let skip = lines.len().saturating_sub(LOG_LINES);
    let lines = &lines[skip..];
    if let Err(e) =
        serde_json::to_vec(lines).map_err(anyhow::Error::from).and_then(|b| Ok(std::fs::write(&path, b)?))
    {
        log::warn!("writing the sync log: {e:#}");
    }
}

pub fn status(app: &tauri::AppHandle) -> Status {
    let client_id = setting(app, CLIENT_ID).unwrap_or_default();
    let configured = !client_id.is_empty() && google::client_secret().ok().flatten().is_some();
    let signed_in = configured && google::signed_in();
    let on = signed_in && setting(app, ON).as_deref() == Some("1");
    let sync = app.state::<Sync>();
    let mut st = sync.status.lock().map(|s| s.clone()).unwrap_or_default();
    st.configured = configured;
    st.client_id = client_id;
    st.signed_in = signed_in;
    st.account = setting(app, ACCOUNT).unwrap_or_default();
    st.on = on;
    if on && st.message.is_none() && unfinished(app) {
        st.message = Some("The last sync before Quit did not finish. It continues now.".into());
    }
    if !on && st.state != "signin" {
        st.state = "off".into();
    }
    if let Some(r) = root(app) {
        if on && under_drive_for_desktop(&r) {
            st.state = "blocked".into();
            st.message = Some(
                "This folder is inside Google Drive for desktop, which already syncs it. Move the folder out of it \
                 (Settings › General) before Petrel syncs it, or the two will fight over every file."
                    .into(),
            );
        }
    }
    st
}

fn tell(app: &tauri::AppHandle, f: impl FnOnce(&mut Status)) {
    let sync = app.state::<Sync>();
    if let Ok(mut s) = sync.status.lock() {
        f(&mut s);
    }
    let st = status(app);
    let settle = {
        let s = app.state::<AppState>();
        let store = s.store.lock();
        store.ok().and_then(|st| st.conflicts().ok()).is_some_and(|c| !c.is_empty())
    };
    let mark = match st.state.as_str() {
        "signin" | "error" | "blocked" => crate::tray::Mark::Needs,
        "offline" => crate::tray::Mark::Waiting,
        _ if settle => crate::tray::Mark::Waiting,
        _ => crate::tray::Mark::None,
    };
    crate::tray::mark_sync(app, mark);
    let _ = app.emit("petrel-sync", st);
}

/// Asks for a sync now, looking at the whole folder.
pub fn nudge(app: &tauri::AppHandle, now: bool) {
    send(app, if now { Nudge::Now } else { Nudge::Soon(Vec::new()) });
}

/// Asks for a sync soon, of these changed paths.
pub fn nudge_paths(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
    send(app, Nudge::Soon(paths));
}

/// Whether sync is on, so Quit gives it a last run.
pub fn is_on(app: &tauri::AppHandle) -> bool {
    status(app).on
}

/// Set when Quit could not wait for the last sync; cleared by the next sync that finishes.
const UNFINISHED: &str = "sync.unfinished";

/// Quit closed Petrel before the last sync was done: a line in the sync log, so a half sync never looks like a
/// whole one, and the next start says so until a sync finishes.
pub fn note_unfinished(app: &tauri::AppHandle) {
    let _ = set_setting(app, UNFINISHED, "1");
    if let Some(root) = root(app) {
        write_log(app, &root, &[("not finished before Quit; continues at the next start".into(), String::new())]);
    }
}

/// Whether the last Quit left a sync unfinished that no sync has finished since.
pub fn unfinished(app: &tauri::AppHandle) -> bool {
    setting(app, UNFINISHED).is_some_and(|v| v == "1")
}

/// One last sync before Quit: waits for it at most `limit`, so a slow network never holds Petrel open.
/// Returns whether it finished in time.
pub fn last(app: &tauri::AppHandle, limit: Duration) -> bool {
    let (tx, rx) = channel();
    send(app, Nudge::Last(tx));
    rx.recv_timeout(limit).is_ok()
}

fn send(app: &tauri::AppHandle, n: Nudge) {
    let sync = app.state::<Sync>();
    let tx = sync.nudge.lock().ok().and_then(|n| n.clone());
    if let Some(tx) = tx {
        let _ = tx.send(n);
    }
}

/// Starts the sync thread. It sleeps until there is something to do and sync is on.
pub fn start(app: &tauri::AppHandle) {
    let (tx, rx) = channel::<Nudge>();
    if let Ok(mut n) = app.state::<Sync>().nudge.lock() {
        *n = Some(tx);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // A first sync shortly after start, of the whole folder.
        let mut wait = Duration::from_secs(5);
        let mut pending = Pending { full: true, ..Pending::default() };
        loop {
            match rx.recv_timeout(wait) {
                Ok(n) => {
                    if matches!(n, Nudge::Soon(_)) {
                        // Let the typing settle.
                        std::thread::sleep(AFTER_SAVE);
                    }
                    pending.take(n);
                    // The nudges that came meanwhile go with this one.
                    while let Ok(n) = rx.try_recv() {
                        pending.take(n);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            let shown = app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false);
            wait = if shown { OPEN_EVERY } else { TRAY_EVERY };
            let mut todo = std::mem::take(&mut pending);
            let done = std::mem::take(&mut todo.done);
            if let Err(e) = run_once(&app, todo) {
                log::warn!("sync: {e:#}");
            }
            for tx in done {
                let _ = tx.send(());
            }
        }
    });
}

fn run_once(app: &tauri::AppHandle, todo: Pending) -> Result<()> {
    let st = status(app);
    if !st.on || st.state == "blocked" {
        return Ok(());
    }
    let root = root(app).context("no notes folder")?;
    let client_id = st.client_id.clone();
    let folder = match setting(app, FOLDER_ID) {
        Some(f) => f,
        None => {
            let id = client_id.clone();
            let f = Drive::find_or_make_root(move || google::access_token(&id))?;
            set_setting(app, FOLDER_ID, &f)?;
            f
        }
    };
    tell(app, |s| {
        s.state = "syncing".into();
        s.message = None;
    });
    let file = state_file(app, &root);
    let mut state = SyncState::load(&file);
    let id = client_id.clone();
    let mut drive = Drive::new(move || google::access_token(&id), folder, state.cursor.clone());
    let stamp = chrono_stamp();
    // Between full looks (hourly, at start, when asked) only what the watcher named is read again; a quiet
    // folder costs no walk at all, just the one question to Drive.
    let full = todo.full || now_ms() - state.full_at > engine::FULL_SCAN_MS;
    let hint: Vec<String> = todo
        .paths
        .iter()
        .filter_map(|p| p.strip_prefix(&root).ok())
        .filter_map(|p| p.components().map(|c| c.as_os_str().to_str()).collect::<Option<Vec<_>>>())
        .map(|parts| parts.join("/"))
        .collect();
    let hint = (!full).then_some(&hint[..]);
    let result = engine::sync_hinted(&root, &mut drive, &mut state, &stamp, hint);
    state.cursor = drive.cursor.clone();
    // Saved even after a failure: what was done is remembered, so it is not done twice.
    if let Err(e) = state.save(&file) {
        log::warn!("saving the sync state: {e:#}");
    }
    match result {
        Ok(report) => {
            if !report.changed.is_empty() {
                let paths: Vec<PathBuf> = report.changed.iter().map(|r| root.join(r)).collect();
                let scanned = {
                    let s = app.state::<AppState>();
                    let mut store = s.store.lock().map_err(|_| anyhow::anyhow!("store lock poisoned"))?;
                    store.scan_paths(&paths)
                };
                if let Ok(r) = scanned {
                    let _ = app.emit_to("main", "petrel-folder", r);
                }
            }
            write_log(app, &root, &report.log);
            // The sync Quit could not finish is done now: say so once, in the log.
            if report.failed.is_empty() && setting(app, UNFINISHED).is_some() {
                let _ = set_setting(app, UNFINISHED, "");
                write_log(app, &root, &[("finished what was left at Quit".into(), String::new())]);
            }
            let words = describe(&report);
            let failed = report.failed.first().map(|(p, e)| format!("{p}: {e}"));
            if !report.failed.is_empty() {
                log::warn!("sync: {} files failed, first {failed:?}", report.failed.len());
            }
            tell(app, |s| {
                s.state = if failed.is_some() { "error".into() } else { "idle".into() };
                s.message = failed.map(|f| format!("Some files did not sync and will be tried again. {f}"));
                s.last_at = Some(now_ms());
                if let Some(w) = words {
                    s.last = Some(w);
                }
            });
            Ok(())
        }
        Err(e) => {
            let signin = e.chain().any(|c| c.is::<SignInAgain>());
            let offline = e.chain().any(|c| c.is::<Offline>());
            tell(app, |s| {
                s.state = if signin {
                    "signin"
                } else if offline {
                    "offline"
                } else {
                    "error"
                }
                .into();
                s.message = Some(if signin {
                    "Google asks you to sign in again.".into()
                } else if offline {
                    "Offline. Changes wait here and go when you are back.".into()
                } else {
                    format!("{e:#}")
                });
            });
            Err(e)
        }
    }
}

fn describe(r: &engine::Report) -> Option<String> {
    let mut parts = Vec::new();
    let n = |k: usize, one: &str, many: &str| format!("{k} {}", if k == 1 { one } else { many });
    if r.uploaded > 0 {
        parts.push(format!("{} sent", n(r.uploaded, "file", "files")));
    }
    if r.downloaded > 0 {
        parts.push(format!("{} received", n(r.downloaded, "file", "files")));
    }
    if r.trashed_here + r.trashed_there > 0 {
        parts.push(format!("{} to the trash", n(r.trashed_here + r.trashed_there, "file", "files")));
    }
    if r.moved > 0 {
        parts.push(format!("{} moved", n(r.moved, "file", "files")));
    }
    if r.merged > 0 {
        parts.push(format!("{} merged", n(r.merged, "note", "notes")));
    }
    if r.conflicts > 0 {
        parts.push(format!("{} kept both ways", n(r.conflicts, "note", "notes")));
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// `2026-11-14 1830`, as Petrel's own conflict copies are named.
fn chrono_stamp() -> String {
    petrel_core::sync::stamp_now()
}

// ---- commands ----------------------------------------------------------------------------------------------

type R<T> = std::result::Result<T, String>;

/// What sync did lately, newest first: the panel behind the sidebar's sync line.
#[tauri::command]
pub fn sync_log(app: tauri::AppHandle) -> Vec<LogLine> {
    let Some(root) = root(&app) else { return Vec::new() };
    let mut lines = read_log(&log_file(&app, &root));
    lines.reverse();
    lines
}

#[tauri::command]
pub fn sync_status(app: tauri::AppHandle) -> Status {
    status(&app)
}

/// Saves the Google Cloud client (Settings › Sync). The secret goes to the keyring.
#[tauri::command]
pub fn sync_setup(app: tauri::AppHandle, client_id: String, client_secret: String) -> R<Status> {
    let id = client_id.trim();
    let secret = client_secret.trim();
    if !id.ends_with(".apps.googleusercontent.com") {
        return Err(
            "that does not look like a Google client ID (it ends with .apps.googleusercontent.com)".into()
        );
    }
    if secret.is_empty() {
        return Err("the client secret is missing".into());
    }
    set_setting(&app, CLIENT_ID, id).map_err(|e| format!("{e:#}"))?;
    google::set_client_secret(Some(secret)).map_err(|e| format!("{e:#}"))?;
    Ok(status(&app))
}

/// Opens Google's sign-in in the browser and waits for it. On success sync is turned on.
#[tauri::command]
pub async fn sync_sign_in(app: tauri::AppHandle) -> R<Status> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let id = setting(&a, CLIENT_ID).context("add the client ID first")?;
        let opener = a.clone();
        let calendar = setting(&a, crate::calendar::ON).is_some_and(|v| v == "1");
        google::sign_in(&id, calendar, move |url| {
            use tauri_plugin_opener::OpenerExt;
            opener
                .opener()
                .open_url(url, None::<&str>)
                .map_err(|e| anyhow::anyhow!("opening the browser: {e}"))
        })?;
        let id2 = id.clone();
        let mut d = Drive::new(move || google::access_token(&id2), String::new(), None);
        if let Ok(account) = d.account() {
            set_setting(&a, ACCOUNT, &account)?;
        }
        set_setting(&a, ON, "1")?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))?;
    tell(&app, |s| {
        s.state = "idle".into();
        s.message = None;
    });
    nudge(&app, true);
    Ok(status(&app))
}

#[tauri::command]
pub fn sync_sign_out(app: tauri::AppHandle) -> R<Status> {
    google::sign_out().map_err(|e| format!("{e:#}"))?;
    let _ = set_setting(&app, ON, "0");
    let _ = set_setting(&app, ACCOUNT, "");
    tell(&app, |s| {
        s.state = "off".into();
        s.message = None;
    });
    Ok(status(&app))
}

/// Pauses or resumes sync without signing out.
#[tauri::command]
pub fn sync_set_on(app: tauri::AppHandle, on: bool) -> R<Status> {
    set_setting(&app, ON, if on { "1" } else { "0" }).map_err(|e| format!("{e:#}"))?;
    if on {
        nudge(&app, true);
    }
    Ok(status(&app))
}

#[tauri::command]
pub fn sync_now(app: tauri::AppHandle) {
    nudge(&app, true);
}
