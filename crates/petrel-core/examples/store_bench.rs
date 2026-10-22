//! The speed table from docs/PLAN.md, measured on a generated 50,000-draft store. Exits non-zero when a
//! target is missed, scaled by `PETREL_BENCH_SLACK` (CI runners are slower and noisier than the laptop).
//!
//! `cargo run --release -p petrel-core --example store_bench [-- N]`

use std::time::{Duration, Instant};

use petrel_core::{Folder, ListQuery, Sort, Store};

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
    let mut store = Store::open(&path)?;
    // A rare tag (50 drafts) beside the generator's twelve common ones (~12 % of drafts each).
    store.raw().execute_batch(
        "INSERT INTO tags (uuid, name) VALUES ('bench-rare', 'rare'); \
         INSERT INTO draft_tags (draft_id, tag_id) SELECT d.id, t.id FROM drafts d, tags t \
           WHERE t.name = 'rare' AND d.id % 1000 = 7;",
    )?;

    let mut rows = Vec::new();
    let mut rng = petrel_core::gen::Rng::new(3);
    let ids: Vec<i64> = {
        let mut s = store.raw().prepare("SELECT id FROM drafts WHERE deleted_at IS NULL")?;
        let ids = s.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        ids
    };
    let pick = |rng: &mut petrel_core::gen::Rng| ids[rng.below(ids.len() as u64) as usize];

    let inbox = ListQuery::folder(Folder::Inbox);
    let (p50, p95) = measure(200, || {
        store.list(&inbox).unwrap();
    });
    rows.push(Row { what: "list page (50 rows)", target_ms: 1.0, p50, p95 });

    let (p50, p95) = measure(200, || {
        let page = store.list(&inbox).unwrap();
        store.list(&ListQuery { cursor: page.next, ..inbox.clone() }).unwrap();
    });
    rows.push(Row { what: "list page 2 via cursor", target_ms: 1.0, p50, p95 });

    // Page 200 of the Inbox: keyset paging costs the same however deep the cursor is.
    let deep = {
        let mut q = inbox.clone();
        for _ in 0..200 {
            q.cursor = store.list(&q)?.next;
        }
        q
    };
    let (p50, p95) = measure(200, || {
        store.list(&deep).unwrap();
    });
    rows.push(Row { what: "list page 200 via cursor", target_ms: 1.0, p50, p95 });

    let lists: Vec<(&str, ListQuery)> = vec![
        ("list, by title", ListQuery { sort: Sort::Title, desc: false, ..inbox.clone() }),
        ("list, by created", ListQuery { sort: Sort::Created, ..inbox.clone() }),
        ("list, all folders", ListQuery { folder: None, ..inbox.clone() }),
        ("list, flagged first", ListQuery { flagged_top: true, ..inbox.clone() }),
        ("list, flagged only", ListQuery { folder: None, flagged_only: true, ..inbox.clone() }),
        ("list, common tag", ListQuery { tags_all: vec!["idea".into()], ..inbox.clone() }),
        (
            "list, two common tags",
            ListQuery { tags_all: vec!["idea".into(), "plan".into()], ..inbox.clone() },
        ),
        ("list, rare tag", ListQuery { tags_all: vec!["rare".into()], ..inbox.clone() }),
        ("list, without a tag", ListQuery { tags_none: vec!["idea".into()], ..inbox.clone() }),
        ("list, text stopword", ListQuery { fts: "meeting".into(), ..inbox.clone() }),
        ("list, text rare word", ListQuery { fts: petrel_core::gen::synthetic_word(2_000), ..inbox.clone() }),
        ("list, text mid word", ListQuery { fts: "garden".into(), ..inbox.clone() }),
    ];
    for (label, q) in &lists {
        let (p50, p95) = measure(100, || {
            store.list(q).unwrap();
        });
        // A text filter is a search, and has the search target. Two tags that are each on 12 % of the drafts
        // walk ~3,000 rows for a page: the one list shape allowed 2 ms (package 01 Decisions).
        let target_ms = if !q.fts.is_empty() {
            10.0
        } else if q.tags_all.len() > 1 {
            2.0
        } else {
            1.0
        };
        rows.push(Row { what: label, target_ms, p50, p95 });
    }

    // "meeting" is in nearly every generated draft (a stopword); the pair is in about half; the synthetic
    // word is rare; "ba" as a prefix spans many terms.
    for (label, q) in [
        ("search, stopword", "meeting"),
        ("search, two common words", "budget review"),
        ("search, rare word", petrel_core::gen::synthetic_word(2_000).as_str()),
        ("search, short prefix", "ba"),
        ("search, word and tag", "budget tag:idea"),
        ("search, flagged only", "is:flagged review"),
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

    // Not in the PLAN table: the UI asks once per list change, off the typing path. The limit is a regression
    // guard at 50k, not a promise (package 01 Decisions).
    let (p50, p95) = measure(50, || {
        store.tag_counts(Some(Folder::Inbox)).unwrap();
    });
    rows.push(Row { what: "tag counts (Inbox)", target_ms: 50.0, p50, p95 });

    // A screenful archived and put back: the `e` then `z` path.
    let batch: Vec<i64> = store.list(&inbox)?.rows.iter().map(|r| r.id).collect();
    let (p50, p95) = measure(100, || {
        let tok = store.move_drafts(&batch, Folder::Archive).unwrap();
        store.undo(&tok.token).unwrap();
    });
    rows.push(Row { what: "archive 50 + undo", target_ms: 5.0, p50, p95 });

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
