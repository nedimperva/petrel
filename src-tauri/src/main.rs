#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod cli_host;
mod commands;
mod desktop;
mod host;
mod notes;
mod tray;
mod uri;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use petrel_core::host::{system, CancelToken};
use petrel_core::Store;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub struct AppState {
    /// Launched as `petrel --capture`, or `--hidden` at login: the main window stays hidden until something asks
    /// for it.
    pub stay_hidden: AtomicBool,
    pub store: Mutex<Store>,
    pub db_path: PathBuf,
    /// Dialogs an action is waiting on.
    pub broker: host::Broker,
    pub clipboard: Mutex<Option<arboard::Clipboard>>,
    /// The running action's token, for `Esc`.
    pub running: Mutex<Option<CancelToken>>,
    /// The tray icon is up, so closing the last window keeps Petrel running (package 07).
    pub tray: AtomicBool,
    /// Quit was chosen: windows are saving and closing, and the last one to go ends the process.
    pub quitting: AtomicBool,
    /// The global capture hotkey (package 07).
    pub hotkey: Mutex<desktop::Hotkey>,
    /// `petrel://` links waiting for the main window to take them.
    pub links: Mutex<Vec<uri::Link>>,
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
    let path = if cfg!(debug_assertions) { dir.join("dev").join("petrel.db") } else { dir.join("petrel.db") };
    // `petrel --stdin` finds the database without starting Tauri; the two must never disagree.
    match cli::db_path() {
        Ok(p) if p == path => {}
        other => log::warn!("the command line would use {other:?}, the app uses {}", path.display()),
    }
    Ok(path)
}

fn wants_capture(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == "--capture")
}

fn wants_new(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == "--new" || a == "-n")
}

/// Shows the main window and brings it to the front.
pub fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Shows the main window on a new draft: the UI saves the open one first.
pub fn show_new_draft(app: &tauri::AppHandle) {
    show_main(app);
    let _ = app.emit_to("main", "petrel-new", ());
}

/// Handles `--new TEXT`, `--stdin` and `--help` without a window. `None` means start the app.
fn run_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let command = match cli::parse(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("petrel: {e:#}\n\n{}", cli::HELP);
            return Some(2);
        }
    };
    let (text, tags) = match command {
        cli::Command::App => return None,
        cli::Command::Help => {
            println!("{}", cli::HELP);
            return Some(0);
        }
        cli::Command::Write { text, tags } => (text, tags),
        cli::Command::Run { action, draft, tags } => {
            return Some(run_from_cli(&action, draft.as_deref(), &tags))
        }
    };
    let saved = (|| {
        let text = match text {
            Some(t) => t,
            None => cli::read_stdin()?,
        };
        cli::write_draft(&cli::db_path()?, &text, &tags)
    })();
    match saved {
        Ok(uuid) => {
            println!("{uuid}");
            Some(0)
        }
        Err(e) => {
            eprintln!("petrel: {e:#}");
            Some(1)
        }
    }
}

/// `petrel run`: the draft's uuid on stdout when it worked, the reason on stderr when it did not. Commands get
/// the terminal's own `PATH`, not the login shell's that the app caches.
fn run_from_cli(action: &str, draft: Option<&str>, tags: &[String]) -> i32 {
    let ran = (|| {
        let text = if draft.is_none() { Some(cli::read_stdin()?) } else { None };
        let mut host = cli_host::CliHost::new();
        cli::run_action(&cli::db_path()?, action, draft, text.as_deref(), tags, &mut host)
    })();
    match ran {
        Ok((cli::RunEnd::Ok, uuid)) => {
            println!("{uuid}");
            0
        }
        Ok((end, message)) => {
            eprintln!("petrel: {message}");
            if end == cli::RunEnd::Stopped {
                cli::RUN_STOPPED
            } else {
                cli::RUN_FAILED
            }
        }
        Err(e) => {
            eprintln!("petrel: {e:#}");
            cli::RUN_FAILED
        }
    }
}

