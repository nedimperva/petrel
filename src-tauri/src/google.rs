//! Signing in to Google for sync, with no server of ours: the desktop OAuth flow. The browser opens Google's
//! page; Google sends the answer back to Petrel on 127.0.0.1 at a port picked for this sign-in, with PKCE, so
//! the code is useless to anyone else. The refresh token goes to the OS keyring (service `petrel`, user
//! `google-refresh-token`), the client secret too; the short-lived access token stays in memory.
//!
//! The scope is `drive.file`: Petrel sees only the files it made. Google lets an app with only this scope be
//! published without a review, and a published one keeps its sign-in (a "Testing" one expires every 7 days).

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

const KEYRING_SERVICE: &str = "petrel";
const REFRESH_USER: &str = "google-refresh-token";
const SECRET_USER: &str = "google-client-secret";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
/// Read-only access to calendar events, asked for only when today's calendar is turned on (Settings › Sync).
pub const CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.events.readonly";
/// How long the browser has to come back.
const SIGN_IN_WAIT: Duration = Duration::from_secs(300);

fn entry(user: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, user).map_err(|e| anyhow!("the keyring: {e}"))
}

fn read(user: &str) -> Result<Option<String>> {
    match entry(user)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow!("reading the keyring: {e}")),
    }
}

fn write(user: &str, value: Option<&str>) -> Result<()> {
    let e = entry(user)?;
    match value {
        Some(v) => e.set_password(v).map_err(|e| anyhow!("saving in the keyring: {e}")),
        None => match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(anyhow!("removing from the keyring: {e}")),
        },
    }
}

pub fn client_secret() -> Result<Option<String>> {
    read(SECRET_USER)
}

pub fn set_client_secret(secret: Option<&str>) -> Result<()> {
    write(SECRET_USER, secret)
}

pub fn signed_in() -> bool {
    read(REFRESH_USER).ok().flatten().is_some()
}

pub fn sign_out() -> Result<()> {
    if let Ok(mut t) = TOKEN.lock() {
        *t = None;
    }
    write(REFRESH_USER, None)
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(60)))
        .build()
        .into()
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random(n: usize) -> Result<String> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).map_err(|e| anyhow!("no randomness: {e}"))?;
    Ok(b64(&buf))
}

/// Opens Google's sign-in in the browser (`open`) and waits for it to come back. Saves the refresh token.
/// `calendar` adds read-only calendar events to the Drive scope. Returns the scopes Google granted.
pub fn sign_in(client_id: &str, calendar: bool, open: impl FnOnce(&str) -> Result<()>) -> Result<String> {
    let secret = client_secret()?.context("add the client secret first")?;
    let listener = TcpListener::bind("127.0.0.1:0").context("opening a port for the sign-in")?;
    let port = listener.local_addr()?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = random(48)?;
    let challenge = b64(&Sha256::digest(verifier.as_bytes()));
    let state = random(16)?;
    let url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={challenge}\
         &code_challenge_method=S256&access_type=offline&prompt=consent&state={state}",
        enc(client_id),
        enc(&redirect),
        enc(&if calendar { format!("{SCOPE} {CALENDAR_SCOPE}") } else { SCOPE.to_string() }),
    );
    open(&url)?;
    let code = wait_for_code(&listener, &state)?;
    let mut resp = agent()
        .post(TOKEN_URL)
        .send_form([
            ("code", code.as_str()),
            ("client_id", client_id),
            ("client_secret", secret.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect.as_str()),
        ])
        .map_err(|e| anyhow!("cannot reach Google: {e}"))?;
    let status = resp.status().as_u16();
    let v: Value = resp.body_mut().read_json().map_err(|e| anyhow!("reading Google's answer: {e}"))?;
    if status != 200 {
        bail!(
            "Google said no: {}",
            v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("unknown")
        );
    }
    let refresh = v["refresh_token"].as_str().context("Google sent no refresh token")?;
    write(REFRESH_USER, Some(refresh))?;
    remember(&v);
    Ok(v["scope"].as_str().unwrap_or(SCOPE).to_string())
}

