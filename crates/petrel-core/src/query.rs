//! What the user types into the search box, turned into something the store can run. Filters (`tag:x`,
//! `-tag:x`, `is:flagged`, `in:archive`) are parsed here in Rust and never reach FTS5; the words left over are
//! quoted token by token, so no input can make FTS5 fail to parse.

use crate::store::Folder;

/// A search box query split into filters and the free text that goes to FTS5.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedQuery {
    /// Free words and `"phrases"`, as typed; `fts_query` makes them safe.
    pub text: String,
    pub tags_all: Vec<String>,
    pub tags_none: Vec<String>,
    pub flagged: bool,
    /// `in:inbox` and so on; `None` means Inbox and Archive.
    pub folder: Option<Folder>,
}

impl ParsedQuery {
    /// True when there is nothing beyond free text, so search can take its fast newest-first path.
    pub fn text_only(&self) -> bool {
        self.tags_all.is_empty() && self.tags_none.is_empty() && !self.flagged && self.folder.is_none()
    }

    pub fn is_empty(&self) -> bool {
        self.text_only() && fts_query(&self.text).is_empty()
    }
}

/// Splits filters out of a search box query. Filter words are case-insensitive; an unknown `is:` or `in:` value
/// stays in the text, so a typo searches for the word instead of silently matching nothing. Words inside a
/// quoted phrase are never filters.
pub fn parse_query(input: &str) -> ParsedQuery {
    let mut q = ParsedQuery::default();
    let mut text: Vec<&str> = Vec::new();
    let mut in_phrase = false;
    for tok in input.split_whitespace() {
        if in_phrase {
            text.push(tok);
            in_phrase = !tok.ends_with('"');
            continue;
        }
        if tok.starts_with('"') {
            text.push(tok);
            // `"word"` is a whole phrase; `"two` opens one.
            in_phrase = tok.len() == 1 || !tok.ends_with('"');
            continue;
        }
        let lower = tok.to_lowercase();
        if let Some(name) = lower.strip_prefix("-tag:") {
            if !name.is_empty() {
                q.tags_none.push(name.to_string());
            }
        } else if let Some(name) = lower.strip_prefix("tag:") {
            if !name.is_empty() {
                q.tags_all.push(name.to_string());
            }
        } else if lower == "is:flagged" {
            q.flagged = true;
        } else if let Some(folder) = lower.strip_prefix("in:").and_then(folder_named) {
            q.folder = Some(folder);
        } else {
            text.push(tok);
        }
    }
    q.text = text.join(" ");
    q
}

fn folder_named(name: &str) -> Option<Folder> {
    match name {
        "inbox" => Some(Folder::Inbox),
        "archive" => Some(Folder::Archive),
        "trash" => Some(Folder::Trash),
        _ => None,
    }
}

/// Trims the punctuation around a word; FTS5's tokenizer would drop it anyway.
fn clean(tok: &str) -> &str {
    tok.trim_matches(|c: char| !c.is_alphanumeric())
}

/// Turns free text into an FTS5 query that cannot fail to parse: every word is a quoted string (embedded quotes
/// doubled), a `"quoted phrase"` stays a phrase, the last word is a prefix match so results appear while
/// typing, and everything is ANDed. An unterminated phrase runs to the end of the input.
pub fn fts_query(input: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut phrase: Option<Vec<&str>> = None;
    for tok in input.split_whitespace() {
        match phrase.as_mut() {
            Some(words) => {
                words.push(clean(tok));
                if tok.ends_with('"') {
                    let words = phrase.take().unwrap_or_default();
                    push_phrase(&mut parts, &words);
                }
            }
            None if tok.starts_with('"') => {
                if tok.len() > 1 && tok.ends_with('"') {
                    push_phrase(&mut parts, &[clean(tok)]);
                } else {
                    phrase = Some(vec![clean(tok)]);
                }
            }
            None => push_phrase(&mut parts, &[clean(tok)]),
        }
    }
    let open = phrase.is_some();
    if let Some(words) = phrase {
        push_phrase(&mut parts, &words);
    }
    // Prefix-match the last bare word, or the last word of a phrase still being typed.
    let last_is_bare = !open && !input.trim_end().ends_with('"');
    if let Some(last) = parts.last_mut() {
        if last_is_bare || open {
            last.push('*');
        }
    }
    parts.join(" ")
}

