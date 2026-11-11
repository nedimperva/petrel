// The UI's preferences, stored in the database as `ui.*` settings so every window follows them. Read once at
// start; the Settings dialog writes them one by one.

import { createSignal } from "solid-js";

/** `system` follows the OS; `clock` is Paper by day, Linen after sunset, Night late. */
export type Theme = "system" | "light" | "linen" | "dark" | "clock";
export type WriteFont = "literata" | "serif" | "inter" | "mono";

export interface Prefs {
  theme: Theme;
  /** Writing type size in px. */
  editorSize: number;
  /** Keep the line being typed in the middle of the window. */
  typewriter: boolean;
  writeFont: WriteFont;
  /** The petrel crosses the page once when the inbox is clear. */
  petrel: boolean;
  /** A soft pencil sound as you type. */
  sound: boolean;
  /** Bring the text selected in the app you were in into a capture (the Rust side reads this key too). */
  captureSelection: boolean;
}

export const DEFAULTS: Prefs = {
  theme: "system",
  editorSize: 18,
  typewriter: false,
  writeFont: "literata",
  petrel: true,
  sound: false,
  captureSelection: true,
};

export const SIZES = [15, 16, 17, 18, 19, 20, 22];
export const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Paper" },
  { id: "linen", label: "Linen" },
  { id: "dark", label: "Night" },
  { id: "clock", label: "Follow the clock" },
];
export const FONTS: { id: WriteFont; label: string; css: string }[] = [
  { id: "literata", label: "Literata", css: "var(--font-write)" },
  { id: "serif", label: "Charter", css: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif' },
  { id: "inter", label: "Inter", css: "var(--font-ui)" },
  { id: "mono", label: "JetBrains Mono", css: "var(--font-mono)" },
];

const KEYS: Record<keyof Prefs, string> = {
  theme: "ui.theme",
  editorSize: "ui.editor_size",
  typewriter: "ui.typewriter",
  writeFont: "ui.write_font",
  petrel: "ui.petrel",
  sound: "ui.sound",
  captureSelection: "ui.capture_selection",
};

const flag = (v: string | undefined, d: boolean) => (v === "1" ? true : v === "0" ? false : d);

/** Stored strings to preferences. Anything unreadable falls back to the default, never to an error. */
export function parsePrefs(m: Record<string, string>): Prefs {
  const n = Number(m[KEYS.editorSize]);
  const size = m[KEYS.editorSize] !== undefined && Number.isFinite(n) && n >= 12 && n <= 28 ? Math.round(n) : DEFAULTS.editorSize;
  const t = m[KEYS.theme];
  const f = m[KEYS.writeFont];
  return {
    theme: THEMES.some((x) => x.id === t) ? (t as Theme) : DEFAULTS.theme,
    editorSize: size,
    typewriter: m[KEYS.typewriter] === "1",
    writeFont: FONTS.some((x) => x.id === f) ? (f as WriteFont) : DEFAULTS.writeFont,
    petrel: flag(m[KEYS.petrel], DEFAULTS.petrel),
    sound: flag(m[KEYS.sound], DEFAULTS.sound),
    captureSelection: flag(m[KEYS.captureSelection], DEFAULTS.captureSelection),
  };
}

export function storedValue<K extends keyof Prefs>(key: K, value: Prefs[K]): [string, string] {
  return [KEYS[key], typeof value === "boolean" ? (value ? "1" : "0") : String(value)];
}

/** The paper the clock picks: Paper from 7:00, Linen from 19:00, Night from 23:00 until morning. */
export function clockTheme(hour: number): "light" | "linen" | "dark" {
  if (hour >= 7 && hour < 19) return "light";
  if (hour >= 19 && hour < 23) return "linen";
  return "dark";
}

let clockTimer: ReturnType<typeof setInterval> | undefined;

/** Type size, font and paper are CSS variables and an attribute, so every window follows without touching
 * CodeMirror. */
export function applyPrefs(p: Prefs) {
  const root = document.documentElement;
  root.style.setProperty("--editor-size", `${p.editorSize}px`);
  root.style.setProperty("--editor-font", FONTS.find((f) => f.id === p.writeFont)?.css ?? "var(--font-write)");
  clearInterval(clockTimer);
  const set = (t: string | null) => (t ? (root.dataset.theme = t) : delete root.dataset.theme);
  if (p.theme === "system") set(null);
  else if (p.theme === "clock") {
    set(clockTheme(new Date().getHours()));
    clockTimer = setInterval(() => set(clockTheme(new Date().getHours())), 60_000);
  } else set(p.theme);
  root.classList.toggle("no-petrel", !p.petrel);
}

export const [prefs, setPrefs] = createSignal<Prefs>(DEFAULTS);
