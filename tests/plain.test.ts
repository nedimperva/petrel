// Previews show a note as the page does, without its Markdown marks (`npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { plainLine } from "../src/notes/plain.ts";

test("marks are taken out of a preview line", () => {
  assert.equal(plainLine("See [[Tern release]] for the checklist."), "See Tern release for the checklist.");
  assert.equal(plainLine("[[Notes/Tern release|the release]] and **bold** and *it* and `code`"), "the release and bold and it and code");
  assert.equal(plainLine("- [ ] Call the bank"), "☐ Call the bank");
  assert.equal(plainLine("- [x] Done"), "☑ Done");
  assert.equal(plainLine("- milk"), "• milk");
  assert.equal(plainLine("## Heading"), "Heading");
  assert.equal(plainLine("> a quote"), "a quote");
  assert.equal(plainLine("a [link](https://x.example) here ![pic](a.png)"), "a link here ");
  assert.equal(plainLine("snake_case_name and 2*3*4"), "snake_case_name and 2*3*4");
});

test("a preview keeps the note's shape: headings, items and tasks each on a line", async () => {
  const { previewLines } = await import("../src/notes/plain.ts");
  const lines = previewLines("The Linux beta is out.\nNext is Windows.\n\n## Open questions\n\n- Do we ship the [[AUR]] package?\n  - [ ] Ask Amra\n- [x] Icon done\n\nA second paragraph.");
  assert.deepEqual(lines, [
    { kind: "text", text: "The Linux beta is out. Next is Windows.", depth: 0 },
    { kind: "heading", text: "Open questions", depth: 0 },
    { kind: "item", text: "Do we ship the AUR package?", depth: 0 },
    { kind: "task", text: "Ask Amra", depth: 1 },
    { kind: "done", text: "Icon done", depth: 0 },
    { kind: "text", text: "A second paragraph.", depth: 0 },
  ]);
});
