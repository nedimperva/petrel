//! `[[links]]` in draft and note text. The text is the only record: there is no links table. Backlinks are found by
//! a full-text search for the target's title and then parsing the matches here, so a link typed in another editor,
//! or into a draft from an action, is found the same way as one typed in Petrel.
//!
//! The forms (docs/design/notes.md): `[[Title]]` a note (or, when no note has that title, a draft),
//! `[[Folder/Title]]` a note in a folder, `[[d:Title]]` a draft, `[[u:UUID]]` a draft by id, plus `#Heading` and
//! `|label` on any of them. Links in code spans and fenced code are text, and `\[[` is a literal bracket.

/// What a link points at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// A note by title, optionally in a folder (`Projects/Petrel`). An unqualified title can also mean a draft.
    Note { folder: Option<String>, title: String },
    /// `[[d:Title]]`.
    Draft { title: String },
    /// `[[u:UUID]]`.
    Uuid(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    /// Byte range of the whole `[[…]]` in the text.
    pub start: usize,
    pub end: usize,
    pub target: Target,
    pub heading: Option<String>,
    pub label: Option<String>,
}

impl Link {
    /// The link written back out, `[[…]]` included.
    pub fn raw(&self) -> String {
        let mut s = String::from("[[");
        match &self.target {
            Target::Note { folder: Some(f), title } => {
                s.push_str(f);
                s.push('/');
                s.push_str(title);
            }
            Target::Note { folder: None, title } => s.push_str(title),
            Target::Draft { title } => {
                s.push_str("d:");
                s.push_str(title);
            }
            Target::Uuid(u) => {
                s.push_str("u:");
                s.push_str(u);
            }
        }
        if let Some(h) = &self.heading {
            s.push('#');
            s.push_str(h);
        }
        if let Some(l) = &self.label {
            s.push('|');
            s.push_str(l);
        }
        s.push_str("]]");
        s
    }
}

/// Longest text inside the brackets that counts as a link.
const INNER_MAX: usize = 300;

/// Parses what is between `[[` and `]]`. None for something that is not a link (empty, or only a prefix).
pub fn parse_inner(inner: &str) -> Option<(Target, Option<String>, Option<String>)> {
    let (rest, label) = match inner.split_once('|') {
        Some((a, b)) => (a, Some(b.trim().to_string()).filter(|l| !l.is_empty())),
        None => (inner, None),
    };
    let (rest, heading) = match rest.split_once('#') {
        Some((a, b)) => (a, Some(b.trim().to_string()).filter(|h| !h.is_empty())),
        None => (rest, None),
    };
    let rest = rest.trim();
    let target = if let Some(t) = rest.strip_prefix("d:") {
        Target::Draft { title: t.trim().to_string() }
    } else if let Some(u) = rest.strip_prefix("u:") {
        Target::Uuid(u.trim().to_string())
    } else if let Some((folder, title)) = rest.rsplit_once('/') {
        let folder = folder.trim().trim_matches('/').to_string();
        Target::Note { folder: Some(folder).filter(|f| !f.is_empty()), title: title.trim().to_string() }
    } else {
        Target::Note { folder: None, title: rest.to_string() }
    };
    let empty = match &target {
        Target::Note { title, .. } | Target::Draft { title } => title.is_empty(),
        Target::Uuid(u) => u.is_empty(),
    };
    if empty {
        return None;
    }
    Some((target, heading, label))
}

/// Every link in `text`, in order.
pub fn parse(text: &str) -> Vec<Link> {
    let mut out = Vec::new();
    let mut fence: Option<&str> = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let start = offset;
        offset += line.len();
        let trimmed = line.trim_start();
        if let Some(open) = fence {
            if trimmed.starts_with(open) {
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            fence = Some("```");
            continue;
        }
        if trimmed.starts_with("~~~") {
            fence = Some("~~~");
            continue;
        }
        if !line.contains("[[") {
            continue;
        }
        parse_line(line, start, &mut out);
    }
    out
}

