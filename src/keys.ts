// Every shortcut in one place: what it does, where it works, and its key on Windows and on Omarchy (Linux). The
// app's own shortcuts can be changed in Settings › Keys; the changes live in the notes folder (`.petrel-keys.json`)
// so both computers see both columns. Global hotkeys (capture, picker) are the system's: Windows takes them from
// Settings, Hyprland from a `bind` line in its config. Pure apart from the signal, for `npm test`.

import { createSignal } from "solid-js";

export type Platform = "win" | "linux";
export const platform: Platform = typeof navigator !== "undefined" && navigator.userAgent.includes("Linux") ? "linux" : "win";

export type Group = "Anywhere" | "Writing" | "Library" | "Capture window" | "Quick picker" | "Lists and menus";

export interface Shortcut {
  id: string;
  label: string;
  group: Group;
  /** The key on each system, as `Ctrl+Shift+K`. */
  keys: Record<Platform, string>;
  /** Changeable in Settings. The rest are the grammar (Enter, Esc, arrows) or letters in a list. */
  editable?: boolean;
  /** Bound by the system, not the app: Windows registers it, Hyprland needs a `bind` line. */
  global?: "capture" | "picker";
}

const both = (k: string) => ({ win: k, linux: k });

export const SHORTCUTS: Shortcut[] = [
  { id: "capture", label: "Quick capture, from any app", group: "Anywhere", keys: { win: "Ctrl+Alt+Space", linux: "Super+N" }, editable: true, global: "capture" },
  { id: "picker", label: "Quick picker, from any app", group: "Anywhere", keys: { win: "Ctrl+Shift+Space", linux: "Super+V" }, editable: true, global: "picker" },
  { id: "find", label: "Find, run a command, or ask", group: "Anywhere", keys: both("Ctrl+K"), editable: true },
  { id: "notes", label: "Find a note", group: "Anywhere", keys: both("Ctrl+P"), editable: true },
  { id: "new", label: "New note", group: "Anywhere", keys: both("Ctrl+N"), editable: true },
  { id: "today", label: "Today's page", group: "Anywhere", keys: both("Ctrl+D"), editable: true },
  { id: "library", label: "Library", group: "Anywhere", keys: both("Ctrl+L"), editable: true },
  { id: "sidebar", label: "Show or hide the sidebar", group: "Anywhere", keys: both("Ctrl+0"), editable: true },
  { id: "back", label: "The note before (hold Ctrl for more)", group: "Anywhere", keys: both("Ctrl+Tab") },
  { id: "beside", label: "A note beside this one", group: "Anywhere", keys: both("Ctrl+Shift+Enter"), editable: true },
  { id: "settings", label: "Settings", group: "Anywhere", keys: both("Ctrl+,"), editable: true },
  { id: "shortcuts", label: "All shortcuts", group: "Anywhere", keys: both("Ctrl+/"), editable: true },
  { id: "ai", label: "Ask Claude about the text", group: "Writing", keys: both("Ctrl+J"), editable: true },
  { id: "history", label: "History of the note", group: "Writing", keys: both("Ctrl+H"), editable: true },
  { id: "move", label: "Move the note to a collection, a note or a day", group: "Writing", keys: both("Ctrl+M"), editable: true },
  { id: "copyMd", label: "Copy as Markdown", group: "Writing", keys: both("Ctrl+Shift+C"), editable: true },
  { id: "task", label: "Make a task, or tick one", group: "Writing", keys: both("Ctrl+Shift+X") },
  { id: "slash", label: "The AI menu, on an empty line", group: "Writing", keys: both("/") },
  { id: "link", label: "Link a note", group: "Writing", keys: both("[[") },
  { id: "follow", label: "Follow a link (Shift Enter: beside)", group: "Writing", keys: both("Alt+Enter") },
  { id: "days", label: "Other days, on a day's page", group: "Writing", keys: both("Alt+← / Alt+→") },
  { id: "libMove", label: "Move through the list", group: "Library", keys: both("↑ ↓ or j k") },
  { id: "libCopy", label: "Copy (in the inbox: file it)", group: "Library", keys: both("Enter") },
  { id: "libEdit", label: "Edit", group: "Library", keys: both("e") },
  { id: "libPin", label: "Pin", group: "Library", keys: both("p") },
  { id: "libLook", label: "Look, and pages or to copy", group: "Library", keys: both("t") },
  { id: "libFilter", label: "Filter", group: "Library", keys: both("/") },
  { id: "libReview", label: "The inbox one at a time", group: "Library", keys: both("r") },
  { id: "libUndo", label: "Undo the last change", group: "Library", keys: both("z") },
  { id: "capWhere", label: "Say where it goes: @recipes, @fri, @Note", group: "Capture window", keys: both("@") },
  { id: "capChoose", label: "Choose a place from a list", group: "Capture window", keys: both("Ctrl+K") },
  { id: "capDone", label: "Done", group: "Capture window", keys: both("Esc") },
  { id: "capNew", label: "A new capture, when adding to the last", group: "Capture window", keys: both("Ctrl+Enter") },
  { id: "pickCopy", label: "Copy and close", group: "Quick picker", keys: both("Enter") },
  { id: "pickVersion", label: "Other versions", group: "Quick picker", keys: both("Alt+← / Alt+→") },
  { id: "pickOpen", label: "Open in Petrel", group: "Quick picker", keys: both("Ctrl+O") },
  { id: "doIt", label: "Do it", group: "Lists and menus", keys: both("Enter") },
  { id: "backStep", label: "Back one step", group: "Lists and menus", keys: both("Esc") },
  { id: "nextField", label: "The next field", group: "Lists and menus", keys: both("Tab") },
  { id: "pick", label: "Pick from a short numbered list", group: "Lists and menus", keys: both("1 – 9") },
];

