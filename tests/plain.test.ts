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
