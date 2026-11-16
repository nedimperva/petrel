//! Google Drive as the sync engine's remote (`petrel_core::sync::Remote`), over the Drive REST API v3 with `ureq`.
//! The notes live in `My Drive/Petrel` as the same files, folders as folders. With the `drive.file` scope a list
//! of files is only the files Petrel made, so "everything" is one paged call. What changed is asked of
//! `changes.list` with a page token, so a quiet folder costs one small request per check.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use petrel_core::sync::{Remote, RemoteFile};
use serde_json::{json, Value};

const GOOGLE: &str = "https://www.googleapis.com";

/// Google's API, or in a debug build `PETREL_DRIVE_URL` (a stand-in Drive for testing, `tests/fake_drive.py`).
fn base() -> String {
    if cfg!(debug_assertions) {
        if let Ok(u) = std::env::var("PETREL_DRIVE_URL") {
            return u;
        }
    }
    GOOGLE.to_string()
}

fn api() -> String {
    format!("{}/drive/v3", base())
}

fn upload_url() -> String {
    format!("{}/upload/drive/v3", base())
}
const FOLDER: &str = "application/vnd.google-apps.folder";
/// The folder's name in My Drive.
pub const FOLDER_NAME: &str = "Petrel";
/// Reading a file at most this big (the engine skips larger ones).
const READ_LIMIT: u64 = 64 * 1024 * 1024;

/// A folder made twice: (the one kept, an extra one, the extra one's children).
type Twin = (String, String, Vec<String>);

/// How many transfers run side by side. Drive allows more; four keeps a first sync quick without tripping its
/// per-user rate limit.
const PARALLEL: usize = 4;

