#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod host;

use std::path::PathBuf;
use std::sync::Mutex;

use petrel_core::host::{system, CancelToken};
use petrel_core::Store;
use tauri::Manager;

pub struct AppState {
    pub store: Mutex<Store>,
    pub db_path: PathBuf,
    /// Dialogs an action is waiting on.
    pub broker: host::Broker,
    pub clipboard: Mutex<Option<arboard::Clipboard>>,
    /// The running action's token, for `Esc`.
    pub running: Mutex<Option<CancelToken>>,
}

/// The login shell's `PATH` is cached here and refreshed off the start path (actions.md "Shell").
const PATH_SETTING: &str = "actions.command_path";

fn refresh_command_path(app: &tauri::AppHandle) {
    let Some(path) = system::login_path() else { return };
    if system::command_path().as_deref() == Some(path.as_str()) {
        return;
    }
    system::use_path(Some(path.clone()));
    let state = app.state::<AppState>();
    if let Ok(store) = state.store.lock() {
        if let Err(e) = store.set_setting(PATH_SETTING, &path) {
            log::warn!("caching the login PATH: {e:#}");
        }
    };
}

/// Where the database lives: `PETREL_DB` if set; otherwise `<app data>/petrel.db`, or `<app data>/dev/petrel.db`
/// for a debug build so a development schema can never touch the installed Petrel's text (migrations only go
/// forward).
fn db_path(app: &tauri::App) -> anyhow::Result<PathBuf> {
    if let Some(p) = std::env::var_os("PETREL_DB") {
        return Ok(PathBuf::from(p));
    }
    let dir = app.path().app_data_dir()?;
    Ok(if cfg!(debug_assertions) { dir.join("dev").join("petrel.db") } else { dir.join("petrel.db") })
}

const SWEEP_EVERY: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

fn sweep(store: &mut Store) {
    match store.sweep() {
        Ok(r) if r.tombstoned + r.purged + r.tags_removed + r.versions_thinned > 0 => {
            log::info!("sweep: {r:?}")
        }
        Ok(_) => {}
        Err(e) => log::warn!("sweep failed: {e:#}"),
    }
}

/// Log to stderr and to `<app data>/petrel.log` (truncated when it passes 5 MB; rotation comes later).
fn init_logging(app: &tauri::App) {
    let mut builder = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("petrel.log");
        let too_big = std::fs::metadata(&path).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(!too_big)
            .write(true)
            .truncate(too_big)
            .open(&path);
        if let Ok(file) = file {
            builder.target(env_logger::Target::Pipe(Box::new(Tee(file))));
        }
    }
    let _ = builder.try_init();
}

/// Writes to a file and to stderr.
struct Tee(std::fs::File);

impl std::io::Write for Tee {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write_all(buf);
        self.0.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

fn main() {
    // WebKitGTK's DMA-BUF renderer leaves the window blank or crashes on some Wayland setups (NVIDIA among
    // them). Off unless the user says otherwise. Same as Tern.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch focuses the running one. Arguments (`--new`, `--capture`) arrive with package 07.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // The folder picker in the action editor.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            init_logging(app);
            let path = db_path(app)?;
            let mut store = Store::open(&path).map_err(|e| {
                log::error!("cannot open {}: {e:#}", path.display());
                e
            })?;
            sweep(&mut store);
            match store.seed_default_actions() {
                Ok(0) => {}
                Ok(n) => log::info!("added {n} default actions"),
                Err(e) => log::warn!("default actions: {e:#}"),
            }
            system::use_path(store.setting(PATH_SETTING).ok().flatten());
            log::info!("Petrel {} · {}", env!("CARGO_PKG_VERSION"), path.display());
            app.manage(AppState {
                store: Mutex::new(store),
                db_path: path,
                broker: host::Broker::default(),
                clipboard: Mutex::new(None),
                running: Mutex::new(None),
            });
            // Petrel can stay open for weeks; the Trash and version policies still apply, and the login PATH
            // may change.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                refresh_command_path(&handle);
                std::thread::sleep(SWEEP_EVERY);
                let state = handle.state::<AppState>();
                let Ok(mut store) = state.store.lock() else { return };
                sweep(&mut store);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::new_draft,
            commands::open_draft,
            commands::save_draft,
            commands::list_drafts,
            commands::search_drafts,
            commands::set_tags,
            commands::tag_counts,
            commands::rename_tag,
            commands::merge_tags,
            commands::move_drafts,
            commands::flag_drafts,
            commands::add_tags,
            commands::undo,
            commands::empty_trash,
            commands::sweep,
            commands::show_window,
            commands::list_actions,
            commands::save_action,
            commands::delete_action,
            commands::action_log,
            commands::run_action,
            commands::cancel_run,
            commands::host_reply,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Petrel");
}
