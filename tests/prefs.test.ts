// The UI preferences' parsing (`npm test`): stored strings never break the window.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awayThreshold, DEFAULTS, parsePrefs, storedValue } from "../src/settings/prefs.ts";

test("nothing stored is the defaults", () => {
  assert.deepEqual(parsePrefs({}), DEFAULTS);
});

test("bad values fall back one by one", () => {
  const p = parsePrefs({ "ui.new_draft": "sometimes", "ui.new_after_min": "-3", "ui.editor_size": "19", "ui.editor_font": "mono" });
  assert.equal(p.newDraft, "away");
  assert.equal(p.awayMinutes, 10);
  assert.equal(p.editorSize, 19);
  assert.equal(p.editorFont, "mono");
});

test("stored values round-trip", () => {
  const m = Object.fromEntries([
    storedValue("newDraft", "never"),
    storedValue("awayMinutes", 30),
    storedValue("typewriter", true),
  ]);
  const p = parsePrefs(m);
  assert.equal(p.newDraft, "never");
  assert.equal(p.awayMinutes, 30);
  assert.equal(p.typewriter, true);
});

test("away threshold", () => {
  assert.equal(awayThreshold({ ...DEFAULTS, newDraft: "never" }), null);
  assert.equal(awayThreshold({ ...DEFAULTS, awayMinutes: 5 }), 300_000);
  assert.ok(awayThreshold({ ...DEFAULTS, newDraft: "always" })! < 10_000);
});
