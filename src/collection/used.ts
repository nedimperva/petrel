// Where each card was copied last, as `{path: [app, at]}`: parsing and adding, pure for `npm test`. lastUsed.ts
// keeps it in the `ui.used` setting.

/** Enough for every card anyone keeps; the oldest go first. */
const MAX = 500;

export type Used = Record<string, [string, number]>;

export function parseUsed(text: string | undefined): Used {
  try {
    const v = JSON.parse(text ?? "{}");
    if (!v || typeof v !== "object") return {};
    const out: Used = {};
    for (const [k, x] of Object.entries(v)) if (Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "number") out[k] = [x[0], x[1]];
    return out;
  } catch {
    return {};
  }
}

/** Adds one use, dropping the oldest past the limit. Pure, for the tests. */
export function addUse(used: Used, path: string, app: string, at: number): Used {
  const next = { ...used, [path]: [app, at] as [string, number] };
  const keys = Object.keys(next);
  if (keys.length <= MAX) return next;
  keys.sort((a, b) => next[a][1] - next[b][1]);
  for (const k of keys.slice(0, keys.length - MAX)) delete next[k];
  return next;
}
