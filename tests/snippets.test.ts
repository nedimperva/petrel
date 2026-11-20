import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSnippets, snippetOf, template } from "../src/collection/snippetText.ts";

test("a line like ;sig is the trigger and leaves the text", () => {
  const s = snippetOf("Email sign-off", ";sig\nBest,\nNedim\n");
  assert.equal(s.trigger, "sig");
  assert.equal(s.body, "Best,\nNedim");
});

test("without one the title is the trigger", () => {
  assert.equal(snippetOf("Meeting link", "https://meet.example/abc").trigger, "meetinglink");
});

test("exact triggers come first, then starts, then title words", () => {
  const list = [snippetOf("Signature long", ";sigl\nx"), snippetOf("Email sign-off", ";sig\ny"), snippetOf("A sigh", "z")];
  assert.deepEqual(
    matchSnippets(list, "sig").map((s) => s.trigger),
    ["sig", "sigl", "asigh"],
  );
  assert.deepEqual(matchSnippets(list, "zz"), []);
});

test("blanks become fields, the same one twice is one field, today is written", () => {
  const now = new Date(2026, 10, 19);
  const t = template("Hi {{name}}, see you {{when|Monday}}. Thanks {{name}}. {{today}} \\{{x}}", now);
  assert.ok(t);
  assert.match(t!, /^Hi \$\{name\}, see you \$\{Monday\}\. Thanks \$\{name\}\. .*2026.* \{\{x\}\}\$\{\}$/);
  assert.equal(template("no blanks"), null);
  assert.equal(template("costs ${5} {{x}}"), null);
});
