//! The same five scripts for every candidate.

pub const STRING_WORK: &str = r##"
  let s = "";
  for (let i = 0; i < 20000; i++) s += "word" + (i % 97) + " ";
  const words = s.trim().split(" ");
  const counts = {};
  for (const w of words) counts[w] = (counts[w] || 0) + 1;
  const m = /^(?<name>word)(?<n>\d+)$/.exec(words[5]);
  JSON.stringify({ unique: Object.keys(counts).length, n: m.groups.n, upper: words[0].toUpperCase() });
"##;

pub const CLASSES: &str = r##"
  class Draft {
    #content;
    constructor(c) { this.#content = c; this.tags = new Set(); }
    get title() { return this.#content.split("\n")[0].replace(/^#+\s*/, ""); }
    addTag(t) { this.tags.add(t.toLowerCase()); return this; }
    toJSON() { return { title: this.title, tags: [...this.tags] }; }
  }
  const d = new Draft("# Hello\nbody").addTag("Work").addTag("work");
  const [a, ...rest] = [1, 2, 3];
  JSON.stringify({ d, a, rest, tpl: `t=${d.title}`, opt: d?.missing?.x ?? "dflt" });
"##;

/// `host.clipboard()` is a Rust function. The script awaits it twice.
pub const ASYNC_HOST: &str = r##"
  (async () => {
    const a = await host.clipboard();
    const b = await host.clipboard();
    return a + "|" + b;
  })()
"##;

pub const INFINITE_LOOP: &str = "let i = 0; while (true) { i++; } i;";

pub const BIG_ALLOC: &str = r##"
  const parts = [];
  for (let i = 0; i < 64; i++) parts.push("x".repeat(1024 * 1024));
  parts.length;
"##;
