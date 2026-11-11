// The shortcut registry: key names, changes, clashes and Hyprland lines (`npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { comboOf, conflicts, hyprBind, keyOf, parseKeyMap, SHORTCUTS, typesCharacter } from "../src/keys.ts";

const ev = (key: string, o: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });

test("key presses are named the way shortcuts are written", () => {
  assert.equal(comboOf(ev("k", { ctrlKey: true })), "Ctrl+K");
  assert.equal(comboOf(ev("C", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+C");
  assert.equal(comboOf(ev(" ", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+Space");
  assert.equal(comboOf(ev("?", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+/");
  assert.equal(comboOf(ev(",", { metaKey: true })), "Ctrl+,");
});

test("the owner's keys win, per system, and clashes are found", () => {
  const map = { win: { find: "Ctrl+Shift+F" }, linux: { find: "Ctrl+Space" } };
  assert.equal(keyOf("find", "win", map), "Ctrl+Shift+F");
  assert.equal(keyOf("find", "linux", map), "Ctrl+Space");
  assert.equal(keyOf("notes", "win", map), "Ctrl+P");
  const clash = conflicts("win", { win: { notes: "Ctrl+K" } });
  assert.equal(clash.notes, "find");
  assert.equal(Object.keys(conflicts("win", {})).length, 0);
  assert.deepEqual(parseKeyMap('{"win":{"find":"Ctrl+F","bad":3}}'), { win: { find: "Ctrl+F" } });
  assert.deepEqual(parseKeyMap("not json"), {});
});

test("AltGr keys are flagged; Hyprland gets a bind line", () => {
  assert.ok(typesCharacter("Ctrl+Alt+V"));
  assert.ok(!typesCharacter("Ctrl+Alt+Space") && !typesCharacter("Ctrl+Shift+V") && !typesCharacter("Ctrl+Alt+Shift+V"));
  const picker = SHORTCUTS.find((s) => s.id === "picker")!;
  assert.equal(hyprBind(picker, "Super+V"), "bind = SUPER, V, exec, petrel --picker");
  assert.equal(hyprBind(picker, "Ctrl+Shift+Space"), "bind = CTRL SHIFT, SPACE, exec, petrel --picker");
});
