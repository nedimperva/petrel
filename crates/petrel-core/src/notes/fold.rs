//! One rule for matching what is typed against titles, the same as `src/fold.ts`: case and accents do not
//! matter, so "sta" finds "Šta" and "cevapi" finds "Ćevapi", and đ is d (with "dj", as Bosnian is typed on a
//! keyboard without it). SQLite's `lower()` knows only a to z, so titles are folded here, not in SQL.

/// Lower case, accents off, đ and dj as d.
pub fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars().flat_map(char::to_lowercase) {
        out.push_str(match c {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'ā' | 'ă' | 'ą' => "a",
            'č' | 'ć' | 'ç' => "c",
            'đ' | 'ď' => "d",
            'é' | 'è' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => "e",
            'í' | 'ì' | 'î' | 'ï' | 'ī' => "i",
            'ł' | 'ľ' => "l",
            'ñ' | 'ń' | 'ň' => "n",
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' | 'ō' | 'ő' => "o",
            'ř' => "r",
            'š' | 'ś' | 'ş' => "s",
            'ť' | 'ţ' => "t",
            'ú' | 'ù' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => "u",
            'ý' | 'ÿ' => "y",
            'ž' | 'ź' | 'ż' => "z",
            'ß' => "ss",
            _ => {
                out.push(c);
                continue;
            }
        });
    }
    out.replace("dj", "d")
}

fn is_sep(c: char) -> bool {
    c.is_whitespace() || matches!(c, '-' | '_' | '/' | '.' | ':' | '#')
}

/// How well `query` matches `name`, both folded; 0 is no match. The same order as `src/palette/match.ts`:
/// the name itself, a start, a word start, initials, anywhere, one typo in a word, letters in order.
pub fn score(query: &str, name: &str) -> f64 {
    let q = fold(query.trim());
    if q.is_empty() {
        return 1.0;
    }
    let n = fold(name);
    if n == q {
        return 100.0;
    }
    if n.starts_with(&q) {
        return 80.0 - (n.len().saturating_sub(q.len()).min(20) as f64) / 2.0;
    }
    if let Some(at) = n.match_indices(&q).map(|(i, _)| i).find(|&i| n[..i].chars().last().is_some_and(is_sep))
    {
        return 60.0 - (at.min(20) as f64) / 2.0;
    }
    let initials: String = n.split(is_sep).filter_map(|w| w.chars().next()).collect();
    if !q.contains(' ') && initials.starts_with(&q) {
        return 50.0;
    }
    if n.contains(&q) {
        return 40.0;
    }
    // A slip of the finger: each typed word is within one edit of a word of the name (or of its start).
    let qw: Vec<&str> = q.split(is_sep).filter(|w| !w.is_empty()).collect();
    let nw: Vec<&str> = n.split(is_sep).filter(|w| !w.is_empty()).collect();
    if !qw.is_empty()
        && qw.iter().any(|w| w.chars().count() >= 4)
        && qw.iter().all(|w| nw.iter().any(|x| near(w, x)))
    {
        return 25.0;
    }
    let nc: Vec<char> = n.chars().collect();
    let (mut at, mut starts, mut gaps) = (0usize, 0usize, 0usize);
    for ch in q.chars().filter(|c| *c != ' ') {
        let Some(i) = nc[at..].iter().position(|&c| c == ch).map(|i| i + at) else { return 0.0 };
        if i == 0 || is_sep(nc[i - 1]) {
            starts += 1;
        }
        gaps += i - at;
        at = i + 1;
    }
    10.0 + starts as f64 * 4.0 - (gaps.min(20) as f64) / 4.0
}

/// Whether `typed` is `word`, or its start, with at most one letter wrong, missing, extra or swapped.
fn near(typed: &str, word: &str) -> bool {
    let a: Vec<char> = typed.chars().collect();
    let b: Vec<char> = word.chars().collect();
    if a.len() < 4 {
        return b.starts_with(&a);
    }
    // Compare against the word cut to about the typed length, so a typo in the start of a long word counts.
    (a.len().saturating_sub(1)..=(a.len() + 1).min(b.len())).any(|len| edits(&a, &b[..len]) <= 1)
}

/// Damerau–Levenshtein distance (optimal string alignment), small inputs only.
fn edits(a: &[char], b: &[char]) -> usize {
    let (n, m) = (a.len(), b.len());
    let mut d = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=n {
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[n][m]
}

/// The ways a typed word can be written in the text, for the full-text index, which folds č ć š ž but keeps
/// đ as its own letter: "đak" is also "djak" and "dak", and "djak" is also "đak".
pub fn spellings(word: &str) -> Vec<String> {
    let lower = word.to_lowercase();
    let mut out = vec![lower.clone()];
    let mut add = |w: String| {
        if !out.contains(&w) {
            out.push(w);
        }
    };
    if lower.contains('đ') {
        add(lower.replace('đ', "dj"));
        add(lower.replace('đ', "d"));
    }
    if lower.contains("dj") {
        add(lower.replace("dj", "đ"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bosnian_letters_fold() {
        assert_eq!(fold("Šta ima"), "sta ima");
        assert_eq!(fold("Ćevapi"), "cevapi");
        assert_eq!(fold("Đorđe"), fold("Djordje"));
        assert!(score("šta", "Šta ima novo") > 70.0);
        assert!(score("cevapi", "Ćevapi u Sarajevu") > 70.0);
        assert!(score("djordje", "Đorđe") > 90.0);
    }

    #[test]
    fn a_typo_is_forgiven() {
        assert!(score("recpie", "Bread recipe") > 0.0);
        assert!(score("sarjevo", "Trip to Sarajevo") > 0.0);
        assert_eq!(score("xyzzy", "Bread recipe"), 0.0);
        assert!(score("bread", "Bread recipe") > score("recpie", "Bread recipe"));
    }

    #[test]
    fn spellings_of_dj() {
        assert_eq!(spellings("Đak"), vec!["đak", "djak", "dak"]);
        assert_eq!(spellings("djak"), vec!["djak", "đak"]);
        assert_eq!(spellings("sto"), vec!["sto"]);
    }
}
