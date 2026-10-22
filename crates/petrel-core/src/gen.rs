//! A deterministic fake draft library for benchmarks and the kill test. No dependency on `rand`: a small
//! xorshift is enough and keeps the build light.

use anyhow::Result;

use crate::Store;

const WORDS: &[&str] = &[
    "meeting",
    "notes",
    "idea",
    "call",
    "draft",
    "plan",
    "budget",
    "review",
    "petrel",
    "capture",
    "later",
    "action",
    "markdown",
    "list",
    "today",
    "tomorrow",
    "project",
    "release",
    "linux",
    "windows",
    "keyboard",
    "search",
    "tag",
    "archive",
    "flag",
    "version",
    "shell",
    "command",
    "file",
    "clipboard",
    "journal",
    "recipe",
    "travel",
    "book",
    "quote",
    "remember",
    "ask",
    "send",
    "mail",
    "link",
    "photo",
    "garden",
];

/// Synthetic vocabulary size. Word `r` (0-based rank) is drawn with probability ∝ 1/(r+1): a Zipf law, as in
/// real text, so a library has a few very common words and a long tail of rare ones.
const VOCAB: usize = 5_000;

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.max(1))
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }
    /// A float in [0, 1).
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    /// A Zipf-distributed word: the 42 real words are the most common, then synthetic ones.
    fn word(&mut self) -> String {
        let r = zipf_rank(self.unit());
        if r < WORDS.len() {
            WORDS[r].to_string()
        } else {
            synthetic_word(r)
        }
    }
}

/// Inverse CDF of the Zipf law over `VOCAB` ranks, by the harmonic-number approximation (no table needed).
fn zipf_rank(u: f64) -> usize {
    let h = (VOCAB as f64).ln() + std::f64::consts::EULER_GAMMA;
    let r = (u * h).exp() - 1.0;
    (r as usize).min(VOCAB - 1)
}

/// A pronounceable fake word for rank `r`, deterministic.
pub fn synthetic_word(r: usize) -> String {
    const C: &[u8] = b"bdfgklmnprstvz";
    const V: &[u8] = b"aeiou";
    let mut x = r as u64 * 2654435761 % 1_000_003;
    let len = 2 + (r % 3);
    let mut w = String::new();
    for _ in 0..len {
        w.push(C[(x % C.len() as u64) as usize] as char);
        x /= C.len() as u64;
        w.push(V[(x % V.len() as u64) as usize] as char);
        x = x / V.len() as u64 + r as u64;
    }
    w
}

/// One draft's text: a title line and a few short Markdown paragraphs, 80–1,500 characters.
pub fn draft_text(rng: &mut Rng, i: usize) -> String {
    let mut s = String::new();
    let title_words = 2 + rng.below(5);
    s.push_str(if rng.below(3) == 0 { "# " } else { "" });
    for w in 0..title_words {
        if w > 0 {
            s.push(' ');
        }
        s.push_str(&rng.word());
    }
    s.push_str(&format!(" {i}\n\n"));
    let paragraphs = 1 + rng.below(4);
    for _ in 0..paragraphs {
        let words = 10 + rng.below(60);
        for w in 0..words {
            if w > 0 {
                s.push(' ');
            }
            s.push_str(&rng.word());
        }
        s.push_str(".\n\n");
    }
    if rng.below(4) == 0 {
        s.push_str("- [ ] ");
        s.push_str(&rng.word());
        s.push_str("\n- [x] ");
        s.push_str(&rng.word());
        s.push('\n');
    }
    s
}

/// Fills `store` with `n` drafts spread over the last two years: 80 % Inbox, 18 % Archive, 2 % Trash,
/// 10 % flagged, 0–3 tags each. Timestamps are distinct so keyset paging has no ties to hide behind.
pub fn fill(store: &mut Store, n: usize, seed: u64) -> Result<()> {
    let mut rng = Rng::new(seed);
    let now = 1_760_000_000_000i64;
    let two_years = 2 * 365 * 24 * 60 * 60 * 1000i64;
    let conn = store.raw();
    conn.execute_batch("BEGIN")?;
    {
        let mut insert = conn.prepare(
            "INSERT INTO drafts (uuid, content, title, preview, folder, flagged, created_at, modified_at, accessed_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)",
        )?;
        let mut tag =
            conn.prepare("INSERT INTO tags (uuid, name) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING")?;
        let mut link = conn.prepare(
            "INSERT OR IGNORE INTO draft_tags (draft_id, tag_id) SELECT ?1, id FROM tags WHERE name = ?2",
        )?;
        for i in 0..n {
            let text = draft_text(&mut rng, i);
            let folder = match rng.below(100) {
                0..=79 => 0,
                80..=97 => 1,
                _ => 2,
            };
            let t = now - two_years + (two_years / n as i64) * i as i64 + rng.below(1000) as i64;
            insert.execute(rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                &text,
                crate::title::title(&text),
                crate::title::preview(&text),
                folder,
                (rng.below(10) == 0) as i64,
                t
            ])?;
            let id = conn.last_insert_rowid();
            for _ in 0..rng.below(4) {
                let name = WORDS[rng.below(12) as usize];
                tag.execute(rusqlite::params![uuid::Uuid::new_v4().to_string(), name])?;
                link.execute(rusqlite::params![id, name])?;
            }
        }
    }
    conn.execute_batch("COMMIT")?;
    Ok(())
}
