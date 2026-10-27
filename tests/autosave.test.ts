// The save controller against a fake store and fake timers (`npm test`, Node's own runner). The cases are the
// review findings it fixes: a failed save that callers took for a good one (A), an action's result overwritten
// by the text the run started from (B), no save while typing steadily (C), two first saves making two rows (D).

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { AUTOSAVE_MS, createAutosave, createCloser, RETRY_MS, type SaveState } from "../src/editor/autosave.ts";
import type { Draft } from "../src/api.ts";

interface Write {
  at: number;
  kind: "new" | "save" | "cursor";
  text?: string;
}

/** A store with one table and a log of writes. `fail` makes the next writes throw; `hold` makes them wait. */
function fakeStore() {
  const rows = new Map<number, string>();
  const writes: Write[] = [];
  let next = 1;
  const s = {
    rows,
    writes,
    fail: null as string | null,
    hold: null as Promise<void> | null,
    async gate() {
      if (s.hold) await s.hold;
      if (s.fail) throw new Error(s.fail);
    },
    async newDraft(content: string): Promise<Draft> {
      await s.gate();
      const id = next++;
      rows.set(id, content);
      writes.push({ at: Date.now(), kind: "new", text: content });
      return draft(id, content);
    },
    async saveDraft(id: number, content: string): Promise<boolean> {
      await s.gate();
      if (!rows.has(id)) return false;
      rows.set(id, content);
      writes.push({ at: Date.now(), kind: "save", text: content });
      return true;
    },
    async saveCursor(): Promise<void> {
      writes.push({ at: Date.now(), kind: "cursor" });
    },
  };
  return s;
}

function draft(id: number, content: string): Draft {
  return {
    id,
    uuid: `u${id}`,
    content,
    title: content.split("\n")[0],
    folder: "inbox",
    flagged: false,
    syntax: "markdown",
    cursor: 0,
    createdAt: 0,
    modifiedAt: 0,
    accessedAt: 0,
    tags: [],
    versionCount: 0,
  };
}

/** An editor, a draft signal and the controller, wired as App.tsx wires them. */
function rig(store = fakeStore()) {
  let text = "";
  let cursor = 0;
  let current: Draft | null = null;
  const states: SaveState[] = [];
  const editor = {
    text: () => text,
    cursor: () => cursor,
    load(t: string, c: number) {
      text = t;
      cursor = c;
      a.changed(); // a real editor may report the load as a change; the controller must ignore it
    },
  };
  const a = createAutosave({
    store: async () => store,
    editor: () => editor as never,
    draft: () => current,
    setDraft: (d) => (current = d),
    setSave: (s) => states.push(s),
  });
  return {
    a,
    store,
    states,
    type(t: string) {
      text += t;
      cursor = text.length;
      a.changed();
    },
    moveCursor: (c: number) => (cursor = c),
    text: () => text,
    draft: () => current,
  };
}

