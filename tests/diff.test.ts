// The history panel's word diff (`npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { counts, diff, MAX_CELLS, type Part } from "../src/versions/diff.ts";

const join = (parts: Part[], keep: "from" | "to") =>
  parts.filter((p) => p.kind === "same" || p.kind === (keep === "from" ? "del" : "add")).map((p) => p.text).join("");

test("both sides can be rebuilt from the parts", () => {
  const cases = [
    ["", ""],
    ["", "new text"],
    ["old text", ""],
    ["the quick brown fox", "the slow brown fox"],
    ["a b c d e", "a c d x e f"],
    ["line one\n\nline two\n", "line one\nline 1.5\n\nline two\n"],
    ["same", "same"],
  ];
  for (const [from, to] of cases) {
    const parts = diff(from, to);
    assert.equal(join(parts, "from"), from, `from: ${JSON.stringify(from)}`);
    assert.equal(join(parts, "to"), to, `to: ${JSON.stringify(to)}`);
  }
});

test("a changed word is one removal and one addition", () => {
  const parts = diff("the quick brown fox", "the slow brown fox");
  assert.deepEqual(parts, [
    { kind: "same", text: "the " },
    { kind: "del", text: "quick " },
    { kind: "add", text: "slow " },
    { kind: "same", text: "brown fox" },
  ]);
  assert.deepEqual(counts(parts), { add: 1, del: 1 });
});

test("identical text is all same", () => {
  assert.deepEqual(diff("x y", "x y"), [{ kind: "same", text: "x y" }]);
});

test("past the cap the middle is coarse but still exact", () => {
  const n = Math.ceil(Math.sqrt(MAX_CELLS)) + 10;
  const from = Array.from({ length: n }, (_, i) => `a${i}`).join(" ");
  const to = Array.from({ length: n }, (_, i) => `b${i}`).join(" ");
  const t = Date.now();
  const parts = diff(`start ${from} end`, `start ${to} end`);
  assert.ok(Date.now() - t < 500);
  assert.equal(join(parts, "from"), `start ${from} end`);
  assert.equal(join(parts, "to"), `start ${to} end`);
});
