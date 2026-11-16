// What one AI call cost, in one line under its result: how much went out, how much came back, and about how many
// cents. The counts come back from the API; the prices are the list prices per million tokens and may drift, so the
// line says "about". A model not listed shows the counts only. Pure, for `npm test`.

/** The counts as the engine sends them. Kept here (not imported) so the node tests load this file alone. */
export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Dollars per million tokens, in and out, by the start of the model name. */
const PRICES: [string, number, number][] = [
  ["claude-opus-5", 4, 20],
  ["claude-sonnet-5", 2, 10],
  ["claude-haiku-5", 0.1, 0.5],
  ["claude-fable-5", 2, 10],
];

/** About what the call cost, in cents; null when the model has no price here. */
export function cents(u: Usage): number | null {
  const price = PRICES.find(([name]) => u.model.startsWith(name));
  if (!price) return null;
  const [, inn, out] = price;
  // A cache read costs a tenth of input, a cache write a quarter more.
  const dollars = (u.inputTokens * inn + u.cacheReadTokens * inn * 0.1 + u.cacheWriteTokens * inn * 1.25 + u.outputTokens * out) / 1e6;
  return dollars * 100;
}

const count = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** "Sent 2.1k tokens, 340 back, about 1.2¢". */
export function usageLine(u: Usage | null | undefined): string {
  if (!u) return "";
  const sent = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const c = cents(u);
  const cost = c === null ? "" : c < 0.1 ? ", under a tenth of a cent" : `, about ${c < 10 ? c.toFixed(1) : Math.round(c)}¢`;
  const cached = u.cacheReadTokens > sent / 2 ? " (mostly from the cache)" : "";
  return `Sent ${count(sent)} tokens${cached}, ${count(u.outputTokens)} back${cost}`;
}
