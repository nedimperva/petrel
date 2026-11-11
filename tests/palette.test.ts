// The command bar's ranking (`npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { pushRecent, rank, score } from "../src/palette/match.ts";

test("prefix beats word start beats substring beats letters in order", () => {
  const p = score("arc", "Archive draft");
  const w = score("dra", "Archive draft");
  const s = score("chi", "Archive draft");
  const l = score("rd", "Archive draft");
  assert.ok(p > w && w > s && s > l && l > 0, `${p} ${w} ${s} ${l}`);
  assert.equal(score("xyz", "Archive draft"), 0);
  assert.equal(score("", "anything"), 1);
});

test("initials beat a name that only contains the letters", () => {
  assert.ok(score("nd", "New draft") > score("nd", "Find in this draft"));
  assert.ok(score("ad", "Archive draft") > score("chi", "Archive draft"));
});

test("letters in order prefer word starts", () => {
  assert.ok(score("nd", "New draft") > score("nd", "Open drafts"));
  assert.equal(score("zq", "New draft"), 0);
});

test("rank drops non-matches and keeps order on ties", () => {
  const names = ["Show drafts", "New draft", "Trash draft", "Flag draft"];
  // The earlier the word, the better; "Show drafts" and "Flag draft" tie, so they keep their order.
  assert.deepEqual(rank("draft", names, (n) => n), ["New draft", "Show drafts", "Flag draft", "Trash draft"]);
  assert.deepEqual(rank("new", names, (n) => n), ["New draft"]);
  assert.deepEqual(rank("", names, (n) => n), names);
});

test("regex characters in the query are literal", () => {
  assert.ok(score("c++", "Notes on c++") > 0);
  assert.equal(score("(", "no parens"), 0);
});

test("recents move to the front and are capped", () => {
  assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
  assert.deepEqual(pushRecent(["a", "b"], "c", 2), ["c", "a"]);
});

test("Ctrl K filters come off the words", async () => {
  const { parseFilters, inFolder, noFilters } = await import("../src/palette/filters.ts");
  const now = new Date(2026, 10, 11, 21, 0);
  const f = parseFilters("in:travel hotel pinned this week has:link", now);
  assert.equal(f.words, "hotel");
  assert.equal(f.folder, "travel");
  assert.equal(f.pinned, true);
  assert.equal(f.since, new Date(2026, 10, 5).getTime());
  assert.deepEqual(f.has, ["link"]);
  assert.equal(parseFilters("today", now).since, new Date(2026, 10, 11).getTime());
  assert.equal(parseFilters('in:"Work notes" x', now).folder, "Work notes");
  assert.ok(noFilters(parseFilters("weekend plans", now)));
  assert.equal(parseFilters("weekend plans", now).words, "weekend plans");
  assert.ok(inFolder("Travel/Mostar", "travel") && inFolder("Travel", "trav") && !inFolder("Work", "travel"));
  assert.ok(inFolder("Travel/Mostar", "travel/mostar") && !inFolder("Travel/Kotor", "travel/mostar"));
});
