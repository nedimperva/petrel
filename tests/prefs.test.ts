// The UI preferences' parsing (`npm test`): stored strings never break the window.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, parsePrefs, storedValue } from "../src/settings/prefs.ts";

test("nothing stored is the defaults", () => {
  assert.deepEqual(parsePrefs({}), DEFAULTS);
});

test("bad values fall back one by one", () => {
  const p = parsePrefs({ "ui.theme": "sepia", "ui.editor_size": "19" });
  assert.equal(p.theme, "system");
  assert.equal(p.editorSize, 19);
  assert.equal(parsePrefs({ "ui.editor_size": "-3" }).editorSize, DEFAULTS.editorSize);
});

test("stored values round-trip", () => {
  const m = Object.fromEntries([storedValue("theme", "dark"), storedValue("typewriter", true), storedValue("editorSize", 20)]);
  assert.deepEqual(parsePrefs(m), { theme: "dark", typewriter: true, editorSize: 20 });
});
