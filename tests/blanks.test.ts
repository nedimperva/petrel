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
  assert.equal(answerHtml("- see [[Garden]]"), '• see <span class="cm-wikilink" data-title="Garden">Garden</span>');
});

test("blanks that fill themselves, and choices", async () => {
  const { startValue, rememberAnswers } = await import("../src/blanks.ts");
  const list = blanks("{{clipboard}} {{today}} {{selection|none}} {{tone: formal / casual / blunt}} {{ratio:1}}");
  assert.deepEqual(list, [
    { name: "clipboard", value: "", auto: "clipboard" },
    { name: "today", value: "", auto: "today" },
    { name: "selection", value: "none" },
    { name: "tone", value: "formal", choices: ["formal", "casual", "blunt"] },
    { name: "ratio:1", value: "" },
  ]);
  assert.equal(fill("Be {{tone: formal / casual}}.", {}), "Be formal.");
  assert.equal(fill("Be {{tone: formal / casual}}.", { tone: "casual" }), "Be casual.");
  assert.deepEqual(parts("A {{tone: a / b}}!").map((x) => x.text), ["A ", "tone", "!"]);
  assert.equal(startValue(list[0], ["old"], { clipboard: "copied" }), "copied");
  assert.equal(startValue(list[3], ["casual", "x"], {}), "casual");
  assert.equal(startValue(list[3], ["x"], {}), "formal");
  assert.equal(startValue({ name: "lang", value: "" }, ["Rust", "Go"], {}), "Rust");
  assert.equal(startValue({ name: "lang", value: "TS" }, ["Rust"], {}), "TS");
});

test("answers are remembered, newest first, five at most", async () => {
  const { rememberAnswers } = await import("../src/blanks.ts");
  const list = blanks("{{lang}} {{clipboard}} {{empty}}");
  let m = { lang: ["Go", "Rust", "C", "Zig", "Odin"] };
  m = rememberAnswers(m, list, { lang: "Rust", clipboard: "secret", empty: "" });
  assert.deepEqual(m, { lang: ["Rust", "Go", "C", "Zig", "Odin"] });
  m = rememberAnswers(m, list, { lang: "TS" });
  assert.deepEqual(m.lang, ["TS", "Rust", "Go", "C", "Zig"]);
});

test("versions on one card", async () => {
  const { versionsOf, lastFirst, hasVersions } = await import("../src/collection/versions.ts");
  assert.deepEqual(versionsOf("Just one\n\n## Heading\ntext"), []);
  const v = versionsOf("## Short\nFix {{code}}\n\n## Long\nReview this\n```\n## not a version\n```\n");
  assert.deepEqual(
    v.map((x) => x.name),
    ["Short", "Long"],
  );
  assert.equal(v[1].text, "Review this\n```\n## not a version\n```");
  assert.deepEqual(
    versionsOf("Intro words\n## A\na\n## B\nb").map((x) => x.name),
    ["First", "A", "B"],
  );
  assert.deepEqual(
    lastFirst(v, "Long").map((x) => x.name),
    ["Long", "Short"],
  );
  assert.ok(hasVersions("Prompts") && hasVersions("snippets/shell") && !hasVersions("Travel"));
});

test("collections are pages or things to copy", async () => {
  const { toCopy } = await import("../src/library/faces.ts");
  assert.ok(toCopy("Prompts") && toCopy("Snippets/shell") && toCopy("Email templates"));
  assert.ok(!toCopy("Travel") && !toCopy("") && !toCopy("inbox") && !toCopy("journal"));
  assert.ok(toCopy("Songs", { Songs: { color: "", mark: "", copy: "yes" } }));
  assert.ok(!toCopy("Prompts", { Prompts: { color: "", mark: "", copy: "no" } }));
});
