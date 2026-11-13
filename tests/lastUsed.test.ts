import { test } from "node:test";
import assert from "node:assert/strict";

test("last use per card: parsed safely, newest kept", async () => {
  const { parseUsed, addUse } = await import("../src/collection/used.ts");
  assert.deepEqual(parseUsed("not json"), {});
  assert.deepEqual(parseUsed('{"a.md":["Slack",5],"b.md":"bad"}'), { "a.md": ["Slack", 5] });
  const u = addUse({ "a.md": ["Slack", 5] }, "a.md", "Outlook", 9);
  assert.deepEqual(u["a.md"], ["Outlook", 9]);
});
