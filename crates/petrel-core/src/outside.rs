//! Petrel from outside: what the `petrel` command (`find`, `read`, `add`, `copy`) and the MCP server for Claude
//! Desktop and Claude Code (`petrel mcp`) can do with the notes. Both run as their own process, open the same
//! database, and work on the files the way the app does, so the running app sees the change through its folder
//! watcher. Petrel itself never calls out: these only answer when asked.
//!
//! The MCP server is held to a scope the owner sets in Settings › Claude: which collections it sees (all, or a
//! list) and whether it may add. The command line is the owner at a terminal and sees everything.

use anyhow::{anyhow, bail, Result};
use serde::Serialize;

use crate::notes::{Note, Resolved, INBOX_DIR, JOURNAL_DIR};
use crate::store::Store;

/// The collections the MCP server sees, as a JSON list of top folder names; missing or empty means all.
pub const SCOPE_SETTING: &str = "ui.outside.collections";
/// `yes` lets the MCP server add to notes.
pub const WRITE_SETTING: &str = "ui.outside.write";

#[derive(Clone, Debug, Default)]
pub struct Scope {
    /// Top folders seen; `None` is every one.
    pub tops: Option<Vec<String>>,
    pub write: bool,
}

impl Scope {
    /// Everything, adding allowed: the owner at the command line.
    pub fn all() -> Scope {
        Scope { tops: None, write: true }
    }

    /// What Settings › Claude allows the MCP server.
    pub fn for_mcp(store: &Store) -> Result<Scope> {
        let tops = store
            .setting(SCOPE_SETTING)?
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .filter(|v| !v.is_empty());
        let write = store.setting(WRITE_SETTING)?.as_deref() == Some("yes");
        Ok(Scope { tops, write })
    }

