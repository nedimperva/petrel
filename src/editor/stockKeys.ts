// The editor library's own keys, minus the ones that surprise in a notes app or clash with Petrel's keys. Kept
// in a file of its own so a test can check that no stock key shares a press with a key in `src/keys.ts`.
//
// Dropped, and why:
// - Mod-/ and Alt-A comment the line out (`<!-- -->`), which means nothing in a note; Ctrl / is the shortcut list.
// - Mod-d (select the next match) and Mod-l / Alt-l (select the line) take Ctrl D and Ctrl L, today and the library.
// - Ctrl-m makes Tab leave the editor until pressed again; Ctrl M is Move.
// - Alt-ArrowLeft/Right jump by syntax; on a day's page they go to the day before or after.
// - Mod-Alt-g and Mod-Alt-\ are AltGr G and AltGr Q on many layouts (`]` and `\` in Bosnian).
// - Mod-Enter adds a blank line; in the capture window Ctrl Enter starts a new capture.

import type { KeyBinding } from "@codemirror/view";
import { defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";

export const DROPPED = new Set(["Mod-/", "Alt-A", "Mod-d", "Mod-l", "Alt-l", "Ctrl-m", "Alt-ArrowLeft", "Alt-ArrowRight", "Mod-Alt-g", "Mod-Alt-\\", "Mod-Enter"]);

const keep = (b: KeyBinding) => !b.key || !DROPPED.has(b.key);

export const stockKeys: readonly KeyBinding[] = [...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab].filter(keep);

/** A library key name (`Shift-Mod-k`) as `src/keys.ts` writes keys (`Ctrl+Shift+K`), for the clash test. */
export function asCombo(name: string): string {
  const parts = name.split("-");
  let key = parts.pop() ?? "";
  if (key === "" && name.endsWith("-")) key = "-";
  const mods = new Set(parts.map((m) => (m === "Mod" || m === "Ctrl" ? "Ctrl" : m)));
  if (key.length === 1) key = key.toUpperCase();
  return [...["Ctrl", "Alt", "Shift"].filter((m) => mods.has(m)), key].join("+");
}
