// First steps: five things to try, on the empty page the first time Petrel opens, each ticked as you do it. Gone
// when all five are done or you hide them; Ctrl K's "First steps" brings them back. Kept in `ui.first_steps`.

import { createSignal } from "solid-js";
import { matches } from "./keys";

export type Step = "find" | "capture" | "today" | "copy" | "ai";
export const STEPS: { id: Step; key: string; text: string }[] = [
  { id: "find", key: "find", text: "Find a note, run a command, or ask your notes" },
  { id: "capture", key: "capture", text: "Capture from any app; @recipes or @fri says where it goes" },
  { id: "today", key: "today", text: "Write on today's page; each entry starts with the time" },
  { id: "copy", key: "library", text: "Copy a card from the library; {{blanks}} are asked first" },
  { id: "ai", key: "ai", text: "Select a sentence and ask Claude to tidy or explain it" },
];
export const STEPS_KEY = "ui.first_steps";

interface State {
  done: Step[];
  hidden: boolean;
}
const [state, setState] = createSignal<State>({ done: [], hidden: true });
export { state as firstSteps };

let save: ((key: string, value: string) => Promise<void>) | null = null;

export function parseSteps(text: string | undefined): State {
  if (text === undefined) return { done: [], hidden: false };
  try {
    const v = JSON.parse(text);
    const done = Array.isArray(v?.done) ? (v.done as unknown[]).filter((x): x is Step => STEPS.some((s) => s.id === x)) : [];
    return { done, hidden: !!v?.hidden || done.length >= STEPS.length };
  } catch {
    return { done: [], hidden: true };
  }
}

const write = (s: State) => {
  setState(s);
  void save?.(STEPS_KEY, JSON.stringify(s)).catch(() => {});
};

/** Reads the steps and listens for the keys that do them. */
export function startSteps(stored: string | undefined, store: (key: string, value: string) => Promise<void>): () => void {
  save = store;
  setState(parseSteps(stored));
  const down = (e: KeyboardEvent) => {
    if (state().hidden) return;
    for (const id of ["find", "today", "ai"] as const) if (matches(e, id)) stepDone(id);
  };
  addEventListener("keydown", down, true);
  return () => removeEventListener("keydown", down, true);
}

export function stepDone(id: Step) {
  const s = state();
  if (s.hidden || s.done.includes(id)) return;
  const done = [...s.done, id];
  write({ done, hidden: done.length >= STEPS.length });
}

export const hideSteps = () => write({ ...state(), hidden: true });
export const showSteps = () => write({ done: [], hidden: false });
