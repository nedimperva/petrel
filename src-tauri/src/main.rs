#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod cli;
mod commands;
mod context;
mod desktop;
mod notes;
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use petrel_core::Store;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub struct AppState {
    /// Launched as `petrel --capture`, or `--hidden` at login: the main window stays hidden until something asks
    /// for it.
    pub stay_hidden: AtomicBool,
    pub store: Mutex<Store>,
    pub db_path: PathBuf,
    pub clipboard: Mutex<Option<arboard::Clipboard>>,
    /// The tray icon is up, so closing the last window keeps Petrel running (package 07).
    pub tray: AtomicBool,
    /// Quit was chosen: windows are saving and closing, and the last one to go ends the process.
    pub quitting: AtomicBool,
    /// The global capture hotkey.
    pub hotkey: Mutex<desktop::Hotkey>,
    /// The quick picker's hotkey.
    pub picker_hotkey: Mutex<desktop::Hotkey>,
    /// What was selected when the capture key was pressed, on its way to the capture window.
    pub capture_context: Mutex<Option<context::Pending>>,
    /// The Linux primary selection the last capture saw, so an old selection is not brought in twice.
    pub last_primary: Mutex<Option<String>>,
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

fn wants_picker(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == "--picker")
}

/// Shows the main window and brings it to the front.
pub fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
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
    };
    let saved = (|| {
        let text = match text {
            Some(t) => t,
            None => cli::read_stdin()?,
        };
        cli::write_capture(&cli::db_path()?, &text, &tags)
    })();
    match saved {
        Ok(path) => {
            println!("{path}");
            Some(0)
        }
        Err(e) => {
            eprintln!("petrel: {e:#}");
            Some(1)
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
    remember_context(app);
    let built = WebviewWindowBuilder::new(app, "capture", WebviewUrl::App("index.html".into()))
        .title("Petrel capture")
        .inner_size(640.0, 260.0)
        .min_inner_size(360.0, 160.0)
        // No frame: the text on a panel, dragged by its empty space (data-tauri-drag-region in the UI).
        .decorations(false)
        .center()
        // A quick note over whatever you were doing; it closes itself when you're done.
        .always_on_top(true)
        .visible(false)
        .initialization_script("window.__PETREL_CAPTURE__ = true;")
        .build();
    if let Err(e) = built {
        log::error!("cannot open the capture window: {e}");
    }
}

/// Starts reading what was selected in the window in front, unless Settings turned it off. It must run before the
/// capture window is made: once that window has the focus the other app's selection is out of reach.
fn remember_context(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let on = state
        .store
        .lock()
        .ok()
        .and_then(|s| s.setting("ui.capture_selection").ok().flatten())
        .is_none_or(|v| v != "0");
    let rx = if on {
        let last = state.last_primary.lock().ok().and_then(|l| l.clone());
        Some(context::start(last))
    } else {
        None
    };
    if let Ok(mut slot) = state.capture_context.lock() {
        *slot = rx;
    };
}

/// Opens the quick picker, or focuses it: a small search over the collections that copies and closes.
pub fn open_picker(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("picker") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "picker", WebviewUrl::App("index.html".into()))
        .title("Petrel picker")
        .inner_size(620.0, 440.0)
        .min_inner_size(420.0, 240.0)
        .always_on_top(true)
        .decorations(false)
        .center()
        .visible(false)
        .initialization_script("window.__PETREL_PICKER__ = true;")
        .build();
    if let Err(e) = built {
        log::error!("cannot open the picker: {e}");
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

/// Drafts were the old capture store. Their text is written out as files once (Inbox drafts to `inbox/`, the
/// rest to `drafts/`), and the drafts table is left as it was, so nothing is lost if the export is wrong.
fn export_drafts(store: &mut Store, db: &std::path::Path) {
    let default = notes::default_root(db);
    let exported = store.notes_root_or(&default).and_then(|root| {
        std::fs::create_dir_all(&root)?;
        store.export_drafts_once()
    });
    match exported {
        Ok(0) => {}
        Ok(n) => log::info!("exported {n} drafts to the notes folder"),
        Err(e) => log::warn!("exporting drafts: {e:#}"),
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
            // A second launch focuses the running one or opens capture or the picker. `--new TEXT` and `--stdin`
            // never get here: they write the capture and exit before Tauri starts.
            if wants_picker(&args) {
                return open_picker(app);
            }
            if wants_capture(&args) {
                return open_capture(app);
            }
            // Start at login while Petrel already runs: it is already where it should be.
            if desktop::wants_hidden(&args) {
                return;
            }
            show_main(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| desktop::on_shortcut(app, shortcut, event.state))
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().arg(desktop::HIDDEN_ARG).build())
        .plugin(tauri_plugin_opener::init())
        // The notes folder picker in Settings.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            init_logging(app);
            let path = db_path(app)?;
            let mut store = Store::open(&path).map_err(|e| {
                log::error!("cannot open {}: {e:#}", path.display());
                e
            })?;
            sweep(&mut store);
            export_drafts(&mut store, &path);
            log::info!("Petrel {} · {}", env!("CARGO_PKG_VERSION"), path.display());
            let args: Vec<String> = std::env::args().collect();
            let capture = wants_capture(&args);
            let picker = wants_picker(&args);
            app.manage(AppState {
                stay_hidden: AtomicBool::new(capture || picker),
                store: Mutex::new(store),
                db_path: path,
                clipboard: Mutex::new(None),
                tray: AtomicBool::new(false),
                quitting: AtomicBool::new(false),
                hotkey: Mutex::new(desktop::Hotkey::default()),
                picker_hotkey: Mutex::new(desktop::Hotkey::default()),
                capture_context: Mutex::new(None),
                last_primary: Mutex::new(None),
            });
            // Without a tray (no StatusNotifier host on Linux, say), closing the window quits, as before.
            // The Linux tray loads libayatana-appindicator at run time and panics if it is missing.
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tray::build(app))) {
                Ok(Ok(())) => app.state::<AppState>().tray.store(true, Ordering::SeqCst),
                Ok(Err(e)) => log::warn!("no tray icon, closing the window will quit: {e:#}"),
                Err(_) => log::warn!(
                    "no tray icon (is libayatana-appindicator installed?); closing the window will quit"
                ),
            }
            if desktop::start_hidden(app.handle(), &args) {
                app.state::<AppState>().stay_hidden.store(true, Ordering::SeqCst);
                log::info!("started hidden in the tray");
            }
            desktop::init(app.handle());
            // Petrel's own title bar is for Windows, as in Tern. On Linux the window manager frames the main
            // window (Hyprland draws no frame at all), and the UI leaves the window buttons out.
            #[cfg(target_os = "linux")]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_decorations(true);
            }
            // Petrel can stay open for weeks; the version policies still apply.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(SWEEP_EVERY);
                let state = handle.state::<AppState>();
                let Ok(mut store) = state.store.lock() else { return };
                sweep(&mut store);
            });
            if capture {
                open_capture(app.handle());
            }
            if picker {
                open_picker(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::rescue_text,
            commands::close_window,
            commands::show_window,
            commands::close_capture,
            commands::open_capture_window,
            commands::capture_context,
            commands::open_picker_window,
            commands::close_picker,
            commands::show_note_in_main,
            commands::copy_text,
            commands::desktop_settings,
            commands::ui_settings,
            commands::set_ui_setting,
            commands::set_hotkey,
            commands::set_autostart,
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
            notes::capture_note,
            notes::move_note,
            notes::merge_note,
            notes::undo_note,
            notes::note_versions,
            notes::note_version_text,
            notes::restore_note_version,
            notes::record_copy,
            notes::copy_counts,
            notes::link_targets,
            notes::resolve_link,
            notes::backlinks,
            notes::link_mention,
            notes::day_note,
            notes::file_into_day,
            notes::notes_between,
            notes::topic_faces,
            notes::set_topic_face,
            notes::save_attachment,
            notes::attachment,
            ai::ai_status,
            ai::set_ai_key,
            ai::ai_write,
            ai::ai_ask,
            ai::ai_suggest_home,
            ai::ai_related,
            ai::ai_week,
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
