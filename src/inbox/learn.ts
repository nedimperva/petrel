// Where captures were filed before, so the review and the capture window offer those places first. Kept as one
// `ui.filed` setting: a few counts, not a history.

import type { Target } from "./Destination";

export type Counts = Record<string, { n: number; at: number }>;

const KEEP = 24;

export const keyOf = (t: Target) => (t.kind === "note" ? `note:${t.id}` : t.kind === "folder" ? `folder:${t.folder}` : "day");

export function parseCounts(raw: string | undefined): Counts {
  try {
    const v = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Counts = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const r = x as { n?: unknown; at?: unknown };
      if (typeof r?.n === "number" && typeof r?.at === "number") out[k] = { n: r.n, at: r.at };
    }
    return out;
  } catch {
    return {};
  }
}

/** One more filing to `t`. The least used fall off past `KEEP`. */
export function bump(c: Counts, t: Target, now = Date.now()): Counts {
  const k = keyOf(t);
  const next = { ...c, [k]: { n: (c[k]?.n ?? 0) + 1, at: now } };
  const keys = Object.keys(next).sort((a, b) => score(next[b], now) - score(next[a], now));
  return Object.fromEntries(keys.slice(0, KEEP).map((x) => [x, next[x]]));
}

/** Often and lately both count: a place used this hour beats one used a lot last year. */
export function score(r: { n: number; at: number } | undefined, now = Date.now()): number {
  if (!r) return 0;
  const days = Math.max(0, (now - r.at) / 86400000);
  return r.n / (1 + days / 7) + (days < 1 / 24 ? 100 : 0);
}