/// One agent for every sync, so its connections to Google are kept and reused rather than opened each time.
fn shared_agent() -> ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT
        .get_or_init(|| {
            ureq::Agent::config_builder()
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(120)))
                .build()
                .into()
        })
        .clone()
}

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
        let agent = shared_agent();
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
        let v = d.get_json(&format!("{}/files?q={}&fields=files(id)&spaces=drive", api(), enc(&q)))?;
        if let Some(id) = v["files"].as_array().and_then(|a| a.first()).and_then(|f| f["id"].as_str()) {
            return Ok(id.to_string());
        }
        let v = d.send_json(
            "POST",
            &format!("{}/files?fields=id", api()),
            &json!({ "name": FOLDER_NAME, "mimeType": FOLDER, "parents": ["root"] }),
        )?;
        v["id"].as_str().map(str::to_string).context("Drive made no folder")
    }

    /// The Google account, for Settings.
    pub fn account(&mut self) -> Result<String> {
        let v = self.get_json(&format!("{}/about?fields=user(emailAddress)", api()))?;
        Ok(v["user"]["emailAddress"].as_str().unwrap_or("").to_string())
    }

    /// The id of the folder at `path` ("Travel/Rome"), making the missing ones.
    fn folder(&mut self, path: &str) -> Result<String> {
        if let Some(id) = self.folders.get(path) {
            return Ok(id.clone());
        }
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        let parent_id = self.folder(parent)?;
        // The cache only knows what the last full list saw, and a sync with nothing new on Drive skips that list:
        // ask Drive before making one, or every new file in `inbox/` makes another `inbox`.
        let q = format!(
            "name = '{}' and mimeType = '{FOLDER}' and '{}' in parents and trashed = false",
            quote(name),
            quote(&parent_id)
        );
        let v = self.get_json(&format!(
            "{}/files?q={}&orderBy=createdTime&fields=files(id)&spaces=drive",
            api(),
            enc(&q)
        ))?;
        if let Some(id) = v["files"].as_array().and_then(|a| a.first()).and_then(|f| f["id"].as_str()) {
            self.folders.insert(path.to_string(), id.to_string());
            return Ok(id.to_string());
        }
        let v = self.send_json(
            "POST",
            &format!("{}/files?fields=id", api()),
            &json!({ "name": name, "mimeType": FOLDER, "parents": [parent_id] }),
        )?;
        let id = v["id"].as_str().context("Drive made no folder")?.to_string();
        self.folders.insert(path.to_string(), id.clone());
        Ok(id)
    }

    /// Every file Petrel made (drive.file) with its path under the Petrel folder, and the folders that are there
    /// twice: (the one kept, an extra one, the extra one's children).
    fn list_once(&mut self) -> Result<(Vec<RemoteFile>, Vec<Twin>)> {
        struct Item {
            name: String,
            parent: Option<String>,
            folder: bool,
            md5: String,
            created: String,
        }
        let mut items: HashMap<String, Item> = HashMap::new();
        let mut page: Option<String> = None;
        loop {
            let mut url = format!(
                "{API}/files?q={}&pageSize=1000&spaces=drive&fields=nextPageToken,files(id,name,parents,mimeType,md5Checksum,createdTime)",
                enc("trashed = false"),
                API = api()
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
                        created: f["createdTime"].as_str().unwrap_or("").to_string(),
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
        // Folders by path, oldest first: the oldest is the one kept.
        let mut by_path: HashMap<String, Vec<(&str, &str)>> = HashMap::new();
        let mut out = Vec::new();
        for (id, item) in &items {
            let Some(path) = path_of(id) else { continue };
            if item.folder {
                by_path.entry(path).or_default().push((item.created.as_str(), id.as_str()));
            } else if !path.is_empty() {
                out.push(RemoteFile { id: id.clone(), path, md5: item.md5.clone() });
            }
        }
        let mut folders = HashMap::new();
        folders.insert(String::new(), self.root.clone());
        let mut twins = Vec::new();
        for (path, mut ids) in by_path {
            ids.sort();
            let keep = ids[0].1.to_string();
            for (_, extra) in &ids[1..] {
                let children = items
                    .iter()
                    .filter(|(_, i)| i.parent.as_deref() == Some(*extra))
                    .map(|(c, _)| c.clone())
                    .collect();
                twins.push((keep.clone(), extra.to_string(), children));
            }
            folders.insert(path, keep);
        }
        self.folders = folders;
        Ok((out, twins))
    }

    /// Moves what is in `extra` into `keep`, a folder of the same name and place, and trashes `extra`.
    fn fold_folder(&mut self, keep: &str, extra: &str, children: &[String]) -> Result<()> {
        for c in children {
            self.send_json(
                "PATCH",
                &format!(
                    "{}/files/{c}?addParents={}&removeParents={}&fields=id",
                    api(),
                    enc(keep),
                    enc(extra)
                ),
                &json!({}),
            )?;
        }
        self.send_json("PATCH", &format!("{}/files/{extra}?fields=id", api()), &json!({ "trashed": true }))?;
        Ok(())
    }
}

/// A value inside a Drive query: `'` and `\` escaped.
fn quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

impl Remote for Drive {
    fn has_changes(&mut self) -> Result<bool> {
        let Some(mut token) = self.cursor.clone() else {
            // First look: start counting changes from now; everything is listed this time anyway.
            let v = self.get_json(&format!("{}/changes/startPageToken", api()))?;
            self.cursor = v["startPageToken"].as_str().map(str::to_string);
            return Ok(true);
        };
        let mut any = false;
        loop {
            let v = self.get_json(&format!(
                "{API}/changes?pageToken={}&pageSize=1000&spaces=drive&fields=nextPageToken,newStartPageToken,changes(fileId)",
                enc(&token),
                API = api()
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
        // Folders made twice (an earlier Petrel did that) are put back together, then listed again. A few rounds
        // cover folders inside them that were made twice too.
        for _ in 0..4 {
            let (files, twins) = self.list_once()?;
            if twins.is_empty() {
                return Ok(files);
            }
            for (keep, extra, children) in twins {
                self.fold_folder(&keep, &extra, &children)?;
            }
        }
        Ok(self.list_once()?.0)
    }

    fn download(&mut self, id: &str) -> Result<Vec<u8>> {
        let auth = self.bearer()?;
        download_one(&self.agent, &auth, id)
    }

    fn upload(&mut self, path: &str, id: Option<&str>, bytes: &[u8]) -> Result<RemoteFile> {
        let auth = self.bearer()?;
        let parent = match id {
            Some(_) => None,
            None => Some(self.folder(path.rsplit_once('/').map_or("", |(d, _)| d))?),
        };
        upload_one(&self.agent, &auth, path, id, parent.as_deref(), bytes)
    }

    fn upload_many(&mut self, items: &[(String, Option<String>, Vec<u8>)]) -> Vec<Result<RemoteFile>> {
        let auth = match self.bearer() {
            Ok(a) => a,
            Err(e) => return items.iter().map(|_| Err(anyhow!("{e:#}"))).collect(),
        };
        // Folders are made one at a time first, so two new files in one new folder do not make it twice.
        let parents: Vec<Result<Option<String>>> = items
            .iter()
            .map(|(path, id, _)| match id {
                Some(_) => Ok(None),
                None => self.folder(path.rsplit_once('/').map_or("", |(d, _)| d)).map(Some),
            })
            .collect();
        let agent = &self.agent;
        let jobs: Vec<_> = items.iter().zip(parents).collect();
        in_parallel(&jobs, |((path, id, bytes), parent)| match parent {
            Ok(parent) => upload_one(agent, &auth, path, id.as_deref(), parent.as_deref(), bytes),
            Err(e) => Err(anyhow!("{e:#}")),
        })
    }

    fn download_many(&mut self, ids: &[String]) -> Vec<Result<Vec<u8>>> {
        let auth = match self.bearer() {
            Ok(a) => a,
            Err(e) => return ids.iter().map(|_| Err(anyhow!("{e:#}"))).collect(),
        };
        let agent = &self.agent;
        in_parallel(ids, |id| download_one(agent, &auth, id))
    }

    fn move_to(&mut self, id: &str, path: &str) -> Result<Option<RemoteFile>> {
        let v = self.get_json(&format!("{}/files/{id}?fields=parents", api()))?;
        let from: Vec<String> = v["parents"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p.as_str().map(str::to_string))
            .collect();
        let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
        let to = self.folder(dir)?;
        let mut url = format!("{}/files/{id}?fields=id,md5Checksum", api());
        if !from.contains(&to) {
            url.push_str(&format!("&addParents={}&removeParents={}", enc(&to), enc(&from.join(","))));
        }
        let v = self.send_json("PATCH", &url, &json!({ "name": name }))?;
        Ok(Some(RemoteFile {
            id: v["id"].as_str().unwrap_or(id).to_string(),
            path: path.to_string(),
            md5: v["md5Checksum"].as_str().unwrap_or("").to_string(),
        }))
    }

    fn trash(&mut self, id: &str) -> Result<()> {
        match self.send_json("PATCH", &format!("{}/files/{id}?fields=id", api()), &json!({ "trashed": true }))
        {
            Ok(_) => Ok(()),
            // Already gone there: nothing left to do.
            Err(e) if e.to_string().contains("404") => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// Runs `f` over `items` on up to `PARALLEL` threads, answers in the order of `items`.
fn in_parallel<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let mut out: Vec<Option<R>> = (0..items.len()).map(|_| None).collect();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let slots = std::sync::Mutex::new(&mut out);
    std::thread::scope(|scope| {
        for _ in 0..PARALLEL.min(items.len()) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(item) = items.get(i) else { break };
                let r = f(item);
                slots.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(r);
            });
        }
    });
    out.into_iter().map(|r| r.expect("every item ran")).collect()
}

fn download_one(agent: &ureq::Agent, auth: &str, id: &str) -> Result<Vec<u8>> {
    let mut resp = agent
        .get(&format!("{}/files/{id}?alt=media", api()))
        .header("Authorization", auth)
        .call()
        .map_err(offline)?;
    let status = resp.status().as_u16();
    if status != 200 {
        let v: Value = resp.body_mut().read_json().unwrap_or(Value::Null);
        check(status, &v)?;
    }
    resp.body_mut().with_config().limit(READ_LIMIT).read_to_vec().map_err(|e| anyhow!("downloading: {e}"))
}

/// New text for `id`, or a new file named after `path` in the folder `parent`.
fn upload_one(
    agent: &ureq::Agent,
    auth: &str,
    path: &str,
    id: Option<&str>,
    parent: Option<&str>,
    bytes: &[u8],
) -> Result<RemoteFile> {
    let v: Value = match id {
        Some(id) => {
            let mut resp = agent
                .patch(&format!("{}/files/{id}?uploadType=media&fields=id,md5Checksum", upload_url()))
                .header("Authorization", auth)
                .header("Content-Type", "application/octet-stream")
                .send(bytes)
                .map_err(offline)?;
            let status = resp.status().as_u16();
            let v = resp.body_mut().read_json().map_err(|e| anyhow!("reading Drive's answer: {e}"))?;
            check(status, &v)?;
            v
        }
        None => {
            let name = path.rsplit_once('/').map_or(path, |(_, n)| n);
            let parent = parent.context("no folder for a new file")?;
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
            let mut resp = agent
                .post(&format!("{}/files?uploadType=multipart&fields=id,md5Checksum", upload_url()))
                .header("Authorization", auth)
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

#[cfg(test)]
mod tests {
    use super::*;
    use petrel_core::sync::{sync, State};

    /// Two folders meet through the stand-in Drive (`tests/fake_drive.py`); see its notes for how to run.
    #[test]
    #[ignore]
    fn drive_against_fake() {
        assert!(
            std::env::var("PETREL_DRIVE_URL").is_ok(),
            "start tests/fake_drive.py and set PETREL_DRIVE_URL"
        );
        let tmp = |n: &str| {
            let d = std::env::temp_dir().join(format!("petrel-drive-{n}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            d
        };
        let (a, b) = (tmp("a"), tmp("b"));
        std::fs::create_dir_all(a.join("Travel/.history/Rome")).unwrap();
        std::fs::write(a.join("Travel/Rome.md"), "pasta\n").unwrap();
        std::fs::write(a.join("Travel/.history/Rome/1-edit.md"), "pas\n").unwrap();
        std::fs::write(a.join("inbox.md"), "milk\n").unwrap();
        let root = Drive::find_or_make_root(|| Ok("t".into())).unwrap();
        assert_eq!(Drive::find_or_make_root(|| Ok("t".into())).unwrap(), root, "found again, not made twice");
        let (mut sa, mut sb) = (State::default(), State::default());
        let mut da = Drive::new(|| Ok("t".into()), root.clone(), None);
        let r = sync(&a, &mut da, &mut sa, "s").unwrap();
        assert_eq!(r.uploaded, 3, "{r:?}");
        sa.cursor = da.cursor.clone();
        let mut db = Drive::new(|| Ok("t".into()), root.clone(), None);
        let r = sync(&b, &mut db, &mut sb, "s").unwrap();
        assert_eq!(r.downloaded, 3, "{r:?}");
        assert_eq!(std::fs::read_to_string(b.join("Travel/Rome.md")).unwrap(), "pasta\n");
        assert!(b.join("Travel/.history/Rome/1-edit.md").exists());
        // An edit and a delete on B reach A.
        std::fs::write(b.join("Travel/Rome.md"), "pasta, gelato\n").unwrap();
        std::fs::remove_file(b.join("inbox.md")).unwrap();
        let r = sync(&b, &mut db, &mut sb, "s").unwrap();
        assert_eq!((r.uploaded, r.trashed_there), (1, 1), "{r:?}");
        let mut da = Drive::new(|| Ok("t".into()), root.clone(), sa.cursor.clone());
        let r = sync(&a, &mut da, &mut sa, "s").unwrap();
        assert_eq!((r.downloaded, r.trashed_here), (1, 1), "{r:?}");
        assert_eq!(std::fs::read_to_string(a.join("Travel/Rome.md")).unwrap(), "pasta, gelato\n");
        // Quiet now: the change list says nothing new... after A's own look.
        let r = sync(&a, &mut da, &mut sa, "s").unwrap();
        assert_eq!(r, Default::default());
        // A new file in a folder Drive has, on a sync that does not list (nothing new there): the folder is
        // found, not made again.
        std::fs::write(a.join("Travel/Split.md"), "sea\n").unwrap();
        let mut da = Drive::new(|| Ok("t".into()), root.clone(), sa.cursor.clone());
        let r = sync(&a, &mut da, &mut sa, "s").unwrap();
        assert_eq!(r.uploaded, 1, "{r:?}");
        assert!(da.list_once().unwrap().1.is_empty(), "Travel made twice");
        // Folders an earlier Petrel made twice come back together, with what was in them.
        let twin = |d: &mut Drive, name: &str, parent: &str| {
            d.send_json(
                "POST",
                &format!("{}/files/twin", api()),
                &json!({ "name": name, "parents": [parent] }),
            )
            .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let extra = twin(&mut da, "Travel", &root);
        twin(&mut da, "Inner", &extra);
        assert_eq!(da.list_once().unwrap().1.len(), 1);
        let files = da.list().unwrap();
        assert!(da.list_once().unwrap().1.is_empty());
        assert!(da.folders.contains_key("Travel/Inner"), "{:?}", da.folders);
        assert!(files.iter().any(|f| f.path == "Travel/Split.md"));
        // A note moved to another collection is moved on Drive, not copied.
        std::fs::create_dir_all(a.join("Trips")).unwrap();
        std::fs::rename(a.join("Travel/Split.md"), a.join("Trips/Split.md")).unwrap();
        let r = sync(&a, &mut da, &mut sa, "s").unwrap();
        assert_eq!((r.moved, r.uploaded, r.trashed_there), (1, 0, 0), "{r:?}");
        assert!(da.list().unwrap().iter().any(|f| f.path == "Trips/Split.md"));
        assert_eq!(Drive::new(|| Ok("t".into()), String::new(), None).account().unwrap(), "you@example.com");
    }
}
