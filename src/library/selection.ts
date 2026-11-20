// Pure multi-selection helpers for library grids, split lists, reader and inbox.
// Kept free of runtime imports so `node --test` runs directly on this file.

/** Toggle a single id in a selection set, returning a new Set. */
export function toggleSelection(current: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Add every id in `ordered` between `anchor` and `target` (inclusive) into the selection. */
export function rangeSelection(
  current: ReadonlySet<number>,
  ordered: readonly number[],
  anchor: number | null,
  target: number,
): Set<number> {
  if (anchor === null) return toggleSelection(current, target);
  const a = ordered.indexOf(anchor);
  const b = ordered.indexOf(target);
  if (a < 0 || b < 0) return toggleSelection(current, target);
  const next = new Set(current);
  const [from, to] = a <= b ? [a, b] : [b, a];
  for (let i = from; i <= to; i++) next.add(ordered[i]);
  return next;
}

/** Keep only ids that still exist in `visible`. */
export function pruneSelection(current: ReadonlySet<number>, visible: readonly number[]): Set<number> {
  if (!current.size) return new Set();
  const allowed = new Set(visible);
  const next = new Set<number>();
  for (const id of current) if (allowed.has(id)) next.add(id);
  return next;
}
