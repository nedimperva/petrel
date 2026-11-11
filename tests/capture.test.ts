// Capture routing, the days of the journal and where filing learns from (`npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRoute, strip, tokens, typingToken } from "../src/inbox/route.ts";
import { addDays, isDayNote, isoWeek, monthGrid, parseDay } from "../src/journal/days.ts";
import { bump, parseCounts, score } from "../src/inbox/learn.ts";
import { quoteBlock, titleLine } from "../src/inbox/quote.ts";

test("words are found outside code and Markdown", () => {
  const t = tokens("Rest the dough #recipes\n# Heading\n> quote\n`#code` and >Groceries\n```\n#fenced\n```\nend #today");
  assert.deepEqual(
    t.map((x) => x.sign + x.word),
    ["#recipes", ">Groceries", "#today"],
  );
  assert.deepEqual(tokens("a#b c"), []);
});

test("a route takes the last word that names a place", () => {
  const folders = ["Recipes", "Travel", "Travel/Mostar"];
  const r = pickRoute("Grandma's trick #recipes", folders, []);
  assert.deepEqual(r?.route, { kind: "folder", folder: "Recipes" });
  assert.equal(strip("Grandma's trick #recipes", r!.token), "Grandma's trick");
  assert.deepEqual(pickRoute("#travel then #nothing", folders, [])?.route, { kind: "folder", folder: "Travel" });
  assert.deepEqual(pickRoute("milk >groceries", folders, ["Groceries"])?.route, { kind: "note", title: "Groceries" });
  assert.deepEqual(pickRoute("x >trip-to-mostar", folders, ["Trip to Mostar"])?.route, { kind: "note", title: "Trip to Mostar" });
  assert.deepEqual(pickRoute("call back #Today", folders, [])?.route, { kind: "day" });
  assert.equal(pickRoute("#mostar is a sub-folder", folders, []), null);
  assert.equal(strip("#recipes first", { from: 0, to: 8 }), "first");
});

test("the word being typed", () => {
  assert.deepEqual(typingToken("dough #rec"), { sign: "#", word: "rec", back: 4 });
  assert.deepEqual(typingToken(">"), { sign: ">", word: "", back: 1 });
  assert.equal(typingToken("a#rec"), null);
  assert.equal(typingToken("# heading"), null);
});

test("days", () => {
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.ok(isDayNote("journal", "2026-11-11") && !isDayNote("journal", "2026-W46") && !isDayNote("inbox", "2026-11-11"));
  const g = monthGrid("2026-11-11");
  // 1 November 2026 is a Sunday: six blanks before it, Monday first.
  assert.equal(g.indexOf("2026-11-01"), 6);
  assert.equal(g.filter(Boolean).length, 30);
  assert.equal(isoWeek(new Date(2026, 10, 11)), "2026-W46");
  assert.equal(isoWeek(new Date(2027, 0, 1)), "2026-W53");
});

test("filing learns, and recent beats old", () => {
  const now = Date.UTC(2026, 10, 11);
  let c = parseCounts("not json");
  assert.deepEqual(c, {});
  c = bump(c, { kind: "folder", folder: "Recipes" }, now - 30 * 86400000);
  c = bump(c, { kind: "folder", folder: "Recipes" }, now - 30 * 86400000);
  c = bump(c, { kind: "day" }, now);
  assert.ok(score(c["day"], now) > score(c["folder:Recipes"], now));
  assert.deepEqual(parseCounts(JSON.stringify(c)), c);
});

test("a quote keeps its source", () => {
  assert.equal(
    quoteBlock({ text: "A cold proof.\nDeeper taste.", app: "Firefox", title: "The Bread Book", link: null }),
    "> A cold proof.\n> Deeper taste.\n>\n> — The Bread Book\n\n",
  );
  assert.equal(quoteBlock({ text: "x", app: null, title: null, link: null }), "> x\n\n");
  assert.equal(quoteBlock({ text: null, app: "Firefox", title: "t", link: null }), "");
  assert.equal(
    quoteBlock({ text: "x", app: "Edge", title: null, link: "https://www.example.com/a b" }),
    "> x\n>\n> — [example.com](<https://www.example.com/a b>)\n\n",
  );
  assert.equal(quoteBlock({ text: "x", app: "Word", title: null, link: null }), "> x\n>\n> — Word\n\n");
});

test("a capture is named by its words", () => {
  const quote = "> A long, cold proof.\n>\n> — The Bread Book · [breadbook.example](<https://breadbook.example/3>)\n\n";
  assert.equal(titleLine(`${quote}Grandma's trick: rest it overnight`), "Grandma's trick: rest it overnight");
  assert.equal(titleLine(quote), "The Bread Book");
  assert.equal(titleLine("> Only a quote here.\n"), "Only a quote here.");
  assert.equal(titleLine("Call the bank before Friday"), "Call the bank before Friday");
});

test("kept for later comes back the next day", async () => {
  const { keepUntil, laterOf, parseLater } = await import("../src/inbox/later.ts");
  const evening = new Date(2026, 10, 11, 21, 0);
  const l = keepUntil(parseLater('{"old.md": 1}'), "inbox/a.md", evening);
  assert.deepEqual(Object.keys(l), ["inbox/a.md"]);
  assert.ok(laterOf(l, evening.getTime()).has("inbox/a.md"));
  assert.equal(laterOf(l, new Date(2026, 10, 12, 0, 1).getTime()).size, 0);
  assert.deepEqual(parseLater("[1]"), {});
});
