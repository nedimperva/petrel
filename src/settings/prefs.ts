// The UI's preferences, stored in the database as `ui.*` settings so every window follows them. Read once at
// start; the Settings dialog writes them one by one.

import { createSignal } from "solid-js";

export type Theme = "system" | "light" | "dark";

export interface Prefs {
  theme: Theme;
  /** Writing type size in px. */
  editorSize: number;
  /** Keep the line being typed in the middle of the window. */
  typewriter: boolean;
}

export const DEFAULTS: Prefs = { theme: "system", editorSize: 18, typewriter: false };

export const SIZES = [15, 16, 17, 18, 19, 20, 22];

const KEYS: Record<keyof Prefs, string> = {
  theme: "ui.theme",
  editorSize: "ui.editor_size",
  typewriter: "ui.typewriter",
};

/** Stored strings to preferences. Anything unreadable falls back to the default, never to an error. */
export function parsePrefs(m: Record<string, string>): Prefs {
  const n = Number(m[KEYS.editorSize]);
  const size = m[KEYS.editorSize] !== undefined && Number.isFinite(n) && n >= 12 && n <= 28 ? Math.round(n) : DEFAULTS.editorSize;
  const t = m[KEYS.theme];
  return {
    theme: t === "light" || t === "dark" || t === "system" ? t : DEFAULTS.theme,
    editorSize: size,
    typewriter: m[KEYS.typewriter] === "1",
  };
}

export function storedValue<K extends keyof Prefs>(key: K, value: Prefs[K]): [string, string] {
  return [KEYS[key], typeof value === "boolean" ? (value ? "1" : "0") : String(value)];
}

/** Type size and theme are CSS variables and an attribute, so every window follows without touching CodeMirror. */
export function applyPrefs(p: Prefs) {
  const root = document.documentElement;
  root.style.setProperty("--editor-size", `${p.editorSize}px`);
  if (p.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = p.theme;
}

export const [prefs, setPrefs] = createSignal<Prefs>(DEFAULTS);
