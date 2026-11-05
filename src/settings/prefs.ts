// The UI's preferences, stored in the database as `ui.*` settings so they survive a reinstall of the webview's
// storage and apply to every window. Read once at start; the Settings dialog writes them one by one.

import { createSignal } from "solid-js";

export type NewDraftWhen = "away" | "always" | "never";
export type EditorFont = "sans" | "serif" | "mono";

export interface Prefs {
  /** Coming back to the window: a new draft after `awayMinutes` away, every time, or never. */
  newDraft: NewDraftWhen;
  awayMinutes: number;
  /** Editor type size in px. */
  editorSize: number;
  editorFont: EditorFont;
  /** Keep the line being typed in the middle of the window. */
  typewriter: boolean;
}

export const DEFAULTS: Prefs = { newDraft: "away", awayMinutes: 10, editorSize: 17, editorFont: "sans", typewriter: false };

export const SIZES = [14, 15, 16, 17, 18, 20, 22];

/** "Always" still waits this long, so a dialog or a quick glance elsewhere doesn't throw the draft away. */
export const ALWAYS_AWAY_MS = 2000;

const KEYS: Record<keyof Prefs, string> = {
  newDraft: "ui.new_draft",
  awayMinutes: "ui.new_after_min",
  editorSize: "ui.editor_size",
  editorFont: "ui.editor_font",
  typewriter: "ui.typewriter",
};

/** Stored strings to preferences. Anything unreadable falls back to the default, never to an error. */
export function parsePrefs(m: Record<string, string>): Prefs {
  const num = (v: string | undefined, lo: number, hi: number, d: number) => {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : d;
  };
  const one = <T extends string>(v: string | undefined, all: readonly T[], d: T): T =>
    (all as readonly string[]).includes(v ?? "") ? (v as T) : d;
  return {
    newDraft: one(m[KEYS.newDraft], ["away", "always", "never"] as const, DEFAULTS.newDraft),
    awayMinutes: num(m[KEYS.awayMinutes], 1, 24 * 60, DEFAULTS.awayMinutes),
    editorSize: num(m[KEYS.editorSize], 12, 28, DEFAULTS.editorSize),
    editorFont: one(m[KEYS.editorFont], ["sans", "serif", "mono"] as const, DEFAULTS.editorFont),
    typewriter: m[KEYS.typewriter] === "1",
  };
}

export function storedValue<K extends keyof Prefs>(key: K, value: Prefs[K]): [string, string] {
  return [KEYS[key], typeof value === "boolean" ? (value ? "1" : "0") : String(value)];
}

/** How long away opens a new draft; null for never. */
export function awayThreshold(p: Prefs): number | null {
  if (p.newDraft === "never") return null;
  if (p.newDraft === "always") return ALWAYS_AWAY_MS;
  return p.awayMinutes * 60_000;
}

const FONTS: Record<EditorFont, string> = {
  sans: "var(--font-ui)",
  serif: 'Charter, "Iowan Old Style", Georgia, Cambria, serif',
  mono: "var(--font-mono)",
};

/** The editor reads its type from CSS variables, so both windows follow without touching CodeMirror. */
export function applyEditorPrefs(p: Prefs) {
  const root = document.documentElement.style;
  root.setProperty("--editor-size", `${p.editorSize}px`);
  root.setProperty("--editor-font", FONTS[p.editorFont]);
}

export const [prefs, setPrefs] = createSignal<Prefs>(DEFAULTS);
