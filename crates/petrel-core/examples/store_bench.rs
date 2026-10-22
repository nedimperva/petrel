//! The speed table from docs/PLAN.md, measured on a generated 50,000-draft store. Exits non-zero when a
//! target is missed, scaled by `PETREL_BENCH_SLACK` (CI runners are slower and noisier than the laptop).
//!
//! `cargo run --release -p petrel-core --example store_bench [-- N]`

use std::time::{Duration, Instant};

use petrel_core::{Folder, Store};

struct Row {
    what: &'static str,
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

fn main() -> anyhow::Result<()> {
    let n: usize = std::env::args().nth(1).map(|s| s.parse().expect("N")).unwrap_or(50_000);
    let slack: f64 = std::env::var("PETREL_BENCH_SLACK").ok().and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let dir = std::env::temp_dir().join(format!("petrel-bench-{}", std::process::id()));
    let path = dir.join("petrel.db");
    let mut store = Store::open(&path)?;
    let t = Instant::now();
    petrel_core::gen::fill(&mut store, n, 7)?;
    eprintln!("generated {n} drafts in {:.1?}", t.elapsed());
    // Reopen so nothing is warm from the generation pass but the OS cache, as at app start.
    drop(store);
    let store = Store::open(&path)?;

    let mut rows = Vec::new();
    let mut rng = petrel_core::gen::Rng::new(3);
    let ids: Vec<i64> = {
        let mut s = store.raw().prepare("SELECT id FROM drafts WHERE deleted_at IS NULL")?;
        let ids = s.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        ids
    };
    let pick = |rng: &mut petrel_core::gen::Rng| ids[rng.below(ids.len() as u64) as usize];

    let (p50, p95) = measure(200, || {
        store.list(Folder::Inbox, None, 50).unwrap();
    });
    rows.push(Row { what: "list page (50 rows)", target_ms: 1.0, p50, p95 });

    let (p50, p95) = measure(200, || {
        let page = store.list(Folder::Inbox, None, 50).unwrap();
        store.list(Folder::Inbox, page.next, 50).unwrap();
    });
    rows.push(Row { what: "list page 2 via cursor", target_ms: 1.0, p50, p95 });

    // "meeting" is in nearly every generated draft (a stopword); the pair is in about half; the synthetic
    // word is rare; "ba" as a prefix spans many terms.
    for (label, q) in [
        ("search, stopword", "meeting"),
        ("search, two common words", "budget review"),
        ("search, rare word", petrel_core::gen::synthetic_word(2_000).as_str()),
        ("search, short prefix", "ba"),
    ] {
        let (p50, p95) = measure(100, || {
            store.search(q, 50).unwrap();
        });
        rows.push(Row { what: label, target_ms: 10.0, p50, p95 });
    }

    let (p50, p95) = measure(500, || {
        store.draft(pick(&mut rng)).unwrap();
    });
    rows.push(Row { what: "open a draft", target_ms: 5.0, p50, p95 });

    let text = petrel_core::gen::draft_text(&mut rng, 1);
    let (p50, p95) = measure(500, || {
        let id = pick(&mut rng);
        store.save(id, &text, 10).unwrap();
    });
    rows.push(Row { what: "autosave write", target_ms: 2.0, p50, p95 });

    let (p50, p95) = measure(100, || {
        store.count(Folder::Inbox).unwrap();
    });
    rows.push(Row { what: "folder count", target_ms: 5.0, p50, p95 });

    println!(
        "{:<28} {:>9} {:>9} {:>9}  {}",
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
            "{:<28} {:>7.2}ms {:>7.3}ms {:>7.3}ms  {}",
            r.what,
            r.target_ms,
            p50_ms,
            r.p95.as_secs_f64() * 1000.0,
            if ok { "ok" } else { "MISSED" }
        );
    }
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    println!("database: {:.1} MB for {n} drafts", size as f64 / 1e6);
    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
    if failed {
        std::process::exit(1);
    }
    Ok(())
}
