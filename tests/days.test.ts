import { test } from "node:test";
import assert from "node:assert/strict";
import { dayName, listName } from "../src/journal/days.ts";

const now = new Date(2026, 10, 27, 12, 0);

test("a day is named by its day in lists", () => {
  assert.equal(dayName("2026-11-27", now), "Today · Fri 27 Nov");
  assert.equal(dayName("2026-11-26", now), "Yesterday · Thu 26 Nov");
  assert.equal(dayName("2026-11-28", now), "Tomorrow · Sat 28 Nov");
  assert.equal(dayName("2026-11-23", now), "Mon 23 Nov");
  assert.equal(dayName("2025-12-31", now), "Wed 31 Dec 2025");
  assert.equal(dayName("not a day", now), "not a day");
});

test("only a day's page in the journal gets a day's name", () => {
  assert.equal(listName({ folder: "journal", title: "2026-11-26" }, now), "Yesterday · Thu 26 Nov");
  assert.equal(listName({ folder: "notes", title: "2026-11-26" }, now), "2026-11-26");
  assert.equal(listName({ folder: "journal", title: "Week plan" }, now), "Week plan");
});
