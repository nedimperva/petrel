// Pasted HTML to Markdown, and the days a capture word names (`npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown, MEANINGFUL, type HNode } from "../src/editor/paste.ts";
import { dayOptions, dayWord } from "../src/journal/days.ts";
import { pickRoute } from "../src/inbox/route.ts";

/** A tiny element tree: `el("p", {}, "text", el("b", {}, "bold"))`. */
function el(name: string, attrs: Record<string, string>, ...kids: (HNode | string)[]): HNode {
  const childNodes = kids.map((k) => (typeof k === "string" ? { nodeType: 3, nodeName: "#text", textContent: k, childNodes: [] } : k));
  return { nodeType: 1, nodeName: name.toUpperCase(), textContent: null, childNodes, getAttribute: (n) => attrs[n] ?? null };
}

test("pasted HTML keeps its structure and drops the rest", () => {
  const body = el(
    "body",
    {},
    el("h2", {}, "Bread"),
    el("p", {}, "A ", el("b", {}, "long "), "proof, see ", el("a", { href: "https://x.example/b" }, "the book"), ".", el("script", {}, "alert(1)")),
    el("ul", {}, el("li", {}, "flour"), el("li", {}, "water", el("ul", {}, el("li", {}, "warm")))),
    el("ol", {}, el("li", {}, el("em", {}, "mix")), el("li", {}, "rest")),
    el("pre", {}, el("code", {}, "  let x = 1;\n  x += 1;")),
    el("blockquote", {}, el("p", {}, "Patience.")),
    el("p", {}, el("a", { href: "javascript:alert(1)" }, "bad link"), " ", el("img", { src: "https://t.example/p.gif" })),
  );
  assert.equal(
    htmlToMarkdown(body),
    [
      "## Bread",
      "",
      "A **long** proof, see [the book](https://x.example/b).",
      "",
      "- flour",
      "- water",
      "  - warm",
      "",
      "1. _mix_",
      "2. rest",
      "",
      "```",
      "  let x = 1;",
      "  x += 1;",
      "```",
      "",
      "> Patience.",
      "",
      "bad link",
    ].join("\n"),
  );
  assert.ok(MEANINGFUL.test("<ul><li>a</li></ul>"));
  assert.ok(!MEANINGFUL.test('<div><span style="color:red">fn main()</span></div>'));
});

test("day words", () => {
  const wed = new Date(2026, 10, 11, 21, 0); // Wednesday, 11 November 2026
  assert.equal(dayWord("today", wed), "2026-11-11");
  assert.equal(dayWord("tomorrow", wed), "2026-11-12");
  assert.equal(dayWord("fri", wed), "2026-11-13");
  assert.equal(dayWord("Friday", wed), "2026-11-13");
  assert.equal(dayWord("wed", wed), "2026-11-18");
  assert.equal(dayWord("nov20", wed), "2026-11-20");
  assert.equal(dayWord("20nov", wed), "2026-11-20");
  assert.equal(dayWord("jan5", wed), "2027-01-05");
  assert.equal(dayWord("nov1", wed), "2026-11-01");
  assert.equal(dayWord("2026-12-24", wed), "2026-12-24");
  assert.equal(dayWord("feb30", wed), null);
  assert.equal(dayWord("recipes", wed), null);
  assert.equal(dayWord("fr", wed), null);
  assert.deepEqual(
    dayOptions("t", wed).map((d) => d.word),
    ["today", "tomorrow", "tue", "thu"],
  );
  assert.deepEqual(dayOptions("nov2", wed), [{ word: "nov2", day: "2026-11-02" }]);
  const days = (w: string) => dayWord(w, wed);
  assert.deepEqual(pickRoute("call the dentist @fri", ["Recipes"], [], days)?.route, { kind: "day", date: "2026-11-13" });
  assert.deepEqual(pickRoute("ideas @sat", ["Sat"], [], days)?.route, { kind: "folder", folder: "Sat" });
  assert.deepEqual(pickRoute("ideas @today", ["Today"], [], days)?.route, { kind: "day", date: "2026-11-11" });
});
