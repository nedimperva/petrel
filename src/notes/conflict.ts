// A conflict copy, `Title (conflict 2026-11-11 2114)` (or `… 2114 2)`), is the other side of a clash: the same
// note, kept so nothing is lost until it is settled. It is found only through its note, never as a note of its own.

const COPY = / \(conflict \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)$/;

export const isConflictCopy = (title: string) => COPY.test(title);

/** Lists without the conflict copies in them. */
export const withoutCopies = <T extends { title: string }>(xs: T[]): T[] => xs.filter((x) => !isConflictCopy(x.title));
