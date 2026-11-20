//! How fast the notes are, on a generated folder of N notes (default 5,000) in twelve collections. Exits
//! non-zero when a target is missed, scaled by `PETREL_BENCH_SLACK` (CI runners are slower and noisier than a
//! laptop). The targets are what the app needs to feel instant: a keystroke's work under a frame.
//!
//! `cargo run --release -p petrel-core --example notes_bench [-- N]`

use std::time::{Duration, Instant};

use petrel_core::Store;

struct Row<'a> {
    what: &'a str,
    target_ms: f64,
    p50: Duration,
    p95: Duration,
}

fn measure(runs: usize, mut f: impl FnMut()) -> (Duration, Duration) {
    let mut times: Vec<Duration> = (0..runs)
        .map(|_| {
            let t = Instant::now();
            f();
            t.elapsed()
        })
        .collect();
    times.sort();
    (times[times.len() / 2], times[times.len() * 95 / 100])
}

/// A small deterministic generator: the same folder on every run.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

const WORDS: &[&str] = &[
    "the", "and", "release", "plan", "garden", "train", "Mostar", "bridge", "coffee", "letter", "invoice",
    "song", "chorus", "prompt", "meeting", "Friday", "window", "keyboard", "paper", "lamp", "river",
    "market", "bread", "lemon", "ticket", "draft", "review", "bank", "card", "phone", "call", "doctor",
    "school", "book", "chapter",
];
const FOLDERS: &[&str] = &[
    "Projects", "Travel", "Journal", "Recipes", "Songs", "Prompts", "Snippets", "Work", "Home", "Books",
    "Ideas", "inbox",
];

fn text(rng: &mut Rng, i: usize) -> String {
    let mut out = String::new();
    for p in 0..(2 + rng.below(5)) {
        for w in 0..(12 + rng.below(40)) {
            out.push_str(WORDS[rng.below(WORDS.len())]);
            out.push(if w % 11 == 10 { '\n' } else { ' ' });
        }
        if p == 1 && i.is_multiple_of(7) {
            out.push_str(&format!("\n- [ ] task {i}\n"));
        }
        if p == 0 && i.is_multiple_of(5) {
            out.push_str(&format!(" see [[Note {}]]", rng.below(i.max(1))));
        }
        out.push_str("\n\n");
    }
    // One word only a few notes have, for the rare search.
    if i % 1000 == 7 {
        out.push_str("zanzibar\n");
    }
    out
}

fn main() -> anyhow::Result<()> {
    let n: usize = std::env::args().nth(1).map(|s| s.parse().expect("N")).unwrap_or(5_000);
    let slack: f64 = std::env::var("PETREL_BENCH_SLACK").ok().and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let dir = std::env::temp_dir().join(format!("petrel-bench-{}", std::process::id()));
    let notes = dir.join("notes");
    let path = dir.join("petrel.db");
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let t = Instant::now();
    for i in 0..n {
        let folder = notes.join(FOLDERS[i % FOLDERS.len()]);
        std::fs::create_dir_all(&folder)?;
        std::fs::write(folder.join(format!("Note {i}.md")), text(&mut rng, i))?;
    }
    eprintln!("wrote {n} notes in {:.1?}", t.elapsed());
    let mut rows = Vec::new();

    // The first look at a folder Petrel has never seen: every file read and indexed.
    let mut store = Store::open(&path)?;
    let t = Instant::now();
    store.set_notes_root(&notes)?;
    store.scan_notes()?;
    let first = t.elapsed() * 1000 / n as u32;
    rows.push(Row { what: "first scan, per 1,000 notes", target_ms: 400.0, p50: first, p95: first });

    // Every start after that: nothing changed, so only the file times are read.
    drop(store);
    let mut store = Store::open(&path)?;
    let (p50, p95) = measure(5, || {
        store.scan_notes().unwrap();
    });
    rows.push(Row { what: "start scan, nothing changed", target_ms: 400.0, p50, p95 });

    let (p50, p95) = measure(200, || {
        store.find_notes("rel pla", 20).unwrap();
    });
    rows.push(Row { what: "Ctrl P, two words", target_ms: 20.0, p50, p95 });

    let (p50, p95) = measure(200, || {
        store.search_notes("release bridge", 50).unwrap();
    });
    rows.push(Row { what: "search, common words", target_ms: 15.0, p50, p95 });

    let (p50, p95) = measure(200, || {
        store.search_notes("zanzibar", 50).unwrap();
    });
    rows.push(Row { what: "search, rare word", target_ms: 2.0, p50, p95 });

    let ids: Vec<i64> = {
        let mut s = store.raw().prepare("SELECT id FROM notes")?;
        let ids = s.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        ids
    };
    let mut pick = Rng(7);
    let (p50, p95) = measure(100, || {
        store.similar_notes(ids[pick.below(ids.len())], 5).unwrap();
    });
    // Once when a note opens, not per keystroke.
    rows.push(Row { what: "related notes", target_ms: 80.0, p50, p95 });

    let (p50, p95) = measure(50, || {
        store.backlinks(ids[pick.below(ids.len())]).unwrap();
    });
    rows.push(Row { what: "links in", target_ms: 30.0, p50, p95 });

    let (p50, p95) = measure(100, || {
        store.note_folders().unwrap();
    });
    rows.push(Row { what: "sidebar counts", target_ms: 10.0, p50, p95 });

    let (p50, p95) = measure(20, || {
        store.open_tasks().unwrap();
    });
    rows.push(Row { what: "open tasks", target_ms: 60.0, p50, p95 });

    // Autosave: the file written and the index updated, as each pause in typing does.
    let id = ids[0];
    let mut hash = store.note(id)?.hash;
    let mut k = 0;
    let (p50, p95) = measure(200, || {
        k += 1;
        let saved = store.save_note(id, &format!("{}\n{k}", WORDS.join(" ")), &hash).unwrap();
        hash = saved.hash;
    });
    rows.push(Row { what: "autosave", target_ms: 8.0, p50, p95 });

    println!(
        "{:<30} {:>9} {:>9} {:>9}  {}",
        "what",
        "target",
        "p50",
        "p95",
        if slack != 1.0 { format!("(slack ×{slack})") } else { String::new() }
    );
    let mut failed = false;
    for r in &rows {
        let p50_ms = r.p50.as_secs_f64() * 1000.0;
        let ok = p50_ms <= r.target_ms * slack;
        failed |= !ok;
        println!(
            "{:<30} {:>7.2}ms {:>7.3}ms {:>7.3}ms  {}",
            r.what,
            r.target_ms,
            p50_ms,
            r.p95.as_secs_f64() * 1000.0,
            if ok { "ok" } else { "MISSED" }
        );
    }
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    println!("database: {:.1} MB for {n} notes", size as f64 / 1e6);
    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
    if failed {
        std::process::exit(1);
    }
    Ok(())
}