/** Moves the fake clock and lets the promises it released settle. */
async function tick(ms: number) {
  mock.timers.tick(ms);
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  mock.method(console, "error", () => {}); // failed saves log; these fail on purpose
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

test("C: steady typing still saves, at most AUTOSAVE_MS after a keystroke", async () => {
  const r = rig();
  for (let i = 0; i < 100; i++) {
    r.type("x");
    await tick(100);
  }
  await tick(AUTOSAVE_MS);
  const w = r.store.writes;
  assert.ok(w.length >= 30, `${w.length} writes in 10 s of typing`);
  // Each write holds every key typed (one per 100 ms from t=0) up to AUTOSAVE_MS before it.
  for (const x of w) assert.ok(x.text!.length >= Math.min(100, Math.floor((x.at - AUTOSAVE_MS) / 100) + 1), `${x.at}`);
  assert.equal(r.store.rows.get(1), "x".repeat(100));
  assert.equal(r.a.dirty(), false);
});

test("A: a failed save makes flush false, keeps the text, and retries", async () => {
  const r = rig();
  r.store.fail = "disk full";
  r.type("hello");
  assert.equal(await r.a.flush(), false);
  assert.equal(r.a.error(), "disk full");
  assert.equal(r.a.dirty(), true);
  assert.equal(r.states.at(-1), "error");
  assert.equal(r.text(), "hello");

  r.store.fail = null;
  await tick(RETRY_MS);
  assert.equal(r.store.rows.get(1), "hello", "the quiet retry saved it");
  assert.equal(r.a.error(), null);
  assert.equal(r.states.at(-1), "saved");
  assert.equal(await r.a.flush(), true);
});

test("A: flush tries again at once rather than waiting for the retry", async () => {
  const r = rig();
  r.store.fail = "locked";
  r.type("a");
  assert.equal(await r.a.flush(), false);
  r.store.fail = null;
  assert.equal(await r.a.flush(), true);
  assert.equal(r.store.rows.get(1), "a");
});

test("D: saves never overlap, so a slow first save makes one row", async () => {
  const r = rig();
  let release!: () => void;
  r.store.hold = new Promise((res) => (release = res));
  r.type("a");
  await tick(AUTOSAVE_MS); // the first insert starts and waits
  r.type("b");
  await tick(AUTOSAVE_MS); // the next save queues behind it
  r.store.hold = null;
  release();
  await tick(0);
  assert.deepEqual(
    r.store.writes.map((w) => w.kind),
    ["new", "save"],
  );
  assert.equal(r.store.rows.size, 1);
  assert.equal(r.store.rows.get(1), "ab");
});

test("D: keys typed while flush waits are saved before it returns", async () => {
  const r = rig();
  let release!: () => void;
  r.store.hold = new Promise((res) => (release = res));
  r.type("a");
  const done = r.a.flush();
  await tick(0);
  r.type("b"); // typed while the insert is out
  r.store.hold = null;
  release();
  assert.equal(await done, true);
  assert.equal(r.store.rows.get(1), "ab");
});

test("B: load shows another draft without writing the old text over a committed result", async () => {
  const r = rig();
  r.type("old");
  assert.equal(await r.a.flush(), true);
  r.store.rows.set(1, "TRANSFORMED"); // the action committed its result
  r.a.load(null); // after-success "new draft"
  await tick(RETRY_MS);
  assert.equal(r.store.rows.get(1), "TRANSFORMED");
  assert.equal(r.store.writes.length, 1, "only the first save");
  assert.equal(r.a.dirty(), false, "a load is not an edit");
  assert.equal(r.draft(), null);
});

test("B: a save that started before a load doesn't touch the new draft", async () => {
  const r = rig();
  r.type("one");
  await r.a.flush();
  let release!: () => void;
  r.store.hold = new Promise((res) => (release = res));
  r.type(" more");
  await tick(AUTOSAVE_MS); // the save of draft 1 is out
  const other = draft(7, "seven");
  r.a.load(other);
  r.store.hold = null;
  release();
  await tick(0);
  assert.equal(r.draft(), other);
  assert.equal(r.a.dirty(), false);
});

test("a draft that vanished while open is saved as a new one", async () => {
  const r = rig();
  r.type("keep me");
  await r.a.flush();
  r.store.rows.delete(1); // its Trash was emptied
  r.type("!");
  assert.equal(await r.a.flush(), true);
  assert.equal(r.store.rows.get(2), "keep me!");
  assert.equal(r.draft()!.id, 2);
});

test("an untouched new draft is not a row; a clean flush writes only a moved cursor", async () => {
  const r = rig();
  assert.equal(await r.a.flush(), true);
  assert.equal(r.store.writes.length, 0);
  r.a.load(draft(3, "text"));
  r.store.rows.set(3, "text");
  assert.equal(await r.a.flush(), true);
  assert.equal(r.store.writes.length, 0, "nothing changed");
  r.moveCursor(2);
  assert.equal(await r.a.flush(), true);
  assert.deepEqual(
    r.store.writes.map((w) => w.kind),
    ["cursor"],
  );
});

test("closing: saved closes; failed stays open; closing again keeps a file copy and closes", async () => {
  const r = rig();
  const said: string[] = [];
  const rescued: string[] = [];
  let closed = 0;
  let rescueFails = false;
  const close = createCloser({
    autosave: r.a,
    text: r.text,
    rescue: async (t) => {
      if (rescueFails) throw new Error("read-only");
      rescued.push(t);
      return "/x.md";
    },
    close: async () => void closed++,
    say: (t) => said.push(t),
  });

  r.type("draft");
  await close();
  assert.equal(closed, 1);

  r.store.fail = "disk full";
  r.type(" more");
  await close();
  assert.equal(closed, 1, "not saved: still open");
  assert.match(said.at(-1)!, /disk full.*Close again/);

  rescueFails = true;
  await close();
  assert.equal(closed, 1, "no copy either: still open");

  rescueFails = false;
  await close();
  assert.deepEqual(rescued, ["draft more"]);
  assert.equal(closed, 2);
});