fn push_phrase(parts: &mut Vec<String>, words: &[&str]) {
    let words: Vec<&str> = words.iter().copied().filter(|w| !w.is_empty()).collect();
    if !words.is_empty() {
        parts.push(format!("\"{}\"", words.join(" ").replace('"', "\"\"")));
    }
}

/// The cleaned words of free text, lower-cased, for highlighting.
pub fn search_terms(input: &str) -> Vec<String> {
    input.split_whitespace().map(|t| clean(t).to_lowercase()).filter(|t| !t.is_empty()).collect()
}

/// About `SNIPPET_WORDS` words around the first term found, with every term occurrence in that window wrapped
/// in `\u{1}`…`\u{2}`. Falls back to the start of the body when no term is found (a diacritic-folded match).
pub fn snippet(content: &str, terms: &[String]) -> String {
    const SNIPPET_WORDS: usize = 14;
    let words: Vec<&str> = content.split_whitespace().collect();
    let matches = |w: &str| {
        let lw = w.to_lowercase();
        terms.iter().any(|t| lw.contains(t.as_str()))
    };
    let first = words.iter().position(|w| matches(w));
    let start = first.map(|i| i.saturating_sub(SNIPPET_WORDS / 3)).unwrap_or(0);
    let end = (start + SNIPPET_WORDS).min(words.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    for (i, w) in words[start..end].iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        if matches(w) {
            out.push('\u{1}');
            out.push_str(w);
            out.push('\u{2}');
        } else {
            out.push_str(w);
        }
    }
    if end < words.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts_query_quotes_everything() {
        assert_eq!(fts_query("hello world"), "\"hello\" \"world\"*");
        assert_eq!(fts_query("a\"b"), "\"a\"\"b\"*");
        assert_eq!(fts_query("(x) -y"), "\"x\" \"y\"*");
        assert_eq!(fts_query("***"), "");
        assert_eq!(fts_query("milk OR eggs"), "\"milk\" \"OR\" \"eggs\"*", "OR is a word, not an operator");
        assert_eq!(fts_query("NEAR(a b)"), "\"NEAR(a\" \"b\"*");
    }

    #[test]
    fn fts_query_keeps_phrases() {
        assert_eq!(fts_query("\"exact phrase\" more"), "\"exact phrase\" \"more\"*");
        assert_eq!(
            fts_query("word \"exact phrase\""),
            "\"word\" \"exact phrase\"",
            "a closed phrase is exact"
        );
        assert_eq!(fts_query("\"still typ"), "\"still typ\"*", "an open phrase prefix-matches its last word");
        assert_eq!(fts_query("\"one\""), "\"one\"");
        assert_eq!(fts_query("\""), "");
        assert_eq!(fts_query("\" \" x"), "\"x\"*");
    }

    #[test]
    fn filters_are_parsed_out() {
        let q = parse_query("Tag:Work -tag:done milk is:flagged in:archive");
        assert_eq!(q.tags_all, vec!["work"]);
        assert_eq!(q.tags_none, vec!["done"]);
        assert!(q.flagged);
        assert_eq!(q.folder, Some(Folder::Archive));
        assert_eq!(q.text, "milk");
        assert!(!q.text_only());
    }

    #[test]
    fn unknown_filters_and_phrases_stay_text() {
        let q = parse_query("is:urgent in:somewhere tag: \"tag:x is:flagged\"");
        assert_eq!(q.text, "is:urgent in:somewhere \"tag:x is:flagged\"");
        assert!(q.tags_all.is_empty() && !q.flagged);
        assert!(q.text_only());
        assert!(parse_query("  ").is_empty());
        assert!(!parse_query("tag:x").is_empty());
    }
}