fn parse_line(line: &str, base: usize, out: &mut Vec<Link>) {
    let b = line.as_bytes();
    let mut i = 0;
    let mut in_code = false;
    while i < b.len() {
        match b[i] {
            b'`' => {
                in_code = !in_code;
                i += 1;
            }
            b'\\' => i += 2,
            b'[' if !in_code && b.get(i + 1) == Some(&b'[') => {
                let from = i + 2;
                let Some(close) = line[from..].find("]]") else { return };
                let inner = &line[from..from + close];
                if inner.len() <= INNER_MAX && !inner.contains('[') && !inner.contains('\n') {
                    if let Some((target, heading, label)) = parse_inner(inner) {
                        out.push(Link {
                            start: base + i,
                            end: base + from + close + 2,
                            target,
                            heading,
                            label,
                        });
                        i = from + close + 2;
                        continue;
                    }
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
}

/// Replaces each link for which `f` returns new text. Returns the new text and how many links changed.
pub fn rewrite(text: &str, mut f: impl FnMut(&Link) -> Option<String>) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    let mut n = 0;
    for link in parse(text) {
        if let Some(new) = f(&link) {
            out.push_str(&text[at..link.start]);
            out.push_str(&new);
            at = link.end;
            n += 1;
        }
    }
    out.push_str(&text[at..]);
    (out, n)
}

/// Titles compare without case and outer spaces.
pub fn same(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets(t: &str) -> Vec<Target> {
        parse(t).into_iter().map(|l| l.target).collect()
    }

    #[test]
    fn forms() {
        let t = "a [[Roadmap]] b [[Projects/Petrel/Plan#Next|the plan]] [[d:Wifi fix]] [[u:abc-1]]";
        let links = parse(t);
        assert_eq!(links.len(), 4);
        assert_eq!(links[0].target, Target::Note { folder: None, title: "Roadmap".into() });
        assert_eq!(&t[links[0].start..links[0].end], "[[Roadmap]]");
        assert_eq!(
            links[1].target,
            Target::Note { folder: Some("Projects/Petrel".into()), title: "Plan".into() }
        );
        assert_eq!(links[1].heading.as_deref(), Some("Next"));
        assert_eq!(links[1].label.as_deref(), Some("the plan"));
        assert_eq!(links[1].raw(), "[[Projects/Petrel/Plan#Next|the plan]]");
        assert_eq!(links[2].target, Target::Draft { title: "Wifi fix".into() });
        assert_eq!(links[3].target, Target::Uuid("abc-1".into()));
    }

    #[test]
    fn code_escapes_and_junk_are_not_links() {
        assert!(targets("`[[code]]` \\[[escaped]] [[]] [[ ]] [[d:]] [[open").is_empty());
        assert!(targets("```\n[[fenced]]\n```\n").is_empty());
        assert_eq!(targets("```\nx\n```\n[[after]]").len(), 1);
        assert_eq!(targets("[[a]][[b]]").len(), 2);
    }

    #[test]
    fn rewrite_keeps_heading_and_label() {
        let (t, n) = rewrite("see [[Old#H|x]] and [[old]] and [[Other]]", |l| match &l.target {
            Target::Note { title, folder } if same(title, "Old") => Some(
                Link { target: Target::Note { folder: folder.clone(), title: "New".into() }, ..l.clone() }
                    .raw(),
            ),
            _ => None,
        });
        assert_eq!(n, 2);
        assert_eq!(t, "see [[New#H|x]] and [[New]] and [[Other]]");
    }

    #[test]
    fn offsets_survive_multibyte_text() {
        let t = "čšž\n„quote“ [[Ünïcode]] end";
        let l = &parse(t)[0];
        assert_eq!(&t[l.start..l.end], "[[Ünïcode]]");
    }
}
