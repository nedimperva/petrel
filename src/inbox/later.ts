// Captures kept for later in the review: by path, until the next morning, in the `ui.review.later` setting. Pure,
// for `npm test`.

export function parseLater(raw: string | undefined): Record<string, number> {
  try {
    const v = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, t]) => typeof t === "number")) as Record<string, number>;
  } catch {
    return {};
  }
}

/** The paths still kept away at `now`. */
export function laterOf(later: Record<string, number>, now = Date.now()): Set<string> {
  return new Set(Object.entries(later).filter(([, t]) => t > now).map(([p]) => p));
}

/** Keeps `path` away until the next local midnight; ones whose day has passed are dropped. */
export function keepUntil(later: Record<string, number>, path: string, now = new Date()): Record<string, number> {
  const until = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const out = Object.fromEntries(Object.entries(later).filter(([, t]) => t > now.getTime()));
  out[path] = until;
  return out;
}
