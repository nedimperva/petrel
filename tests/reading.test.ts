// The reading view: songs keep their lines with the chords over them (`npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { isSong, songLines } from "../src/note/reading.ts";

test("a note with chords is a song, and chords sit over their words", () => {
  const body = "## Verse\n[Am]Kad ja [C]pođoh\nna Bembašu\n\n[G]Chorus:\n";
  assert.ok(isSong(body));
  assert.ok(!isSong("A [link](x) and [[a note]]"));
  const l = songLines(body);
  assert.deepEqual(l[0], { kind: "label", text: "Verse" });
  assert.deepEqual(l[1], { kind: "line", parts: [{ chord: "Am", text: "Kad ja " }, { chord: "C", text: "pođoh" }] });
  assert.deepEqual(l[2], { kind: "line", parts: [{ chord: "", text: "na Bembašu" }] });
  assert.deepEqual(l[3], { kind: "blank" });
  assert.deepEqual(l[4], { kind: "line", parts: [{ chord: "G", text: "Chorus:" }] });
});
