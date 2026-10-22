//! A draft has no title field: the first line is the title. These two functions are the only place that
//! rule lives, and they run on every save, so they must be cheap.

/// Longest title stored, in characters.
pub const TITLE_MAX: usize = 200;
/// Longest preview stored, in characters.
pub const PREVIEW_MAX: usize = 160;

/// The first non-empty line, trimmed, without Markdown heading marks, cut to `TITLE_MAX` characters.
pub fn title(content: &str) -> String {
    let Some(line) = content.lines().map(str::trim).find(|l| !l.is_empty()) else {
        return String::new();
    };
    let line = line.trim_start_matches('#').trim_start();
    truncate(line, TITLE_MAX)
}

/// The text after the title line with whitespace collapsed, cut to `PREVIEW_MAX` characters.
pub fn preview(content: &str) -> String {
    let mut lines = content.lines().map(str::trim).skip_while(|l| l.is_empty());
    lines.next(); // the title
    let mut out = String::new();
    for word in lines.flat_map(str::split_whitespace) {
        if out.chars().count() + word.chars().count() + 1 > PREVIEW_MAX {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => s[..i].trim_end().to_string(),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_is_first_non_empty_line() {
        assert_eq!(title(""), "");
        assert_eq!(title("\n\n  \n"), "");
        assert_eq!(title("Hello\nworld"), "Hello");
        assert_eq!(title("\n\n  Hello  \nworld"), "Hello");
        assert_eq!(title("Hello\r\nworld"), "Hello");
    }

    #[test]
    fn title_drops_heading_marks() {
        assert_eq!(title("# Hello"), "Hello");
        assert_eq!(title("### Hello ###"), "Hello ###");
        assert_eq!(title("#hashtag first"), "hashtag first");
    }

    #[test]
    fn title_is_cut_at_200_chars() {
        let long = "é".repeat(500);
        assert_eq!(title(&long).chars().count(), 200);
    }

    #[test]
    fn preview_skips_title_and_collapses_whitespace() {
        assert_eq!(preview("Title"), "");
        assert_eq!(preview("Title\n\nfirst   line\n  second\tline\n"), "first line second line");
        assert_eq!(preview("\n\nTitle\nbody"), "body");
    }

    #[test]
    fn preview_stops_at_160_chars_on_a_word_boundary() {
        let body = (0..100).map(|i| format!("word{i}")).collect::<Vec<_>>().join(" ");
        let p = preview(&format!("T\n{body}"));
        assert!(p.chars().count() <= PREVIEW_MAX);
        assert!(!p.ends_with(' '));
        assert!(body.starts_with(&p));
    }
}
