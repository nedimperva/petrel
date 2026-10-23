//! The window's `Host`: what an action reaches outside the database when it runs from the app. Files and
//! commands go through `petrel_core::host::system`; anything that needs the person (confirm, the trust dialog,
//! prompts, previews) is a request to the webview, answered with the `host_reply` command.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Result};
use petrel_core::host::{
    system, CancelToken, Command, CommandOutput, Host, MessageKind, PromptReply, PromptSpec, ScopeItem,
    WriteMode,
};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

/// Requests waiting on the webview, by id. A reply is a JSON value whose shape the request kind defines.
#[derive(Default)]
pub struct Broker {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
}

impl Broker {
    /// Sends a request with `send(id)` and waits for its reply. `None` when the run is cancelled (the dialog is
    /// told to close) or the request could not be sent.
    pub fn ask(
        &self,
        send: impl FnOnce(u64) -> Result<()>,
        closed: impl FnOnce(u64),
        cancel: &CancelToken,
    ) -> Option<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        self.pending.lock().ok()?.insert(id, tx);
        if let Err(e) = send(id) {
            log::warn!("host request {id}: {e:#}");
            self.forget(id);
            return None;
        }
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(v) => return Some(v),
                Err(RecvTimeoutError::Timeout) if !cancel.is_cancelled() => {}
                Err(_) => {
                    self.forget(id);
                    closed(id);
                    return None;
                }
            }
        }
    }

    /// `false` when nothing waits for `id` (answered already, or the run was cancelled).
    pub fn answer(&self, id: u64, value: Value) -> bool {
        let tx = self.pending.lock().ok().and_then(|mut p| p.remove(&id));
        tx.is_some_and(|tx| tx.send(value).is_ok())
    }

    fn forget(&self, id: u64) {
        if let Ok(mut p) = self.pending.lock() {
            p.remove(&id);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Request<'a> {
    id: u64,
    kind: &'a str,
    payload: Value,
}

pub struct TauriHost<'a> {
    pub app: &'a AppHandle,
    pub broker: &'a Broker,
    pub clipboard: &'a Mutex<Option<arboard::Clipboard>>,
    pub cancel: CancelToken,
}

impl TauriHost<'_> {
    fn ask(&self, kind: &str, payload: Value) -> Option<Value> {
        let app = self.app;
        self.broker.ask(
            |id| Ok(app.emit("host-request", Request { id, kind, payload })?),
            |id| {
                let _ = app.emit("host-closed", id);
            },
            &self.cancel,
        )
    }

    fn with_clipboard<T>(
        &self,
        f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
    ) -> Result<T> {
        let mut slot = self.clipboard.lock().map_err(|_| anyhow!("clipboard lock poisoned"))?;
        // One clipboard for the app's life: on Linux the copied text is served by this process, and dropping
        // the handle can take it with it.
        if slot.is_none() {
            *slot = Some(arboard::Clipboard::new().map_err(|e| anyhow!("no clipboard: {e}"))?);
        }
        f(slot.as_mut().expect("set above")).map_err(|e| anyhow!("clipboard: {e}"))
    }
}

impl Host for TauriHost<'_> {
    fn clipboard_get(&mut self) -> Result<String> {
        match self.with_clipboard(|c| c.get_text()) {
            Err(e) if e.to_string().contains("empty") => Ok(String::new()),
            r => r,
        }
    }

    fn clipboard_set(&mut self, text: &str) -> Result<()> {
        self.with_clipboard(|c| c.set_text(text))
    }

    fn open_url(&mut self, url: &str, _browser: bool) -> Result<()> {
        self.app.opener().open_url(url, None::<&str>).map_err(|e| anyhow!("opening {url}: {e}"))
    }

    fn read_file(&mut self, path: &Path) -> Result<Option<String>> {
        system::read_file(path)
    }

    fn write_file(&mut self, path: &Path, text: &str, mode: WriteMode, create_dirs: bool) -> Result<()> {
        system::write_file(path, text, mode, create_dirs)
    }

    fn run_command(&mut self, command: &Command, cancel: &CancelToken) -> Result<CommandOutput> {
        system::run_command(command, cancel)
    }

    fn confirm(&mut self, title: &str, message: &str) -> Result<bool> {
        let v = self.ask("confirm", json!({ "title": title, "message": message }));
        Ok(v.and_then(|v| v.as_bool()).unwrap_or(false))
    }

    fn confirm_scope(&mut self, action: &str, items: &[ScopeItem]) -> Result<bool> {
        let v = self.ask("scope", json!({ "action": action, "items": items }));
        Ok(v.and_then(|v| v.as_bool()).unwrap_or(false))
    }

    fn prompt(&mut self, prompt: &PromptSpec) -> Result<Option<PromptReply>> {
        let Some(v) = self.ask("prompt", serde_json::to_value(prompt)?) else { return Ok(None) };
        // `null` is a dismissed prompt.
        Ok(serde_json::from_value(v).ok())
    }

    fn preview(&mut self, html: &str, css: &str, continue_button: bool) -> Result<bool> {
        let v = self.ask("preview", json!({ "html": html, "css": css, "continueButton": continue_button }));
        Ok(v.and_then(|v| v.as_bool()).unwrap_or(false))
    }

    fn message(&mut self, kind: MessageKind, text: &str) {
        // Success and failure come back to the window in the run report; only other messages need an event.
        if matches!(kind, MessageKind::Info | MessageKind::Warning) {
            let _ = self.app.emit("host-message", json!({ "kind": kind, "text": text }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_reaches_the_waiting_request() {
        let broker = std::sync::Arc::new(Broker::default());
        let b = broker.clone();
        let (sent_tx, sent_rx) = mpsc::channel();
        let asker = std::thread::spawn(move || {
            b.ask(
                |id| {
                    sent_tx.send(id).unwrap();
                    Ok(())
                },
                |_| panic!("not cancelled"),
                &CancelToken::default(),
            )
        });
        let id = sent_rx.recv().unwrap();
        assert!(broker.answer(id, json!(true)));
        assert_eq!(asker.join().unwrap(), Some(json!(true)));
        assert!(!broker.answer(id, json!(true)), "a request is answered once");
    }

    #[test]
    fn cancelling_closes_the_request() {
        let broker = Broker::default();
        let cancel = CancelToken::default();
        cancel.cancel();
        let closed = Mutex::new(None);
        let got = broker.ask(|_| Ok(()), |id| *closed.lock().unwrap() = Some(id), &cancel);
        assert_eq!(got, None);
        let id = closed.lock().unwrap().expect("the dialog is told to close");
        assert!(!broker.answer(id, json!(true)), "a late answer goes nowhere");
    }

    #[test]
    fn a_request_that_cannot_be_sent_is_dropped() {
        let broker = Broker::default();
        let got = broker.ask(|_| Err(anyhow!("no window")), |_| {}, &CancelToken::default());
        assert_eq!(got, None);
        assert!(broker.pending.lock().unwrap().is_empty());
    }
}
