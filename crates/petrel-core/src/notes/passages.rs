//! What of a long note goes with a question. A question reads a few notes, and a long note does not fit whole;
//! its top alone misses an answer further down. So the note is cut at its headings (and long sections at their
//! paragraphs), each piece is scored by the question's words, and the best pieces go with their neighbours, in
//! the note's order, with `[…]` where something was left out. The start always goes: it says what the note is.

use super::fold::fold;
use super::STOP;

/// About how long one piece is, at most, before a section is cut at its paragraphs.
const PIECE: usize = 1_500;

/// The words of `text` worth matching: folded, longer than two letters, not a common word.
pub fn key_words(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in fold(text).split(|c: char| !c.is_alphanumeric()) {
        if w.chars().count() > 2 && !STOP.contains(&w) && !out.iter().any(|x| x == w) {
            out.push(w.to_string());
        }
    }
    out
}

/// `body` cut to about `budget` bytes, keeping what `question` is about.
pub fn passages(body: &str, question: &str, budget: usize) -> String {
    if body.len() <= budget {
        return body.to_string();
    }
    let pieces = cut(body);
    let words = key_words(question);
    let folded: Vec<String> = pieces.iter().map(|p| fold(p)).collect();
    // A word in few pieces says more than one in all of them.
    let weight: Vec<f64> = words
        .iter()
        .map(|w| 1.0 / (1.0 + folded.iter().filter(|p| p.contains(w.as_str())).count() as f64))
        .collect();
    let score = |i: usize| -> f64 {
        words.iter().zip(&weight).map(|(w, k)| folded[i].matches(w.as_str()).count().min(5) as f64 * k).sum()
    };
    let mut order: Vec<usize> = (1..pieces.len()).filter(|&i| score(i) > 0.0).collect();
    order.sort_by(|&a, &b| score(b).total_cmp(&score(a)).then(a.cmp(&b)));
    let mut keep = vec![false; pieces.len()];
    let mut used = 0usize;
    let mut take = |i: usize, keep: &mut Vec<bool>| {
        if !keep[i] && used + pieces[i].len() <= budget {
            keep[i] = true;
            used += pieces[i].len();
        }
    };
    take(0, &mut keep);
    for &i in &order {
        take(i, &mut keep);
        if i + 1 < pieces.len() {
            take(i + 1, &mut keep);
        }
        take(i - 1, &mut keep);
    }
    // Nothing matched (or room is left): the note goes on from the top, as before.
    for i in 1..pieces.len() {
        take(i, &mut keep);
        if !keep[i] {
            break;
        }
    }
    let mut out = String::new();
    let mut gap = false;
    for (i, p) in pieces.iter().enumerate() {
        if keep[i] {
            if gap && !out.is_empty() {
                out += "\n[…]\n\n";
            }
            out += p;
            gap = false;
        } else {
            gap = true;
        }
    }
    if gap {
        out += "\n[…]\n";
    }
    out
}

/// The note in pieces: a new piece at each heading, and a long section at its blank lines. A piece longer than
/// `PIECE` with no blank line is cut at a line, or at a character boundary as a last resort.
fn cut(body: &str) -> Vec<String> {
    let mut sections: Vec<String> = Vec::new();
    let mut fence = false;
    for line in body.split_inclusive('\n') {
        if line.trim_start().starts_with("```") {
            fence = !fence;
        }
        if !fence && line.starts_with('#') && sections.last().is_some_and(|s| !s.trim().is_empty()) {
            sections.push(String::new());
        }
        match sections.last_mut() {
            Some(s) => s.push_str(line),
            None => sections.push(line.to_string()),
        }
    }
    let mut out = Vec::new();
    for s in sections {
        if s.len() <= PIECE {
            out.push(s);
            continue;
        }
        let mut piece = String::new();
        for para in s.split_inclusive("\n\n") {
            if !piece.is_empty() && piece.len() + para.len() > PIECE {
                out.push(std::mem::take(&mut piece));
            }
            piece.push_str(para);
            while piece.len() > PIECE * 2 {
                let mut at = piece[..PIECE].rfind('\n').map(|i| i + 1).unwrap_or(PIECE);
                while !piece.is_char_boundary(at) {
                    at -= 1;
                }
                let rest = piece.split_off(at);
                out.push(std::mem::replace(&mut piece, rest));
            }
        }
        if !piece.is_empty() {
            out.push(piece);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long_note() -> String {
        let filler = "Nothing much happened here, only words that fill the page. ".repeat(30);
        format!(
            "# Trip\n\nPlans for the trip.\n\n## Monday\n\n{filler}\n\n## Tuesday\n\n{filler}\n\n## Packing\n\n\
             Bring the passport and the blue charger.\n\n## Wednesday\n\n{filler}\n"
        )
    }

    #[test]
    fn the_answer_further_down_goes() {
        let body = long_note();
        let out = passages(&body, "Where is my passport?", 2_200);
        assert!(out.len() <= 2_400, "{}", out.len());
        assert!(out.starts_with("# Trip"));
        assert!(out.contains("passport and the blue charger"));
        assert!(out.contains("[…]"));
    }

    #[test]
    fn a_short_note_goes_whole() {
        assert_eq!(passages("# A\n\nshort", "anything", 1_000), "# A\n\nshort");
    }

    #[test]
    fn no_match_reads_from_the_top() {
        let body = long_note();
        let out = passages(&body, "zebra", 2_200);
        assert!(out.contains("## Monday"));
        assert!(!out.contains("## Wednesday"));
    }

    #[test]
    fn words_fold() {
        assert_eq!(key_words("Šta je ĆEVAPI and the"), vec!["sta", "cevapi"]);
    }
}
