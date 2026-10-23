// Action shortcuts: how they are written, matched and checked against Petrel's own keys (ui.md §5).
// A bare key (`c`, `#`, `F5`) runs the action when the action list has focus; a chord with Ctrl or Alt
// (`Ctrl+Alt+J`) runs it anywhere, the editor included.

/** Petrel's own chords, which an action may not take. Editor keys from CodeMirror's defaults are included. */
const RESERVED_CHORDS = [
  "Ctrl+N", "Ctrl+L", "Ctrl+K", "Ctrl+1", "Ctrl+2", "Ctrl+Enter", "Ctrl+Shift+A", "Ctrl+E", "Ctrl+Shift+3",
  "Ctrl+Shift+F", "Ctrl+Shift+D", "Ctrl+Shift+L", "Ctrl+T", "Ctrl+H", "Ctrl+Shift+P", "Ctrl+,", "Ctrl+Q",
  "Ctrl+B", "Ctrl+I", "Ctrl+Shift+K", "Ctrl+Shift+X", "Ctrl+Shift+8", "Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z",
  "Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+F", "Ctrl+G", "Ctrl+Shift+G", "Ctrl+D", "Ctrl+[", "Ctrl+]",
  "Ctrl+/", "Ctrl+Home", "Ctrl+End", "Alt+ArrowUp", "Alt+ArrowDown", "Shift+Alt+ArrowDown",
].map((s) => s.toLowerCase());

/** Keys the action list uses itself. */
const RESERVED_BARE = ["j", "k", "g", "enter", "escape", "arrowup", "arrowdown", " ", "tab"];

/** Letters and digits by physical key, so Shift and the layout's symbols don't change the name. */
function keyName(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/** The shortcut a key press spells, or null for a lone modifier. */
export function fromEvent(e: KeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(e.key)) return null;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl && !e.altKey) return e.key;
  const mods = [ctrl && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt"].filter(Boolean);
  return [...mods, keyName(e)].join("+");
}

export const isChord = (s: string) => /(^|\+)(Ctrl|Alt)\+./.test(s);

/** Chords compare without case; bare keys compare exactly (`c` and `C` differ). */
export function same(a: string, b: string): boolean {
  return isChord(a) || isChord(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Why `s` cannot be used, or null. `others` are the other actions' shortcuts by name. */
export function conflict(s: string, others: { name: string; shortcut: string | null }[]): string | null {
  if (isChord(s)) {
    if (RESERVED_CHORDS.includes(s.toLowerCase())) return `${s} is one of Petrel's keys`;
  } else if (RESERVED_BARE.includes(s.toLowerCase())) {
    return `${s} moves or runs in the action list`;
  }
  const taken = others.find((o) => o.shortcut && same(o.shortcut, s));
  return taken ? `${taken.name} uses ${s}` : null;
}

/** Keycaps for display: `Ctrl+Alt+J` → ["Ctrl", "Alt", "J"]. */
export const caps = (s: string) => (isChord(s) ? s.split("+") : [s]);