/// Waits for the browser to come back with `?code=…&state=…`, and tells it it can close.
fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String> {
    listener.set_nonblocking(true)?;
    let until = Instant::now() + SIGN_IN_WAIT;
    loop {
        if Instant::now() > until {
            bail!("the sign-in was not finished in five minutes");
        }
        let (mut stream, _) = match listener.accept() {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line)?;
        // `GET /?state=…&code=…&scope=… HTTP/1.1`; anything else (a favicon) is answered and ignored.
        let target = line.split_whitespace().nth(1).unwrap_or("");
        let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
        let param =
            |name: &str| query.split('&').find_map(|kv| kv.strip_prefix(&format!("{name}="))).map(dec);
        let (body, done) = match (param("code"), param("state"), param("error")) {
            (_, _, Some(err)) => {
                (format!("Petrel was not connected ({err}). You can close this tab."), Some(Err(err)))
            }
            (Some(code), Some(s), _) if s == state => {
                ("Petrel is connected to Google Drive. You can close this tab.".to_string(), Some(Ok(code)))
            }
            _ => (String::new(), None),
        };
        let page = format!(
            "<!doctype html><meta charset=utf-8><title>Petrel</title>\
             <body style=\"font:16px system-ui;margin:20vh auto;max-width:28em;text-align:center\">{body}</body>"
        );
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
            page.len()
        );
        match done {
            Some(Ok(code)) => return Ok(code),
            Some(Err(err)) => bail!("Google sign-in: {err}"),
            None => continue,
        }
    }
}

/// The access token and when it runs out.
static TOKEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);

fn remember(v: &Value) {
    if let (Some(t), Some(secs)) = (v["access_token"].as_str(), v["expires_in"].as_u64()) {
        if let Ok(mut slot) = TOKEN.lock() {
            *slot = Some((t.to_string(), Instant::now() + Duration::from_secs(secs.saturating_sub(60))));
        }
    }
}

/// Signed out, or Google took the sign-in back: the person has to sign in again.
#[derive(Debug)]
pub struct SignInAgain;

impl std::fmt::Display for SignInAgain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("sign in to Google again")
    }
}

impl std::error::Error for SignInAgain {}

/// An access token, refreshed when it is about to run out.
/// A plain HTTP agent that does not turn statuses into errors, for the Google APIs beside Drive.
pub fn http() -> ureq::Agent {
    agent()
}

pub fn access_token(client_id: &str) -> Result<String> {
    if let Ok(slot) = TOKEN.lock() {
        if let Some((t, until)) = slot.as_ref() {
            if Instant::now() < *until {
                return Ok(t.clone());
            }
        }
    }
    let Some(refresh) = read(REFRESH_USER)? else { return Err(SignInAgain.into()) };
    let secret = client_secret()?.ok_or(SignInAgain)?;
    let mut resp = agent()
        .post(TOKEN_URL)
        .send_form([
            ("client_id", client_id),
            ("client_secret", secret.as_str()),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .map_err(|e| anyhow!("cannot reach Google: {e}"))?;
    let status = resp.status().as_u16();
    let v: Value = resp.body_mut().read_json().map_err(|e| anyhow!("reading Google's answer: {e}"))?;
    if status == 400 || status == 401 {
        // invalid_grant: revoked, expired (a "Testing" app), or the password changed.
        let _ = write(REFRESH_USER, None);
        return Err(SignInAgain.into());
    }
    if status != 200 {
        bail!("Google said {status}: {}", v["error"].as_str().unwrap_or("unknown"));
    }
    remember(&v);
    v["access_token"].as_str().map(str::to_string).context("Google sent no access token")
}

/// Percent-encoding for a query value.
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(v) => {
                    out.push(v);
                    i += 2;
                }
                Err(_) => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding() {
        assert_eq!(enc("http://127.0.0.1:5"), "http%3A%2F%2F127.0.0.1%3A5");
        assert_eq!(dec("4%2F0Ab_x"), "4/0Ab_x");
        assert_eq!(dec("a+b%"), "a b%");
    }
}
