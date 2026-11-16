import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, usageLine } from "../src/ai/usage.ts";

const u = (model: string, i: number, o: number, r = 0, w = 0) => ({ model, inputTokens: i, outputTokens: o, cacheReadTokens: r, cacheWriteTokens: w });

test("the cost of a call", () => {
  assert.equal(cents(u("claude-opus-5-5", 1_000_000, 0)), 400);
  assert.equal(cents(u("claude-haiku-5-5", 0, 1_000_000)), 50);
  assert.equal(cents(u("someone-else", 10, 10)), null);
});

test("the line says what went out and back", () => {
  assert.equal(usageLine(u("claude-opus-5-5", 2100, 340)), "Sent 2.1k tokens, 340 back, about 1.5¢");
  assert.equal(usageLine(u("claude-haiku-5-5", 300, 20)), "Sent 300 tokens, 20 back, under a tenth of a cent");
  assert.match(usageLine(u("claude-opus-5-5", 100, 50, 9000)), /mostly from the cache/);
  assert.equal(usageLine(null), "");
});

import { addAsk, parseAsks } from "../src/ai/asks.ts";

test("asks are remembered newest first, once each", () => {
  let l = addAsk([], "make it formal");
  l = addAsk(l, "translate to English");
  l = addAsk(l, "Make it  formal ");
  assert.deepEqual(l, ["Make it formal", "translate to English"]);
  assert.deepEqual(parseAsks("not json"), []);
  assert.deepEqual(parseAsks(JSON.stringify(l)), l);
  assert.equal(addAsk(Array.from({ length: 9 }, (_, i) => `a${i}`), "new").length, 8);
});
