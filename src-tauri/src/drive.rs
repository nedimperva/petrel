//! Google Drive as the sync engine's remote (`petrel_core::sync::Remote`), over the Drive REST API v3 with `ureq`.
//! The notes live in `My Drive/Petrel` as the same files, folders as folders. With the `drive.file` scope a list
//! of files is only the files Petrel made, so "everything" is one paged call. What changed is asked of
//! `changes.list` with a page token, so a quiet folder costs one small request per check.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use petrel_core::sync::{Remote, RemoteFile};
use serde_json::{json, Value};

const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";
const FOLDER: &str = "application/vnd.google-apps.folder";
/// The folder's name in My Drive.
pub const FOLDER_NAME: &str = "Petrel";
/// Reading a file at most this big (the engine skips larger ones).
const READ_LIMIT: u64 = 64 * 1024 * 1024;

pub struct Drive {
    token: Box<dyn FnMut() -> Result<String> + Send>,
    agent: ureq::Agent,
    /// The Petrel folder's id.
    pub root: String,
    /// The change token: where the last look at `changes.list` ended.
    pub cursor: Option<String>,
    /// Folder path ("" is the root) → id, filled by `list` and by making folders.
    folders: HashMap<String, String>,
}

impl Drive {
    pub fn new(
        token: impl FnMut() -> Result<String> + Send + 'static,
        root: String,
        cursor: Option<String>,
    ) -> Drive {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(120)))
            .build()
            .into();
        let mut folders = HashMap::new();
        folders.insert(String::new(), root.clone());
        Drive { token: Box::new(token), agent, root, cursor, folders }
    }

    fn bearer(&mut self) -> Result<String> {
        Ok(format!("Bearer {}", (self.token)()?))
    }

    fn get_json(&mut self, url: &str) -> Result<Value> {
        let auth = self.bearer()?;
        let mut resp = self.agent.get(url).header("Authorization", &auth).call().map_err(offline)?;
        let status = resp.status().as_u16();
        let v: Value = resp.body_mut().read_json().map_err(|e| anyhow!("reading Drive's answer: {e}"))?;
        check(status, &v)?;
        Ok(v)
    }

    fn send_json(&mut self, method: &str, url: &str, body: &Value) -> Result<Value> {
        let auth = self.bearer()?;
        let req = match method {
            "PATCH" => self.agent.patch(url),
            _ => self.agent.post(url),
        };
        let mut resp = req.header("Authorization", &auth).send_json(body).map_err(offline)?;
        let status = resp.status().as_u16();
        let v: Value = resp.body_mut().read_json().map_err(|e| anyhow!("reading Drive's answer: {e}"))?;
        check(status, &v)?;
        Ok(v)
    }

    /// The Petrel folder in My Drive: the one Petrel made before (on this computer or another), or a new one.
    pub fn find_or_make_root(token: impl FnMut() -> Result<String> + Send + 'static) -> Result<String> {
        let mut d = Drive::new(token, String::new(), None);
        let q = format!(
            "name = '{FOLDER_NAME}' and mimeType = '{FOLDER}' and 'root' in parents and trashed = false"
        );
        let v = d.get_json(&format!("{API}/files?q={}&fields=files(id)&spaces=drive", enc(&q)))?;
        if let Some(id) = v["files"].as_array().and_then(|a| a.first()).and_then(|f| f["id"].as_str()) {
            return Ok(id.to_string());
        }
        let v = d.send_json(
            "POST",
            &format!("{API}/files?fields=id"),
            &json!({ "name": FOLDER_NAME, "mimeType": FOLDER, "parents": ["root"] }),
        )?;
        v["id"].as_str().map(str::to_string).context("Drive made no folder")
    }

    /// The Google account, for Settings.
    pub fn account(&mut self) -> Result<String> {
        let v = self.get_json(&format!("{API}/about?fields=user(emailAddress)"))?;
        Ok(v["user"]["emailAddress"].as_str().unwrap_or("").to_string())
    }

    /// The id of the folder at `path` ("Travel/Rome"), making the missing ones.
    fn folder(&mut self, path: &str) -> Result<String> {
        if let Some(id) = self.folders.get(path) {
            return Ok(id.clone());
        }
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        let parent_id = self.folder(parent)?;
        let v = self.send_json(
            "POST",
            &format!("{API}/files?fields=id"),
            &json!({ "name": name, "mimeType": FOLDER, "parents": [parent_id] }),
        )?;
        let id = v["id"].as_str().context("Drive made no folder")?.to_string();
        self.folders.insert(path.to_string(), id.clone());
        Ok(id)
    }
}

impl Remote for Drive {
    fn has_changes(&mut self) -> Result<bool> {
        let Some(mut token) = self.cursor.clone() else {
            // First look: start counting changes from now; everything is listed this time anyway.
            let v = self.get_json(&format!("{API}/changes/startPageToken"))?;
            self.cursor = v["startPageToken"].as_str().map(str::to_string);
            return Ok(true);
        };
        let mut any = false;
        loop {
            let v = self.get_json(&format!(
                "{API}/changes?pageToken={}&pageSize=1000&spaces=drive&fields=nextPageToken,newStartPageToken,changes(fileId)",
                enc(&token)
            ))?;
            any |= v["changes"].as_array().is_some_and(|c| !c.is_empty());
            if let Some(next) = v["nextPageToken"].as_str() {
                token = next.to_string();
                continue;
            }
            if let Some(start) = v["newStartPageToken"].as_str() {
                self.cursor = Some(start.to_string());
            }
            return Ok(any);
        }
    }