export type KeyMap = Partial<Record<Platform, Record<string, string>>>;

const [custom, setCustom] = createSignal<KeyMap>({});
export { custom as customKeys, setCustom as setCustomKeys };

/** The key for a shortcut on a system: the owner's, else the default. */
export function keyOf(id: string, on: Platform = platform, map: KeyMap = custom()): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  return map[on]?.[id] ?? s?.keys[on] ?? "";
}

/** A key press as the shortcut names write it: `Ctrl+Shift+K`, `Ctrl+,`, `Ctrl+Enter`. */
export function comboOf(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  let k = e.key;
  if (k === " ") k = "Space";
  else if (k.length === 1) k = k.toUpperCase();
  // Shift turns some keys into others (`/` into `?`): name the key by its unshifted face where it matters.
  if (e.shiftKey && k === "?") k = "/";
  return [...mods, k].join("+");
}

/** Whether a key press is this shortcut here. Only modifier shortcuts are matched: the rest belong to their screen. */
export function matches(e: KeyboardEvent, id: string): boolean {
  const want = keyOf(id);
  if (!want.includes("+")) return false;
  return comboOf(e).toLowerCase() === want.toLowerCase();
}

/** Ctrl+Alt with a letter, digit or sign is AltGr+that key on Windows, which types a character on many layouts. */
export function typesCharacter(hotkey: string): boolean {
  const parts = hotkey.split("+").map((x) => x.trim().toLowerCase());
  const key = parts[parts.length - 1] ?? "";
  const mods = parts.slice(0, -1);
  const altGr = mods.includes("alt") && (mods.includes("ctrl") || mods.includes("control"));
  return altGr && !mods.includes("shift") && (key.length === 1 || /^(key|digit)[a-z0-9]$/.test(key));
}

/** Shortcuts on one system that share a key with another changeable one. */
export function conflicts(on: Platform, map: KeyMap = custom()): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const s of SHORTCUTS.filter((x) => x.editable)) {
    const k = keyOf(s.id, on, map).toLowerCase();
    const other = seen.get(k);
    if (other) {
      out[s.id] = other;
      out[other] = s.id;
    } else seen.set(k, s.id);
  }
  return out;
}

/** The Hyprland line for a global shortcut: Hyprland, not Petrel, owns keys on Wayland. */
export function hyprBind(s: Shortcut, key: string): string {
  const parts = key.split("+");
  const k = parts.pop() ?? "";
  const mods = parts.map((m) => (m === "Ctrl" ? "CTRL" : m.toUpperCase())).join(" ");
  return `bind = ${mods}, ${k.toUpperCase()}, exec, petrel --${s.global}`;
}

/** The keys file's text, read leniently: anything unreadable is no change. */
export function parseKeyMap(text: string): KeyMap {
  try {
    const v = JSON.parse(text);
    const out: KeyMap = {};
    for (const on of ["win", "linux"] as const) {
      const m = v?.[on];
      if (m && typeof m === "object") out[on] = Object.fromEntries(Object.entries(m).filter(([, k]) => typeof k === "string")) as Record<string, string>;
    }
    return out;
  } catch {
    return {};
  }
}
