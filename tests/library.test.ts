// Library preview and multi-selection helpers (`npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { blankNames, codePreview, highlightParts, photoCount, plain, previewTasks, subOf } from "../src/library/preview.ts";
import { pruneSelection, rangeSelection, toggleSelection } from "../src/library/selection.ts";

test("plain preview strips headings, markdown marks, links and raw image syntax", () => {
  const md = "# Kyoto\n\nStay near **Sanjo** and see [map](https://example.com) or [[Osaka|Osaka notes]].\n\n![dusk|400](attachments/dusk.jpg)\n- [ ] Pack umbrella";
  assert.equal(plain(md), "Stay near Sanjo and see map or Osaka notes. Pack umbrella");
  assert.equal(photoCount(md), 1);
});

test("previewTasks extracts structured checklist lines up to the limit", () => {
  const md = "# Packing\n- [x] **Passport**\n- [ ] Charger\n- [ ] [[Rain shell|Jacket]]\n- [ ] Extra socks";
  assert.deepEqual(previewTasks(md, 3), [
    { done: true, text: "Passport" },
    { done: false, text: "Charger" },
    { done: false, text: "Jacket" },
  ]);
});

test("codePreview strips trigger line, headings and code fences and detects language", () => {
  const raw = ";reb\n# Interactive rebase\n```bash\ngit rebase -i HEAD~{{count|3}}\ngit push --force-with-lease\n```";
  assert.deepEqual(codePreview(raw), {
    lang: "bash",
    text: "git rebase -i HEAD~{{count|3}}\ngit push --force-with-lease",
  });
});

test("blankNames finds unique blank names across defaults, choices and escaped braces", () => {
  const t = "Review {{focus|errors}} with {{tone: direct / warm}} and {{focus}} \\{{literal}}";
  assert.deepEqual(blankNames(t), ["focus", "tone"]);
});

test("highlightParts splits text cleanly on query terms without regex hazards", () => {
  assert.deepEqual(highlightParts("Review (this) diff now", "diff (this)"), [
    { text: "Review ", hit: false },
    { text: "(this)", hit: true },
    { text: " ", hit: false },
    { text: "diff", hit: true },
    { text: " now", hit: false },
  ]);
  assert.deepEqual(highlightParts("Hello", "a"), [{ text: "Hello", hit: false }]);
});

test("subOf extracts nested collection subfolders", () => {
  assert.equal(subOf("travel/japan", "travel"), "japan");
  assert.equal(subOf("travel", "travel"), "");
  assert.equal(subOf("work/notes", "travel"), "");
});

test("multi-selection toggle, shift-range and prune", () => {
  const ordered = [10, 20, 30, 40, 50];
  let s = toggleSelection(new Set(), 20);
  assert.deepEqual([...s], [20]);
  s = rangeSelection(s, ordered, 20, 40);
  assert.deepEqual([...s], [20, 30, 40]);
  s = rangeSelection(s, ordered, 40, 10);
  assert.deepEqual([...s].sort((a, b) => a - b), [10, 20, 30, 40]);
  s = toggleSelection(s, 30);
  assert.deepEqual([...s].sort((a, b) => a - b), [10, 20, 40]);
  assert.deepEqual([...pruneSelection(s, [20, 40, 50])], [20, 40]);
});
