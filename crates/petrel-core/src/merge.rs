//! Three-way merge of a note's lines, for sync: when both computers changed a note since the last sync, the
//! text both had then (the base) shows what each side changed. Changes in different places are both kept;
//! changes that touch the same lines, or lines next to each other, are a real clash and give `None`, and the
//! caller keeps both texts as before. Plain lines, no cleverness: a merge that might be wrong is not made.

/// Lines in a DP table, at most: a longer note is not merged (it keeps both copies, as before).
const MAX_CELLS: usize = 4_000_000;

/// A change from the base: base lines `from..to` became `lines`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Hunk<'a> {
    from: usize,
    to: usize,
    lines: Vec<&'a str>,
}

/// `ours` and `theirs` merged against `base`, or `None` when they clash (or are too long to compare).
pub fn merge3(base: &str, ours: &str, theirs: &str) -> Option<String> {
    let b: Vec<&str> = base.split_inclusive('\n').collect();
    let o: Vec<&str> = ours.split_inclusive('\n').collect();
    let t: Vec<&str> = theirs.split_inclusive('\n').collect();
    let mut a = hunks(&b, &o)?;
    let mut c = hunks(&b, &t)?;
    // The same change on both sides counts once.
    c.retain(|h| !a.contains(h));
    for x in &a {
        for y in &c {
            if x.from <= y.to && y.from <= x.to {
                return None;
            }
        }
    }
    a.extend(c);
    a.sort_by_key(|h| (h.from, h.to));
    let mut out = String::with_capacity(ours.len().max(theirs.len()));
    let mut at = 0;
    for h in &a {
        for l in &b[at..h.from] {
            out.push_str(l);
        }
        for l in &h.lines {
            out.push_str(l);
        }
        at = h.to;
    }
    for l in &b[at..] {
        out.push_str(l);
    }
    Some(out)
}

/// The changes that turn `base` into `new`, from a longest common subsequence of lines.
fn hunks<'a>(base: &[&str], new: &[&'a str]) -> Option<Vec<Hunk<'a>>> {
    // Lines the same at both ends need no table.
    let mut pre = 0;
    while pre < base.len() && pre < new.len() && base[pre] == new[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < base.len() - pre
        && suf < new.len() - pre
        && base[base.len() - 1 - suf] == new[new.len() - 1 - suf]
    {
        suf += 1;
    }
    let bm = &base[pre..base.len() - suf];
    let nm = &new[pre..new.len() - suf];
    let (n, m) = (bm.len(), nm.len());
    if (n + 1) * (m + 1) > MAX_CELLS {
        return None;
    }
    // lcs[i][j]: the longest common run of bm[i..] and nm[j..].
    let w = m + 1;
    let mut lcs = vec![0u32; (n + 1) * w];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i * w + j] = if bm[i] == nm[j] {
                lcs[(i + 1) * w + j + 1] + 1
            } else {
                lcs[(i + 1) * w + j].max(lcs[i * w + j + 1])
            };
        }
    }
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    let mut open: Option<Hunk> = None;
    while i < n || j < m {
        if i < n && j < m && bm[i] == nm[j] {
            if let Some(h) = open.take() {
                out.push(h);
            }
            i += 1;
            j += 1;
            continue;
        }
        let h = open.get_or_insert(Hunk { from: pre + i, to: pre + i, lines: Vec::new() });
        if j < m && (i == n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j]) {
            h.lines.push(nm[j]);
            j += 1;
        } else {
            i += 1;
            h.to = pre + i;
        }
    }
    if let Some(h) = open {
        out.push(h);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::merge3;

    const BASE: &str = "# Trip\n\nMonday: museum\nTuesday: market\nWednesday: hike\nThursday: rest\n";

    #[test]
    fn edits_far_apart_are_both_kept() {
        let ours = BASE.replace("museum", "old town");
        let theirs = BASE.replace("rest", "train home");
        let m = merge3(BASE, &ours, &theirs).unwrap();
        assert_eq!(m, "# Trip\n\nMonday: old town\nTuesday: market\nWednesday: hike\nThursday: train home\n");
    }

    #[test]
    fn additions_at_both_ends() {
        let ours = format!("Packed.\n{BASE}");
        let theirs = format!("{BASE}Friday: fly\n");
        assert_eq!(merge3(BASE, &ours, &theirs).unwrap(), format!("Packed.\n{BASE}Friday: fly\n"));
    }

    #[test]
    fn the_same_line_clashes() {
        let ours = BASE.replace("market", "bazaar");
        let theirs = BASE.replace("market", "souk");
        assert_eq!(merge3(BASE, &ours, &theirs), None);
    }

    #[test]
    fn neighbouring_lines_clash() {
        let ours = BASE.replace("market", "bazaar");
        let theirs = BASE.replace("hike", "lake");
        assert_eq!(merge3(BASE, &ours, &theirs), None);
    }

    #[test]
    fn the_same_change_on_both_sides_is_one() {
        let both = BASE.replace("hike", "lake");
        assert_eq!(merge3(BASE, &both, &both).unwrap(), both);
    }

    #[test]
    fn a_deletion_and_a_far_edit() {
        let ours = BASE.replace("Monday: museum\n", "");
        let theirs = BASE.replace("rest", "sleep");
        assert_eq!(
            merge3(BASE, &ours, &theirs).unwrap(),
            "# Trip\n\nTuesday: market\nWednesday: hike\nThursday: sleep\n"
        );
    }
}
