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
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::drive::{Drive, Offline};
use crate::google::{self, SignInAgain};
use crate::AppState;

const CLIENT_ID: &str = "sync.client_id";
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
    /// Something changed here, or the person asked.
    Soon,
    Now,
}

pub fn state() -> Sync {
    Sync { nudge: Mutex::new(None), status: Mutex::new(Status::default()) }
}

fn setting(app: &tauri::AppHandle, key: &str) -> Option<String> {
    let st = app.state::<AppState>();
    let s = st.store.lock().ok()?;
    s.setting(key).ok().flatten().filter(|v| !v.is_empty())
}

fn set_setting(app: &tauri::AppHandle, key: &str, value: &str) -> Result<()> {
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
    let _ = app.emit("petrel-sync", status(app));
}

/// Asks for a sync soon (after a save) or now.
pub fn nudge(app: &tauri::AppHandle, now: bool) {
    let sync = app.state::<Sync>();
    let tx = sync.nudge.lock().ok().and_then(|n| n.clone());
    if let Some(tx) = tx {
        let _ = tx.send(if now { Nudge::Now } else { Nudge::Soon });
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
        // A first sync shortly after start.
        let mut wait = Duration::from_secs(5);
        loop {
            match rx.recv_timeout(wait) {
                Ok(Nudge::Soon) => {
                    // Let the typing settle, and take the nudges that came meanwhile with this one.
                    std::thread::sleep(AFTER_SAVE);
                    while rx.try_recv().is_ok() {}
                }
                Ok(Nudge::Now) => while rx.try_recv().is_ok() {},
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            let shown = app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false);
            wait = if shown { OPEN_EVERY } else { TRAY_EVERY };
            if let Err(e) = run_once(&app) {
                log::warn!("sync: {e:#}");
            }
        }
    });
}

fn run_once(app: &tauri::AppHandle) -> Result<()> {
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
    let result = engine::sync(&root, &mut drive, &mut state, &stamp);
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
        google::sign_in(&id, move |url| {
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
