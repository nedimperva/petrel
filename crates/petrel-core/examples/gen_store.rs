//! `cargo run --release -p petrel-core --example gen_store -- PATH [N]` writes a test library of N drafts
//! (default 50,000). `PETREL_DB=PATH` makes the app open it.

use std::path::Path;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: gen_store PATH [N]");
    let n: usize = args.next().map(|s| s.parse().expect("N")).unwrap_or(50_000);
    let path = Path::new(&path);
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    let mut store = petrel_core::Store::open(path)?;
    let t = std::time::Instant::now();
    petrel_core::gen::fill(&mut store, n, 7)?;
    println!("{n} drafts in {} at {:.1?}", path.display(), t.elapsed());
    Ok(())
}