/// Opens the capture window, or focuses it if it is open (ui.md §3). It starts hidden and shows itself once the
/// editor has rendered, like the main window. The title is what a Hyprland float rule matches on: on Wayland
/// every Petrel window shares the app id.
pub fn open_capture(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "capture", WebviewUrl::App("index.html".into()))
        .title("Petrel capture")
        .inner_size(560.0, 320.0)
        .min_inner_size(360.0, 160.0)
        // A quick note over whatever you were doing; it closes itself when you're done.
        .always_on_top(true)
        .visible(false)
        .initialization_script("window.__PETREL_CAPTURE__ = true;")
        .build();
    if let Err(e) = built {
        log::error!("cannot open the capture window: {e}");
    }
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
    if let Some(code) = run_cli() {
        std::process::exit(code);
    }

    // WebKitGTK's DMA-BUF renderer leaves the window blank or crashes on some Wayland setups (NVIDIA among
    // them). Off unless the user says otherwise. Same as Tern.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch focuses the running one, opens capture, or starts a new draft. `--new TEXT` and
            // `--stdin` never get here: they write the draft and exit before Tauri starts.
            let links = uri::from_args(&args);
            if !links.is_empty() {
                if let Some(state) = app.try_state::<AppState>() {
                    state.links.lock().map(|mut q| q.extend(links)).ok();
                }
                show_main(app);
                let _ = app.emit_to("main", "petrel-links", ());
                return;
            }
            if wants_capture(&args) {
                return open_capture(app);
            }
            // Start at login while Petrel already runs: it is already where it should be.
            if desktop::wants_hidden(&args) {
                return;
            }
            if wants_new(&args) {
                return show_new_draft(app);
            }
            show_main(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| desktop::on_shortcut(app, shortcut, event.state))
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().arg(desktop::HIDDEN_ARG).build())
        // Registers `petrel://` with the OS (the bundles declare it too); links arrive as arguments.
        .plugin(tauri_plugin_deep_link::init())
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
            let args: Vec<String> = std::env::args().collect();
            let capture = wants_capture(&args);
            app.manage(AppState {
                stay_hidden: AtomicBool::new(capture),
                store: Mutex::new(store),
                db_path: path,
                broker: host::Broker::default(),
                clipboard: Mutex::new(None),
                running: Mutex::new(None),
                tray: AtomicBool::new(false),
                quitting: AtomicBool::new(false),
                hotkey: Mutex::new(desktop::Hotkey::default()),
                links: Mutex::new(uri::from_args(&args)),
            });
            // A debug build registers itself so links can be tried from `tauri dev`; installers register a release.
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    log::warn!("registering petrel:// links: {e}");
                }
            }
            // Without a tray (no StatusNotifier host on Linux, say), closing the window quits, as before.
            // The Linux tray loads libayatana-appindicator at run time and panics if it is missing.
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tray::build(app))) {
                Ok(Ok(())) => app.state::<AppState>().tray.store(true, Ordering::SeqCst),
                Ok(Err(e)) => log::warn!("no tray icon, closing the window will quit: {e:#}"),
                Err(_) => log::warn!(
                    "no tray icon (is libayatana-appindicator installed?); closing the window will quit"
                ),
            }
            if desktop::start_hidden(app.handle(), &args) && uri::from_args(&args).is_empty() {
                app.state::<AppState>().stay_hidden.store(true, Ordering::SeqCst);
                log::info!("started hidden in the tray");
            }
            desktop::init(app.handle());
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
            if capture {
                open_capture(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::new_draft,
            commands::open_draft,
            commands::peek_draft,
            commands::save_draft,
            commands::save_cursor,
            commands::rescue_text,
            commands::close_window,
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
            commands::close_capture,
            commands::open_capture_window,
            commands::desktop_settings,
            commands::ui_settings,
            commands::list_versions,
            commands::take_links,
            commands::find_draft,
            commands::version_text,
            commands::restore_version,
            commands::set_ui_setting,
            commands::set_hotkey,
            commands::set_autostart,
            commands::list_actions,
            commands::save_action,
            commands::delete_action,
            commands::action_log,
            commands::run_action,
            commands::cancel_run,
            commands::host_reply,
            notes::notes_info,
            notes::set_notes_root,
            notes::scan_notes,
            notes::list_notes,
            notes::find_notes,
            notes::search_notes,
            notes::note_folders,
            notes::open_note,
            notes::peek_note,
            notes::create_note,
            notes::save_note,
            notes::rename_note,
            notes::pin_note,
            notes::set_note_tags,
            notes::trash_note,
            notes::promote_draft,
            notes::append_to_note,
            notes::link_targets,
            notes::resolve_link,
            notes::backlinks,
            notes::link_mention,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Petrel")
        .run(|app, event| {
            // The last window closed: keep running in the tray unless Quit was chosen. `app.exit` (a code) passes.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                let Some(state) = app.try_state::<AppState>() else { return };
                if state.tray.load(Ordering::SeqCst) && !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}