    fn list(&mut self) -> Result<Vec<RemoteFile>> {
        // Every file Petrel made (drive.file), then paths worked out from their parents.
        struct Item {
            name: String,
            parent: Option<String>,
            folder: bool,
            md5: String,
        }
        let mut items: HashMap<String, Item> = HashMap::new();
        let mut page: Option<String> = None;
        loop {
            let mut url = format!(
                "{API}/files?q={}&pageSize=1000&spaces=drive&fields=nextPageToken,files(id,name,parents,mimeType,md5Checksum)",
                enc("trashed = false")
            );
            if let Some(p) = &page {
                url.push_str(&format!("&pageToken={}", enc(p)));
            }
            let v = self.get_json(&url)?;
            for f in v["files"].as_array().into_iter().flatten() {
                let Some(id) = f["id"].as_str() else { continue };
                items.insert(
                    id.to_string(),
                    Item {
                        name: f["name"].as_str().unwrap_or("").to_string(),
                        parent: f["parents"]
                            .as_array()
                            .and_then(|p| p.first())
                            .and_then(|p| p.as_str())
                            .map(str::to_string),
                        folder: f["mimeType"] == FOLDER,
                        md5: f["md5Checksum"].as_str().unwrap_or("").to_string(),
                    },
                );
            }
            match v["nextPageToken"].as_str() {
                Some(p) => page = Some(p.to_string()),
                None => break,
            }
        }
        // The path of an item under the Petrel folder; None when it is somewhere else.
        let path_of = |id: &str| -> Option<String> {
            let mut parts = Vec::new();
            let mut at = id.to_string();
            for _ in 0..64 {
                if at == self.root {
                    parts.reverse();
                    return Some(parts.join("/"));
                }
                let item = items.get(&at)?;
                parts.push(item.name.clone());
                at = item.parent.clone()?;
            }
            None
        };
        let mut folders = HashMap::new();
        folders.insert(String::new(), self.root.clone());
        let mut out = Vec::new();
        for (id, item) in &items {
            let Some(path) = path_of(id) else { continue };
            if item.folder {
                folders.insert(path, id.clone());
            } else if !path.is_empty() {
                out.push(RemoteFile { id: id.clone(), path, md5: item.md5.clone() });
            }
        }
        self.folders = folders;
        Ok(out)
    }

    fn download(&mut self, id: &str) -> Result<Vec<u8>> {
        let auth = self.bearer()?;
        let mut resp = self
            .agent
            .get(&format!("{API}/files/{id}?alt=media"))
            .header("Authorization", &auth)
            .call()
            .map_err(offline)?;
        let status = resp.status().as_u16();
        if status != 200 {
            let v: Value = resp.body_mut().read_json().unwrap_or(Value::Null);
            check(status, &v)?;
        }
        resp.body_mut().with_config().limit(READ_LIMIT).read_to_vec().map_err(|e| anyhow!("downloading: {e}"))
    }

    fn upload(&mut self, path: &str, id: Option<&str>, bytes: &[u8]) -> Result<RemoteFile> {
        let auth = self.bearer()?;
        let v: Value = match id {
            Some(id) => {
                let mut resp = self
                    .agent
                    .patch(&format!("{UPLOAD}/files/{id}?uploadType=media&fields=id,md5Checksum"))
                    .header("Authorization", &auth)
                    .header("Content-Type", "application/octet-stream")
                    .send(bytes)
                    .map_err(offline)?;
                let status = resp.status().as_u16();
                let v = resp.body_mut().read_json().map_err(|e| anyhow!("reading Drive's answer: {e}"))?;
                check(status, &v)?;
                v
            }
            None => {
                let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
                let parent = self.folder(dir)?;
                let meta = json!({ "name": name, "parents": [parent] });
                let boundary = "petrel-boundary-7f3c1d";
                let mut body = Vec::with_capacity(bytes.len() + 512);
                body.extend_from_slice(
                    format!(
                        "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n\
                         --{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n"
                    )
                    .as_bytes(),
                );
                body.extend_from_slice(bytes);
                body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
                let mut resp = self
                    .agent
                    .post(&format!("{UPLOAD}/files?uploadType=multipart&fields=id,md5Checksum"))
                    .header("Authorization", &auth)
                    .header("Content-Type", &format!("multipart/related; boundary={boundary}"))
                    .send(&body[..])
                    .map_err(offline)?;
                let status = resp.status().as_u16();
                let v = resp.body_mut().read_json().map_err(|e| anyhow!("reading Drive's answer: {e}"))?;
                check(status, &v)?;
                v
            }
        };
        Ok(RemoteFile {
            id: v["id"].as_str().context("Drive sent no id")?.to_string(),
            path: path.to_string(),
            md5: v["md5Checksum"].as_str().unwrap_or("").to_string(),
        })
    }

    fn trash(&mut self, id: &str) -> Result<()> {
        match self.send_json("PATCH", &format!("{API}/files/{id}?fields=id"), &json!({ "trashed": true })) {
            Ok(_) => Ok(()),
            // Already gone there: nothing left to do.
            Err(e) if e.to_string().contains("404") => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// Could not reach Drive at all.
#[derive(Debug)]
pub struct Offline(pub String);

impl std::fmt::Display for Offline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "cannot reach Google Drive: {}", self.0)
    }
}

impl std::error::Error for Offline {}

fn offline(e: ureq::Error) -> anyhow::Error {
    Offline(e.to_string()).into()
}

fn check(status: u16, v: &Value) -> Result<()> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    let msg = v["error"]["message"].as_str().unwrap_or("no message");
    if status == 401 {
        return Err(crate::google::SignInAgain.into());
    }
    bail!("Drive said {status}: {msg}")
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}
