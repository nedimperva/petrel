//! Pictures pasted into a note live next to it, in `<folder>/attachments/`, and the note links them as
//! `![](attachments/<name>)`. Any Markdown app shows them, and moving a note to another folder takes the pictures it
//! links along (`Store::move_note`, `Store::merge_note`). These are the pure parts: names and links.

use std::collections::HashMap;

/// The folder next to a note that holds its pictures.
pub const DIR: &str = "attachments";

/// What may be pasted. Anything else is refused rather than written into the notes folder.
pub const KINDS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

/// The largest picture Petrel writes. The UI makes big photos smaller before they get here.
pub const MAX_BYTES: usize = 20 * 1024 * 1024;

/// A file name that is safe on Linux and Windows and needs no escaping in a Markdown link: letters, digits, `.`,
/// `_` and `-`, at most 80 characters, with a known picture extension. None when the extension is not one.
pub fn clean_name(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    if !KINDS.contains(&ext.as_str()) {
        return None;
    }
    let mut s = String::new();
    for c in stem.chars() {
        let c = if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' };
        if !(c == '-' && s.ends_with('-')) {
            s.push(c);
        }
    }
    let s: String = s.trim_matches('-').chars().take(70).collect();
    let s = if s.is_empty() { "picture".to_string() } else { s };
    Some(format!("{s}.{ext}"))
}

/// True for a name `clean_name` could have made: no path in it, nothing to climb out of the folder with.
pub fn is_clean(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        && name.rsplit_once('.').is_some_and(|(_, e)| KINDS.contains(&e.to_ascii_lowercase().as_str()))
}

/// The picture names a text links to as `](attachments/<name>)`, each once, in order.
pub fn linked(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, name) in links(body) {
        if !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// The text with each `attachments/<old>` link that `map` names pointing at the new name instead.
pub fn rename_links(body: &str, map: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(body.len());
    let mut last = 0;
    for (at, name) in links(body) {
        if let Some(new) = map.get(name) {
            out.push_str(&body[last..at]);
            out.push_str(new);
            last = at + name.len();
        }
    }
    out.push_str(&body[last..]);
    out
}

/// Each link's name and where the name starts in `body`.
fn links(body: &str) -> Vec<(usize, &str)> {
    let needle = "](attachments/";
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = body[from..].find(needle) {
        let start = from + i + needle.len();
        let rest = &body[start..];
        let end = rest.find(|c: char| c == ')' || c.is_whitespace()).unwrap_or(rest.len());
        let name = &rest[..end];
        if rest[end..].starts_with(')') && is_clean(name) {
            out.push((start, name));
        }
        from = start;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe() {
        assert_eq!(
            clean_name("Screenshot 2026-11-11 at 21.14.PNG").as_deref(),
            Some("Screenshot-2026-11-11-at-21-14.png")
        );
        assert_eq!(clean_name("../../etc/passwd.png").as_deref(), Some("etc-passwd.png"));
        assert_eq!(clean_name("šalica.jpg").as_deref(), Some("alica.jpg"));
        assert_eq!(clean_name("....webp").as_deref(), Some("picture.webp"));
        assert_eq!(clean_name("notes.md"), None);
        assert_eq!(clean_name("noext"), None);
        assert!(
            is_clean("a-b_c.1.png") && !is_clean("../a.png") && !is_clean("a/b.png") && !is_clean(".a.png")
        );
    }

    #[test]
    fn links_found_and_renamed() {
        let body = "Shelf: ![shelf](attachments/shelf.jpg)\n\n![](attachments/shelf.jpg) and \
                    ![x](attachments/bad name.png) and `![c](attachments/c.png)` [t](other/t.png)";
        assert_eq!(linked(body), vec!["shelf.jpg", "c.png"]);
        let map = HashMap::from([("shelf.jpg".to_string(), "shelf-2.jpg".to_string())]);
        let out = rename_links(body, &map);
        assert_eq!(out.matches("attachments/shelf-2.jpg").count(), 2);
        assert!(out.contains("attachments/c.png") && !out.contains("attachments/shelf.jpg"));
    }
}
