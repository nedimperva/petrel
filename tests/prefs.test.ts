// The UI preferences' parsing (`npm test`): stored strings never break the window.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clockTheme, DEFAULTS, parsePrefs, storedValue } from "../src/settings/prefs.ts";

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
  assert.deepEqual(parsePrefs(m), { ...DEFAULTS, theme: "dark", typewriter: true, editorSize: 20 });
});

test("the joys: paper by the clock, fonts, switches", () => {
  assert.equal(clockTheme(8), "light");
  assert.equal(clockTheme(20), "linen");
  assert.equal(clockTheme(23), "dark");
  assert.equal(clockTheme(3), "dark");
  const p = parsePrefs({ "ui.theme": "linen", "ui.write_font": "comic", "ui.sound": "1", "ui.capture_selection": "0" });
  assert.equal(p.theme, "linen");
  assert.equal(p.writeFont, "literata");
  assert.equal(p.sound, true);
  assert.equal(p.petrel, true);
  assert.equal(p.captureSelection, false);
});