    /// Whether a note in `folder` is seen. Dot folders (the trash, versions, scratch pages) never are.
    pub fn sees(&self, folder: &str) -> bool {
        let top = folder.split('/').next().unwrap_or("");
        if top.starts_with('.') {
            return false;
        }
        match &self.tops {
            None => true,
            Some(list) => list.iter().any(|t| t.eq_ignore_ascii_case(top)),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Hit {
    pub title: String,
    pub path: String,
    pub collection: String,
    /// A line of the note, for a glance.
    pub line: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Collection {
    pub name: String,
    pub notes: i64,
}

/// Notes whose words match, best first; titles that match come too when the words find little.
pub fn find(store: &Store, scope: &Scope, text: &str, limit: usize) -> Result<Vec<Hit>> {
    let limit = limit.clamp(1, 50);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let words = store.search_notes(text, limit * 3)?;
    let titles = store.find_notes(text, limit * 2)?;
    for n in words.into_iter().chain(titles) {
        if out.len() >= limit || !scope.sees(&n.folder) || !seen.insert(n.id) {
            continue;
        }
        out.push(Hit {
            title: n.title,
            path: n.path,
            collection: top_name(&n.folder),
            line: n.preview.lines().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(160).collect(),
        });
    }
    Ok(out)
}

/// A note by its title (as a `[[link]]` names it), its path, or `today` / a day `2026-11-19` for a day's page.
pub fn read(store: &Store, scope: &Scope, name: &str) -> Result<Note> {
    let name = name.trim();
    let note = if let Some(day) = day_of(name) {
        store.day_note(&day)?.ok_or_else(|| anyhow!("no page for {day} yet"))?
    } else {
        match store.resolve_link(name.trim_end_matches(".md"))? {
            Resolved::Note { id } => store.peek_note(id)?,
            _ => {
                // A loose name: the best title match.
                let best = store.find_notes(name, 1)?.into_iter().next().ok_or_else(|| anyhow!("no note called {name}"))?;
                store.peek_note(best.id)?
            }
        }
    };
    if !scope.sees(&note.folder) {
        bail!("{name} is in a collection Petrel does not share here");
    }
    Ok(note)
}

/// Top collections and how many notes each has.
pub fn collections(store: &Store, scope: &Scope) -> Result<Vec<Collection>> {
    let mut out: Vec<Collection> = Vec::new();
    for f in store.note_folders()? {
        let top = top_name(&f.path);
        if f.path.is_empty() || !scope.sees(&f.path) {
            continue;
        }
        match out.iter_mut().find(|c| c.name == top) {
            Some(c) => c.notes += f.count,
            None => out.push(Collection { name: top, notes: f.count }),
        }
    }
    Ok(out)
}

/// Adds `text` to a place: `today` (or a day) under the time, `inbox` as a capture, a collection as a new note
/// named by its first line, or the end of a note named by its title. Says where it went.
pub fn add(store: &mut Store, scope: &Scope, place: &str, text: &str) -> Result<String> {
    if !scope.write {
        bail!("adding is off: turn it on in Petrel, Settings › Claude");
    }
    let text = text.trim();
    if text.is_empty() {
        bail!("nothing to add: the text is empty");
    }
    let place = place.trim().trim_start_matches('@');
    if place.is_empty() || place.eq_ignore_ascii_case(INBOX_DIR) {
        if !scope.sees(INBOX_DIR) {
            bail!("the inbox is not shared here");
        }
        let n = store.capture_note(text)?;
        return Ok(format!("added to the inbox as {}", n.path));
    }
    if let Some(day) = day_of(place) {
        if !scope.sees(JOURNAL_DIR) {
            bail!("the day pages are not shared here");
        }
        let n = store.capture_note(text)?;
        let ch = store.file_into_day(n.id, &day)?;
        return Ok(format!("added to {}", ch.note.path));
    }
    // A collection by name (any case).
    if let Some(c) = collections(store, &Scope { write: true, ..scope.clone() })?.into_iter().find(|c| c.name.eq_ignore_ascii_case(place)) {
        let title = crate::title::title(text);
        let n = store.create_note(&c.name, &title, &format!("{text}\n"), &[])?;
        return Ok(format!("added as {}", n.path));
    }
    // A note by title: its end.
    let into = read(store, scope, place).map_err(|_| anyhow!("no collection or note called {place}"))?;
    let n = store.capture_note(text)?;
    let ch = store.merge_note(n.id, into.id)?;
    Ok(format!("added to the end of {}", ch.note.path))
}

/// A card's text with its `{{blanks}}` filled from `values` (a blank not given keeps its default, or stays as
/// `{{name}}` so nothing silently vanishes). The rules are src/blanks.ts's.
pub fn card(store: &Store, scope: &Scope, title: &str, values: &[(String, String)]) -> Result<(Note, String)> {
    let n = read(store, scope, title)?;
    let body = if top_name(&n.folder).eq_ignore_ascii_case("snippets") { drop_trigger(&n.body) } else { n.body.clone() };
    let text = fill(body.trim_end_matches('\n'), values);
    Ok((n, text))
}

/// `{{name}}`, `{{name|default}}`, `{{name: a / b}}` (the first choice), `\{{` for literal braces.
pub fn fill(text: &str, values: &[(String, String)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("{{") {
        let escaped = rest[..at].ends_with('\\');
        let Some(end) = rest[at + 2..].find("}}").map(|e| at + 2 + e) else { break };
        let inner = &rest[at + 2..end];
        if escaped {
            out.push_str(&rest[..at - 1]);
            out.push_str(&rest[at..end + 2]);
        } else if inner.contains('{') || inner.contains('}') || inner.contains('\n') {
            out.push_str(&rest[..at + 2]);
            rest = &rest[at + 2..];
            continue;
        } else {
            out.push_str(&rest[..at]);
            let (head, default) = match inner.split_once('|') {
                Some((h, d)) => (h.trim(), Some(d)),
                None => (inner.trim(), None),
            };
            let (name, first) = match head.split_once(':') {
                Some((n, c)) if c.split('/').filter(|x| !x.trim().is_empty()).count() >= 2 => {
                    (n.trim(), c.split('/').map(str::trim).find(|x| !x.is_empty()))
                }
                _ => (head, None),
            };
            let given = values.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str());
            match given.or(default).or(first).filter(|v| !v.is_empty()) {
                Some(v) => out.push_str(v),
                None => {
                    out.push_str("{{");
                    out.push_str(name);
                    out.push_str("}}");
                }
            }
        }
        rest = &rest[end + 2..];
    }
    out.push_str(rest);
    out
}

/// The names of blanks still unfilled in a text `fill` gave back.
pub fn blanks_left(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("{{") {
        let Some(end) = rest[at..].find("}}") else { break };
        let name = rest[at + 2..at + end].trim().to_string();
        if !name.is_empty() && !out.contains(&name) {
            out.push(name);
        }
        rest = &rest[at + end + 2..];
    }
    out
}

/// A snippet's `;sig` line is for typing in Petrel, not part of what is copied (src/collection/snippetText.ts).
fn drop_trigger(body: &str) -> String {
    let mut done = false;
    body.lines()
        .filter(|l| {
            let t = l.trim();
            let is = !done
                && t.len() > 1
                && t.len() <= 25
                && t.starts_with(';')
                && t[1..].chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-');
            done |= is;
            !is
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn top_name(folder: &str) -> String {
    let top = folder.split('/').next().unwrap_or("");
    if top.is_empty() { "Notes".into() } else { top.into() }
}

/// `today`, `yesterday`, `tomorrow` or `YYYY-MM-DD`.
fn day_of(word: &str) -> Option<String> {
    let today = chrono::Local::now().date_naive();
    let d = match word.to_lowercase().as_str() {
        "today" => today,
        "yesterday" => today.pred_opt()?,
        "tomorrow" => today.succ_opt()?,
        w => chrono::NaiveDate::parse_from_str(w, "%Y-%m-%d").ok()?,
    };
    Some(d.format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::tests_support::{store_in, tmp};

    fn kv(k: &str, v: &str) -> (String, String) {
        (k.into(), v.into())
    }

    #[test]
    fn blanks_fill_as_in_the_app() {
        assert_eq!(fill("Hi {{name}}, {{when|Monday}}.", &[kv("Name", "Amra")]), "Hi Amra, Monday.");
        assert_eq!(fill("{{tone: formal / casual}} {{x}}", &[]), "formal {{x}}");
        assert_eq!(fill("\\{{kept}} {{a}}", &[kv("a", "1")]), "{{kept}} 1");
        assert_eq!(fill("no blanks", &[]), "no blanks");
    }

    #[test]
    fn the_scope_hides_collections_and_dot_folders() {
        let s = Scope { tops: Some(vec!["Travel".into()]), write: false };
        assert!(s.sees("Travel/Rome"));
        assert!(!s.sees("Work"));
        assert!(!Scope::all().sees(".trash"));
    }

    #[test]
    fn find_read_add_and_copy() {
        let dir = tmp();
        let mut s = store_in(&dir);
        s.create_note("Travel", "Rome", "The Pantheon at nine.\n", &[]).unwrap();
        s.create_note("Work", "Release plan", "Ship on the 20th.\n", &[]).unwrap();
        s.create_note("Snippets", "Email sign-off", ";sig\nThanks, {{name|all}}\n", &[]).unwrap();
        let all = Scope::all();
        assert_eq!(find(&s, &all, "pantheon", 5).unwrap()[0].title, "Rome");
        let travel = Scope { tops: Some(vec!["travel".into()]), write: false };
        assert!(find(&s, &travel, "ship", 5).unwrap().is_empty());
        assert!(read(&s, &travel, "Release plan").is_err());
        assert!(add(&mut s, &travel, "today", "x").is_err());

        let at = add(&mut s, &all, "@today", "Called the bank").unwrap();
        assert!(at.contains("journal/"), "{at}");
        let at = add(&mut s, &all, "travel", "Mostar in May\nBridge at dusk").unwrap();
        assert!(at.contains("Travel/Mostar in May"), "{at}");
        add(&mut s, &all, "Rome", "Book the Vatican").unwrap();
        assert!(read(&s, &all, "Rome").unwrap().body.contains("Book the Vatican"));
        assert!(add(&mut s, &all, "Nowhere at all", "x").is_err());

        let (_, text) = card(&s, &all, "Email sign-off", &[kv("name", "Lejla")]).unwrap();
        assert_eq!(text, "Thanks, Lejla");
        assert!(collections(&s, &all).unwrap().iter().any(|c| c.name == "Travel" && c.notes == 2));
    }
}
