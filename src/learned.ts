// Key hints that step aside once learned: each modifier key pressed is counted (`ui.keys_used`), and a hint whose
// key has been pressed ten times leaves the key line at the foot of the screens. Ctrl / still lists every key, and
// Settings › Keys brings the hints back. Counts stay on this computer; they are only numbers per key label.

import { createSignal } from "solid-js";

export const USED_KEY = "ui.keys_used";
/** Presses after which a key's hint is no longer shown. */
export const LEARNED_AT = 10;

const [used, setUsed] = createSignal<Record<string, number>>({});
export { used as keysUsed };

let store: ((key: string, value: string) => Promise<void>) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Reads the counts and starts counting presses. `save` writes a UI setting. */
export function learnKeys(stored: string | undefined, save: (key: string, value: string) => Promise<void>): () => void {
  setUsed(parseUsed(stored));
  store = save;
  const down = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey || e.altKey) || ["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
    count(labelOf(e));
  };
  addEventListener("keydown", down, true);
  return () => removeEventListener("keydown", down, true);
}

/** `Ctrl K`, as the hints write keys. */
export function labelOf(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  let k = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (e.shiftKey && k === "?") k = "/";
  return [...mods, k].join(" ");
}

function count(label: string) {
  const next = { ...used(), [label]: Math.min((used()[label] ?? 0) + 1, 999) };
  setUsed(next);
  clearTimeout(timer);
  timer = setTimeout(() => void store?.(USED_KEY, JSON.stringify(next)).catch(() => {}), 5000);
}

export function parseUsed(text: string | undefined): Record<string, number> {
  try {
    const v = JSON.parse(text ?? "{}");
    if (!v || typeof v !== "object") return {};
    return Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "number")) as Record<string, number>;
  } catch {
    return {};
  }
}

/** Whether a hint's keys are learned. Keys without a modifier (Enter, Esc, letters in a list) always show. */
export function learned(keys: string, counts: Record<string, number> = used()): boolean {
  return /^(Ctrl|Alt)\b/.test(keys) && (counts[keys] ?? 0) >= LEARNED_AT;
}

/** Every hint back. */
export async function forgetKeys() {
  setUsed({});
  await store?.(USED_KEY, "{}");
}
