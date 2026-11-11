// The headings in the margin (`npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { currentHeading, outline } from "../src/note/outline.ts";

test("headings outside code, and the one you are under", () => {
  const t = "# Trip\nintro\n## Day one\n```\n# not one\n```\n### Lunch **spot**\ntext\n";
  const hs = outline(t);
  assert.deepEqual(
    hs.map((h) => [h.level, h.text]),
    [
      [1, "Trip"],
      [2, "Day one"],
      [3, "Lunch spot"],
    ],
  );
  assert.equal(hs[1].from, t.indexOf("## Day one"));
  assert.equal(currentHeading(hs, 0), 0);
  assert.equal(currentHeading(hs, t.indexOf("text")), 2);
  assert.equal(currentHeading([], 5), -1);
  assert.equal(outline("#tag not a heading").length, 0);
});
