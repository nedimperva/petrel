// Fill-in blanks and the plain-text copy (`npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { blanks, fill, parts } from "../src/blanks.ts";
import { plainText, titleFrom, wordCount } from "../src/copy.ts";

test("blanks are found once each, in order, with defaults", () => {
  const t = "Review {{ language }} code: {{code}}. Again in {{language}}. {{tone|direct}} \\{{not}}";
  assert.deepEqual(blanks(t), [
    { name: "language", value: "" },
    { name: "code", value: "" },
    { name: "tone", value: "direct" },
  ]);
});

test("fill replaces every use and keeps unfilled blanks visible", () => {
  const t = "Hi {{name}}, {{name}}! {{day}} {{tone|kind}} \\{{x}}";
  assert.equal(fill(t, { name: "Amra" }), "Hi Amra, Amra! {{day}} kind {{x}}");
});

test("parts split text and blanks for drawing", () => {
  assert.deepEqual(parts("a {{b}} c"), [
    { text: "a ", blank: false },
    { text: "b", blank: true },
    { text: " c", blank: false },
  ]);
});

test("plain text takes the Markdown marks out", () => {
  const md = "# Title\n\n- [ ] **buy** milk\n- see [[Garden|the garden]] and [site](https://x.y)\n> quoted `code`";
  assert.equal(plainText(md), "Title\n\nbuy milk\n• see the garden and site (https://x.y)\nquoted code");
});

test("titles come from the first line with words", () => {
  assert.equal(titleFrom("\n\n## Call the bank: card / PIN\nmore"), "Call the bank card PIN");
  assert.equal(titleFrom("   "), "Untitled");
  assert.ok(titleFrom("word ".repeat(40)).length <= 60);
  assert.equal(wordCount("Kad ja pođoh na Bembašu, it's 2 o'clock"), 8);
});

test("answers are escaped before any formatting", async () => {
  const { answerHtml } = await import("../src/copy.ts");
  assert.equal(answerHtml("**Garden** <img src=x onerror=alert(1)>"), "<b>Garden</b> &lt;img src=x onerror=alert(1)&gt;");
  assert.equal(answerHtml("- see [[Garden]]"), '• see <span class="cm-wikilink">Garden</span>');
});
