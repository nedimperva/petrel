// The unified Global Quick Bar (`petrel --capture` or `petrel --picker`): ONE frameless floating bar with zero
// sub-modals and zero screen swaps.
//
// - Copy mode (Super+V / Ctrl+Shift+Space): search prompts, snippets or pages on the left; preview AND edit
//   `{{blanks}}` directly inline on the right (no FillBlanks screen swap!). Enter copies & closes, Ctrl+Enter
//   pastes into the front app, Alt ←/→ switches versions, Ctrl+J runs the prompt on the front app's selection
//   inline, Ctrl+O opens in main Petrel.
// - Capture mode (Super+N / Ctrl+Alt+Space): write immediately with auto-quote card, Keep Going fold, `@topic` /
//   `@today` / `@fri` / `@Note` routing, 1-click inline destination chips in the footer (no Destination modal!),
//   and a quiet Scratch pad toggle (`.scratch/1.md`, while Ctrl 1..5 still reaches all 5 scratch pages).
// - Ctrl+Tab (or clicking the Copy / Capture pill) switches mode cleanly in place.

import { autocompletion, startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { aiLive, api, errText, type CaptureContext, type Note, type NoteSummary } from "./api";
import { fill } from "./blanks";
import { createBlanks, keepVersion, lastVersions } from "./collection/BlankFields";
import InlineTemplate from "./collection/InlineTemplate";
import { copyFilled } from "./collection/copyItem";
import { loadUsed, type Used } from "./collection/lastUsed";
import { copyBody } from "./collection/snippetText";
import { hasVersions, lastFirst, versionsOf, type Version } from "./collection/versions";
import { titleFrom } from "./copy";
import { createEditor, type EditorHandle } from "./editor/editor";
import { cleanPaste } from "./editor/paste";
import { pictureExtensions } from "./editor/pictures";
import { snippetCompletions } from "./editor/snippets";
import { placeRows, targetLabel, type Row, type Target } from "./inbox/Destination";
import { fileCapture, filedCounts } from "./inbox/file";
import { lastLine, quoteBlock, titleLine } from "./inbox/quote";
import { pickRoute, strip, tokens, typingToken } from "./inbox/route";
import { dayOptions, dayTitle, dayWord, today } from "./journal/days";
import { keyLabel, matches } from "./keys";
import { kindOf } from "./library/Card";
import { toCopy, topOf } from "./library/faces";
import Mark, { faces, hueClass, loadFaces } from "./library/Mark";
import { blankNames, codePreview, highlightParts, subOf } from "./library/preview";
import ReadNote from "./library/ReadNote";
import { completionTheme } from "./notes/links";
import { createNoteSaver, type SaveState } from "./notes/saver";
import { fold } from "./palette/match";
import { applyPrefs, parsePrefs } from "./settings/prefs";
import { ago, folderName, Kbd, KeyHints, say, ToastView } from "./ui";
import { rest, whenOpened } from "./warm";

type Mode = "copy" | "capture";

const LAST = "ui.capture.last";
const PAGE_HUES = ["ochre", "teal", "rose", "green", "plum"];

/** Where the last capture's text ends; drawn faded above new typing. */
const setEndEffect = StateEffect.define<number>();
const earlierEnd = StateField.define<number>({
  create: () => 0,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setEndEffect)) return e.value;
    return v ? tr.changes.mapPos(v, -1) : v;
  },
});
const quoteLine = Decoration.line({ class: "cap-quote-line" });
const quoteCard = EditorView.decorations.compute(["doc"], (s) => {
  const b = new RangeSetBuilder<Decoration>();
  for (let n = 1; n <= s.doc.lines; n++) {
    const line = s.doc.line(n);
    if (!line.text.startsWith(">")) break;
    b.add(line.from, line.from, quoteLine);
  }
  return b.finish();
});
const faded = Decoration.mark({ class: "cm-earlier" });
const earlierDeco = EditorView.decorations.compute([earlierEnd], (s) => {
  const end = s.field(earlierEnd);
  return end > 0 ? Decoration.set([faded.range(0, end)]) : Decoration.none;
});
const setFoldEffect = StateEffect.define<boolean>();
const earlierFolded = StateField.define<boolean>({
  create: () => true,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setFoldEffect)) return e.value;
    return v;
  },
});
function foldEnd(s: EditorState): number {
  const end = s.field(earlierEnd, false) ?? 0;
  if (!end || !s.field(earlierFolded, false)) return 0;
  const line = s.doc.lineAt(end);
  if (line.number < s.doc.lines) {
    const next = s.doc.line(line.number + 1);
    if (!next.text.trim() && next.number < s.doc.lines) return next.to;
  }
  return line.to;
}
const folded = Decoration.replace({ block: true });
const foldSet = (s: EditorState) => {
  const to = foldEnd(s);
  return to > 0 ? Decoration.set([folded.range(0, to)]) : Decoration.none;
};
const earlierFold: Extension = [
  earlierFolded,
  EditorView.decorations.compute([earlierEnd, earlierFolded], foldSet),
  EditorView.atomicRanges.of((v) => foldSet(v.state)),
  EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"))) return tr;
    const to = foldEnd(tr.startState);
    let touches = false;
    tr.changes.iterChangedRanges((a) => (touches ||= to > 0 && a <= to));
    return touches ? [] : tr;
  }),
];

async function topFolders(): Promise<string[]> {
  const fs = await (await api()).noteFolders();
  return fs.map((f) => f.path).filter((f) => !f.includes("/") && f !== "inbox" && f !== "journal" && !f.startsWith("."));
}

export default function QuickBar() {
  const [mode, setMode] = createSignal<Mode>(location.search.includes("capture") ? "capture" : "copy");
  const [leaving, setLeaving] = createSignal(false);
  let closing = false;

  // Shared context from the front app
  const [ctx, setCtx] = createSignal<CaptureContext | null>(null);
  const [selCleared, setSelCleared] = createSignal(false);
  const selectionText = () => (selCleared() ? "" : (ctx()?.text ?? "").trim());

  // =========================================================================
  // COPY MODE STATE
  // =========================================================================
  let searchInput: HTMLInputElement | undefined;
  let listEl: HTMLDivElement | undefined;
  let peekEl: HTMLDivElement | undefined;
  const [q, setQ] = createSignal("");
  const [scope, setScope] = createSignal<string>("all");
  const [i, setI] = createSignal(0);
  const [vi, setVi] = createSignal(0);
  const [here, setHere] = createSignal<Record<string, number>>({});
  const [used, setUsed] = createSignal<Used>({});
  /** Ctrl J inline run inside the right pane. */
  const [run, setRun] = createSignal<{ item: NoteSummary; prompt: string; phase: "ready" | "running" | "done" | "error"; out: string } | null>(null);

  const [data, { refetch }] = createResource(async () => {
    const s = await api();
    const [all, counts] = await Promise.all([s.listNotes({ limit: 2000 }), s.copyCounts()]);
    return { all: all.filter((n) => n.folder !== "inbox"), counts };
  });
  const [last] = createResource(lastVersions);
  const [bodies] = createResource(data, async (d) => {
    const ids = d.all.filter((n) => hasVersions(n.folder, faces())).slice(0, 400).map((n) => n.id);
    const whole = ids.length ? await (await api()).peekNotes(ids).catch(() => []) : [];
    return new Map(whole.map((n) => [n.id, copyBody(n)]));
  });
  const [inText] = createResource(q, async (text) =>
    text.trim() ? new Set((await (await api()).searchNotes(text, 80).catch(() => [])).map((n) => n.id)) : new Set<number>(),
  );

  const copyScopes = createMemo(() => {
    const d = data();
    if (!d) return [] as string[];
    const seen = new Map<string, number>();
    for (const n of d.all) {
      const top = topOf(n.folder);
      if (top && toCopy(n.folder, faces())) seen.set(top, (seen.get(top) ?? 0) + (d.counts[n.path] ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([top]) => top);
  });
  const scopes = createMemo(() => [
    { id: "all", label: "All to copy" },
    ...copyScopes().map((top) => ({ id: `c:${top}`, label: folderName(top) })),
    { id: "pages", label: "Pages" },
  ]);

  const isPage = (n: NoteSummary) => !toCopy(n.folder, faces());
  const rows = createMemo(() => {
    const d = data();
    if (!d) return [];
    const words = fold(q()).split(/\s+/).filter(Boolean);
    const deep = inText.latest ?? new Set<number>();
    const h = here();
    const score = (n: NoteSummary) => {
      const t = fold(n.title);
      let s = (h[n.path] ?? 0) * 1000 + (d.counts[n.path] ?? 0);
      if (n.folder) s += 2;
      for (const w of words) s += t.startsWith(w) ? 30 : t.includes(w) ? 15 : 0;
      return s;
    };
    const hits = d.all
      .filter((n) => !words.length || deep.has(n.id) || words.every((w) => fold(n.title + " " + n.folder + " " + n.preview).includes(w)))
      .sort((a, b) => score(b) - score(a) || b.modifiedAt - a.modifiedAt);
    const sc = scope();
    if (sc === "pages") return hits.filter(isPage).slice(0, 40);
    if (sc.startsWith("c:")) {
      const top = sc.slice(2);
      return hits.filter((n) => topOf(n.folder) === top).slice(0, 40);
    }
    const copyable = hits.filter((n) => !isPage(n));
    const pages = words.length ? hits.filter(isPage).slice(0, 10) : [];
    return [...copyable.slice(0, 40), ...pages];
  });

  createEffect(() => {
    const len = rows().length;
    if (len > 0 && i() >= len) setI(len - 1);
  });

  const sel = () => rows()[i()];
  const [body] = createResource(
    () => sel()?.id,
    async (id) => copyBody(await (await api()).peekNote(id)),
  );
  const versions = createMemo((): Version[] => {
    const n = sel();
    const b = body();
    return n && b !== undefined && hasVersions(n.folder, faces()) ? lastFirst(versionsOf(b), last()?.[n.path]) : [];
  });
  const version = () => versions()[vi() % Math.max(1, versions().length)];
  const shown = () => version()?.text ?? body() ?? sel()?.preview ?? "";
  const isCodeSel = () => {
    const n = sel();
    return !!n && !isPage(n) && kindOf(n.folder) === "code";
  };

  // Live inline blanks for the currently highlighted item (resets per item/version)
  const blankState = createBlanks(shown, selectionText);
  const shownBlanks = () => {
    const n = sel();
    return n && !isPage(n) ? blankState.list() : [];
  };

  let lastPointer = { x: -1, y: -1 };
  let kbLock = false;
  const scrollActive = () => queueMicrotask(() => listEl?.querySelector(".palette-row.on")?.scrollIntoView({ block: "nearest" }));
  const stepRow = (by: number) => {
    const n = rows().length;
    if (!n) return;
    kbLock = true;
    setI((i() + by + n) % n);
    setVi(0);
    setRun(null);
    scrollActive();
  };
  const stepScope = (back: boolean) => {
    const list = scopes();
    const cur = Math.max(0, list.findIndex((s) => s.id === scope()));
    const next = list[(cur + (back ? list.length - 1 : 1)) % list.length];
    setScope(next.id);
    setI(0);
    setVi(0);
    setRun(null);
  };

  const closeCopy = async () => {
    if (closing) return;
    closing = true;
    await (await api()).closePicker();
    rest();
  };

  async function doCopy(n: NoteSummary | undefined, paste: boolean, shift = false) {
    if (!n) return;
    const out = !isPage(n) && shownBlanks().length ? blankState.out() : shown();
    if (!isPage(n) && shownBlanks().length) void blankState.keep();
    if (version()) void keepVersion(n.path, version()!.name);
    if (!(await copyFilled(n, out, ctx()?.app ?? null))) return;
    if (paste) {
      closing = true;
      rest();
      return void (await api()).pasteIntoFront(shift).catch((e) => console.warn("paste", e));
    }
    await closeCopy();
  }

  async function readyRun(n: NoteSummary | undefined) {
    if (!n) return;
    if (!selectionText()) {
      return setRun({ item: n, prompt: "", phase: "error", out: "Nothing was selected in the front app. Select text there first." });
    }
    const prompt = fill(shown(), { selection: "the text", text: "the text", clipboard: "" });
    setRun({ item: n, prompt, phase: "ready", out: "" });
  }

  async function executeRun() {
    const r = run();
    if (!r || r.phase !== "ready") return;
    const s = await api();
    const st = await s.aiStatus().catch(() => null);
    if (!st?.ready) return setRun({ ...r, phase: "error", out: "Claude needs your API key first: Settings › AI in Petrel." });
    setRun({ ...r, phase: "running" });
    try {
      const live = aiLive((soFar) => run()?.phase === "running" && setRun({ ...run()!, out: soFar }));
      const res = await s.aiWrite({ task: "prompt", text: selectionText(), instruction: r.prompt }, live);
      setRun({ ...run()!, phase: "done", out: res.text });
    } catch (e) {
      setRun({ ...run()!, phase: "error", out: errText(e) });
    }
  }

  async function useRunResult(paste: boolean) {
    const r = run();
    if (r?.phase !== "done") return;
    if (!(await copyFilled(r.item, r.out, ctx()?.app ?? null))) return;
    if (paste) {
      closing = true;
      rest();
      return void (await api()).pasteIntoFront(false).catch((e) => console.warn("paste", e));
    }
    await closeCopy();
  }

  const focusFirstBlank = () => {
    const el = peekEl?.querySelector<HTMLElement>("[data-inline-blank]");
    if (el) {
      el.focus();
      if (el instanceof HTMLInputElement) el.select();
      return true;
    }
    return false;
  };

  // =========================================================================
  // CAPTURE MODE STATE
  // =========================================================================
  let capHost: HTMLDivElement | undefined;
  let scratchHost: HTMLDivElement | undefined;
  let editor: EditorHandle | undefined;
  let scratchEd: EditorHandle | undefined;
  let capBooted = false;
  let quoteText = "";
  let folders: string[] = [];
  let impliedTimer: ReturnType<typeof setTimeout> | undefined;
  let armed = "";

  const [note, setNote] = createSignal<Note | null>(null);
  const [save, setSave] = createSignal<SaveState>("saved");
  const [target, setTarget] = createSignal<Target | null>(null);
  const [implied, setImplied] = createSignal<Target | null>(null);
  const [quoted, setQuoted] = createSignal(false);
  const [earlier, setEarlier] = createSignal<string | null>(null);
  const [earlierShown, setEarlierShown] = createSignal(false);
  const [todayLast, setTodayLast] = createSignal<string | null>(null);
  const [msg, setMsg] = createSignal<string | null>(null);
  const [page, setPage] = createSignal(0);
  const [filled, setFilled] = createSignal<boolean[]>([false, false, false, false, false]);
  const [quickTargets, setQuickTargets] = createSignal<Row[]>([]);
  let scratchTimer: ReturnType<typeof setTimeout> | undefined;
  let scratchDirty = false;

  const saver = createNoteSaver({
    store: async () => {
      const s = await api();
      return { createNote: (_f: string, _t: string, body: string) => s.captureNote(body), saveNote: s.saveNote };
    },
    editor: () => editor,
    note,
    setNote,
    setSave,
    fresh: () => ({ folder: "inbox", title: "capture" }),
    conflict: () => {},
  });

  const end = () => (editor ? editor.view.state.field(earlierEnd, false) ?? 0 : 0);

  async function saveScratch(): Promise<void> {
    clearTimeout(scratchTimer);
    const n = page();
    if (!scratchDirty || !n || !scratchEd) return;
    scratchDirty = false;
    const text = scratchEd.text();
    setFilled((f) => f.map((x, idx) => (idx === n - 1 ? !!text.trim() : x)));
    await (await api()).saveScratchPage(n, text).catch((e) => setMsg(`Scratch not saved: ${e}`));
  }

  function scratchChanged() {
    scratchDirty = true;
    clearTimeout(scratchTimer);
    scratchTimer = setTimeout(() => void saveScratch(), 400);
  }

  async function openScratch(n: number) {
    await saveScratch();
    const to = page() === n ? 0 : n;
    if (to && !scratchEd && scratchHost) {
      scratchEd = createEditor(scratchHost, scratchChanged, { placeholder: "Scratch pad — stays here, never filed, syncs." });
      scratchEd.setExtra([
        pictureExtensions(() => "inbox"),
        cleanPaste(() => say("Pasted as Markdown. Ctrl Z for plain text.")),
        autocompletion({ override: [snippetCompletions], icons: false }),
        completionTheme,
      ]);
    }
    if (to && scratchEd) {
      const text = await (await api()).scratchPage(to).catch(() => "");
      scratchEd.load(text, text.length);
    }
    setPage(to);
    (to ? scratchEd : editor)?.view.focus();
  }

  async function scratchToCapture() {
    if (!scratchEd || !editor) return;
    const text = scratchEd.text().replace(/\s+$/, "");
    if (!text) return void openScratch(page());
    scratchEd.load("", 0);
    scratchDirty = true;
    await saveScratch();
    setPage(0);
    const now = editor.text();
    editor.insert(now.trim() ? `\n\n${text}` : text, false);
    editor.view.focus();
    say("Moved scratch text to capture. Esc files it.");
  }

  async function suggestRoute(c: CompletionContext): Promise<CompletionResult | null> {
    const line = c.state.doc.lineAt(c.pos);
    const t = typingToken(line.text.slice(0, c.pos - line.from));
    if (!t) return null;
    const from = c.pos - t.back;
    const w = t.word.toLowerCase();
    const pick = (to: Target) => (view: EditorView, _comp: Completion, a: number, b: number) => {
      const endPos = view.state.doc.sliceString(b, b + 1) === " " ? b + 1 : b;
      const startPos = endPos === b && view.state.doc.sliceString(a - 1, a) === " " ? a - 1 : a;
      view.dispatch({ changes: { from: startPos, to: endPos, insert: "" } });
      setTarget(to);
    };
    const fs = folders.filter((f) => !w || f.toLowerCase().includes(w));
    const days = dayOptions(w).map((d) => ({
      label: `@${d.word}`,
      detail: d.day === today() ? "Today's page" : `${dayTitle(d.day)}'s page`,
      apply: pick({ kind: "day", date: d.day }),
    }));
    const ns = w ? (await (await api()).findNotes(t.word.replace(/-/g, " "), 6)).filter((n) => n.folder !== "inbox" && n.id !== note()?.id) : [];
    const options: Completion[] = [
      ...days,
      ...fs.map((f) => ({ label: `@${f}`, detail: "collection", apply: pick({ kind: "folder", folder: f }) })),
      ...ns.map((n) => ({ label: `@${n.title}`, detail: folderName(n.folder), section: "Add to the end of", apply: pick({ kind: "note", id: n.id, title: n.title }) })),
    ];
    if (w && !folders.some((f) => f.toLowerCase() === w) && !days.length && !ns.length) {
      const make = pick({ kind: "folder", folder: t.word });
      const sure = armed === t.word;
      options.push({
        label: `@${t.word}`,
        detail: sure ? `Enter again: new collection “${t.word}”` : `new collection “${t.word}”?`,
        apply: (view, comp, a, b) => {
          if (armed === t.word) return make(view, comp, a, b);
          armed = t.word;
          say(`“${t.word}” is not a collection yet. Enter again to make it.`);
          setTimeout(() => startCompletion(view));
        },
      });
    }
    return options.length ? { from, options, filter: false } : null;
  }

  function readImplied() {
    clearTimeout(impliedTimer);
    impliedTimer = setTimeout(() => {
      if (!editor || earlier() !== null) return setImplied(null);
      const r = pickRoute(editor.text(), folders, [], (w) => dayWord(w));
      setImplied(!r ? null : r.route.kind === "day" ? { kind: "day", date: r.route.date } : r.route.kind === "folder" ? { kind: "folder", folder: r.route.folder } : null);
    }, 150);
  }

  function dropQuote() {
    if (!editor || !quoteText) return;
    const v = editor.view;
    if (v.state.doc.sliceString(0, quoteText.length) === quoteText) v.dispatch({ changes: { from: 0, to: quoteText.length, insert: "" } });
    quoteText = "";
    setQuoted(false);
    v.focus();
  }

  async function routeFromText(): Promise<void> {
    if (target() || !editor || earlier() !== null) return;
    const text = editor.text();
    const words = tokens(text).map((t) => t.word);
    const s = await api();
    const titles = (await Promise.all(words.map((w) => s.findNotes(w.replace(/-/g, " "), 5)))).flat().filter((n) => n.folder !== "inbox");
    const r = pickRoute(text, folders, titles.map((n) => n.title), (w) => dayWord(w));
    if (!r) return;
    const v = editor.view;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: strip(text, r.token) } });
    if (r.route.kind === "note") {
      const routeTitle = r.route.title;
      const n = titles.find((x) => x.title === routeTitle)!;
      setTarget({ kind: "note", id: n.id, title: n.title });
    } else setTarget(r.route.kind === "day" ? { kind: "day", date: r.route.date } : { kind: "folder", folder: r.route.folder });
  }

  async function nameCapture(id: number, title: string) {
    const s = await api();
    for (const t of [title, `${title} 2`, `${title} 3`, `${title} 4`]) {
      try {
        await s.renameNote(id, t);
        return;
      } catch {
        // taken
      }
    }
  }

  function dropEmptyTail() {
    const old = earlier();
    if (old === null || !editor) return;
    if (editor.text().slice(end()).trim() || editor.text() === old) return;
    const e = end();
    const doc = editor.view.state.doc;
    const keep = doc.sliceString(0, e) === old.slice(0, e);
    editor.view.dispatch({ changes: keep ? { from: e, to: doc.length, insert: old.slice(e) } : { from: 0, to: doc.length, insert: old } });
  }

  async function separate() {
    const old = earlier();
    if (old === null || !editor) return;
    const text = editor.text();
    const head = `${text.slice(0, end()).replace(/\s+$/, "")}\n`;
    const tail = text.slice(end()).replace(/^\s+/, "");
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: head } });
    await saver.flush();
    saver.load(null);
    setNote(null);
    setEarlier(null);
    setEarlierShown(false);
    editor.load(tail, tail.length);
    if (tail) saver.changed();
    say("Started a fresh capture.");
  }

  const goesToday = () => {
    const t = target() ?? implied();
    return t?.kind === "day" && (!t.date || t.date === today());
  };

  async function toggleToday() {
    if (earlier() !== null) await separate();
    if (target()?.kind === "day" && goesToday()) setTarget(null);
    else setTarget({ kind: "day", date: today() });
    editor?.view.focus();
  }

  async function readToday() {
    const n = await (await api()).dayNote(today()).catch(() => null);
    const lines = (n?.body ?? "").split("\n").map((l) => l.trim()).filter((l) => /[\p{L}\p{N}]/u.test(l) && l !== "_from capture_" && !l.startsWith("#"));
    setTodayLast(lines.length ? lines[lines.length - 1] : "");
  }
  createEffect(() => {
    if (goesToday()) void readToday();
  });

  function showEarlier(on: boolean) {
    setEarlierShown(on);
    editor?.view.dispatch({ effects: setFoldEffect.of(!on) });
    editor?.view.focus();
  }

  async function lastCapture(settings: Record<string, string>): Promise<Note | null> {
    const [id, at] = (settings[LAST] ?? "").split(":").map(Number);
    const keep = parsePrefs(settings).keepGoing * 60 * 1000;
    if (!id || !(Date.now() - at < keep)) return null;
    const n = await (await api()).peekNote(id).catch(() => null);
    return n && n.folder === "inbox" && n.body.trim() ? n : null;
  }

  async function bootCapture(settings: Record<string, string>, capCtx: CaptureContext | null) {
    if (capBooted || !capHost) return;
    capBooted = true;
    editor = createEditor(capHost, () => (saver.changed(), readImplied()), { placeholder: "Write it down. @topic, @today or click a place below." });
    editor.setExtra([
      earlierEnd,
      earlierDeco,
      earlierFold,
      quoteCard,
      pictureExtensions(() => "inbox"),
      cleanPaste(() => say("Pasted as Markdown. Ctrl Z for plain text.")),
      autocompletion({ override: [suggestRoute, snippetCompletions], activateOnTyping: true, icons: false, closeOnBlur: true }),
      completionTheme,
    ]);
    const s = await api();
    const [fs, usedFiled, last] = await Promise.all([topFolders().catch(() => []), filedCounts(), lastCapture(settings)]);
    folders = fs;
    setQuickTargets(placeRows("", fs, [], usedFiled, "").filter((r) => r.t.kind !== "day").slice(0, 4));
    void Promise.all([1, 2, 3, 4, 5].map((n) => s.scratchPage(n).then((t) => !!t.trim(), () => false))).then(setFilled);
    if (last && !editor.text()) {
      const old = last.body.replace(/\s+$/, "");
      saver.load({ ...last, body: `${old}\n\n` });
      editor.view.dispatch({ effects: setEndEffect.of(old.length), selection: { anchor: old.length + 2 }, scrollIntoView: true });
      setEarlier(last.body);
    }
    const quote = capCtx ? quoteBlock(capCtx) : "";
    if (quote && (earlier() !== null || !editor.text())) {
      if (earlier() !== null) editor.insert(quote, false);
      else {
        editor.insert(quote, true);
        editor.select(quote.length, quote.length);
        quoteText = quote;
      }
      setQuoted(true);
    }
    if (mode() === "capture") editor.view.focus();
  }

  async function finishCapture() {
    if (closing) return;
    closing = true;
    setLeaving(true);
    const s = await api();
    await saveScratch();
    dropEmptyTail();
    await routeFromText().catch((e) => console.error(e));
    const text = editor?.text() ?? "";
    if (editor && !(await saver.flush())) {
      const path = await s.rescueText(text).catch(() => null);
      if (!path) {
        closing = false;
        setLeaving(false);
        return setMsg(`Not saved: ${saver.error() ?? "unknown error"}`);
      }
    }
    const n = note();
    let stays = false;
    try {
      if (n && !text.trim()) await s.trashNote(n.id);
      else if (n && target()) await fileCapture({ ...n, body: text }, target()!);
      else if (n) {
        stays = true;
        if (earlier() === null) await nameCapture(n.id, titleFrom(titleLine(text)));
      }
    } catch (e) {
      console.error(e);
    }
    await s.setUiSetting(LAST, stays && n ? `${n.id}:${Date.now()}` : "").catch(() => {});
    await s.closeCapture();
    rest();
  }

  async function closeActive() {
    if (mode() === "capture" || note() || scratchDirty) await finishCapture();
    else await closeCopy();
  }

  async function switchMode(next: Mode) {
    if (mode() === next) return;
    setMode(next);
    if (next === "capture") {
      if (!capBooted) {
        const s = await api();
        const settings = await s.uiSettings().catch(() => ({}) as Record<string, string>);
        await bootCapture(settings, ctx());
      }
      setTimeout(() => (page() ? scratchEd : editor)?.view.focus());
    } else {
      setTimeout(() => searchInput?.focus());
    }
  }

  // =========================================================================
  // UNIFIED KEYBOARD HANDLER
  // =========================================================================
  const onGlobalKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    // Ctrl+Tab flips cleanly between Copy and Capture
    if (mod && e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      void switchMode(mode() === "copy" ? "capture" : "copy");
      return;
    }

    if (mode() === "capture") {
      if (document.querySelector(".cm-tooltip-autocomplete")) return;
      if (mod && !e.altKey && !e.shiftKey && /^Digit[1-5]$/.test(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        void openScratch(Number(e.code.slice(5)));
      } else if (page() && mod && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void scratchToCapture();
      } else if (matches(e, "capToday") && !page()) {
        e.preventDefault();
        e.stopPropagation();
        void toggleToday();
      } else if (mod && e.key === "Enter" && earlier() !== null) {
        e.preventDefault();
        e.stopPropagation();
        void separate();
      } else if (e.key === "Escape" || (mod && e.key === "Enter")) {
        e.preventDefault();
        e.stopPropagation();
        void finishCapture();
      }
      return;
    }

    // Copy mode keys
    const r = run();
    if (r) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setRun(null);
        searchInput?.focus();
      } else if (e.key === "Enter" && r.phase === "ready") {
        e.preventDefault();
        e.stopPropagation();
        void executeRun();
      } else if (e.key === "Enter" && r.phase === "done") {
        e.preventDefault();
        e.stopPropagation();
        void useRunResult(true);
      } else if (mod && e.key.toLowerCase() === "c" && r.phase === "done" && !getSelection()?.toString()) {
        e.preventDefault();
        e.stopPropagation();
        void useRunResult(false);
      }
      return;
    }

    const inBlank = (e.target as HTMLElement | null)?.hasAttribute("data-inline-blank");
    if (mod && e.key.toLowerCase() === "j") {
      e.preventDefault();
      e.stopPropagation();
      void readyRun(sel());
    } else if (mod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      e.stopPropagation();
      const cur = sel();
      if (cur) void api().then((s) => s.showNoteInMain(cur.id)).then(closeCopy);
    } else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft") && versions().length > 1) {
      e.preventDefault();
      e.stopPropagation();
      setVi((vi() + (e.key === "ArrowLeft" ? versions().length - 1 : 1)) % versions().length);
    } else if (!inBlank && (e.key === "ArrowDown" || (mod && e.key === "n"))) {
      e.preventDefault();
      stepRow(1);
    } else if (!inBlank && (e.key === "ArrowUp" || (mod && e.key === "p"))) {
      e.preventDefault();
      stepRow(-1);
    } else if (!inBlank && e.key === "Tab") {
      // Tab jumps straight into the item's inline blanks when it has any; otherwise steps scope!
      if (!e.shiftKey && shownBlanks().length && focusFirstBlank()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      stepScope(e.shiftKey);
    } else if (!inBlank && e.key === "Enter") {
      e.preventDefault();
      void doCopy(sel(), mod, e.shiftKey);
    } else if (!inBlank && e.key === "Escape") {
      e.preventDefault();
      if (q()) {
        setQ("");
        setI(0);
        setVi(0);
      } else if (scope() !== "all") {
        setScope("all");
        setI(0);
        setVi(0);
      } else {
        void closeActive();
      }
    }
  };

  // =========================================================================
  // LIFECYCLE
  // =========================================================================
  async function start(openMode: string) {
    const m: Mode = openMode === "capture" ? "capture" : "copy";
    setMode(m);
    setQ("");
    setScope("all");
    setI(0);
    setVi(0);
    setRun(null);
    setSelCleared(false);
    const s = await api();
    const settings = await s.uiSettings().catch(() => ({}) as Record<string, string>);
    applyPrefs(parsePrefs(settings));
    void refetch();
    void loadUsed().then(setUsed, () => {});
    const ctxPromise = Promise.all([s.pickerContext().catch(() => null), s.captureContext().catch(() => null)]);
    await s.showWindow();
    if (m === "capture") {
      await bootCapture(settings, null);
      editor?.view.focus();
    } else {
      searchInput?.focus();
    }
    void ctxPromise.then(async ([pCtx, cCtx]) => {
      const merged = pCtx?.text || pCtx?.app ? pCtx : cCtx;
      setCtx(merged);
      if (merged?.app) setHere(await s.copyCountsIn(merged.app).catch(() => ({})));
      if (merged && editor) {
        const quote = quoteBlock(merged);
        if (quote && (earlier() !== null || !editor.text())) {
          if (earlier() !== null) editor.insert(quote, false);
          else {
            editor.insert(quote, true);
            editor.select(quote.length, quote.length);
            quoteText = quote;
          }
          setQuoted(true);
        }
      }
    });
    await s.listen({ quit: () => void closeActive(), openNote: () => {}, focus: () => {}, changed: () => {} });
    await s.onQuickBarMode?.((next) => void switchMode(next === "capture" ? "capture" : "copy"));
    if ("__TAURI_INTERNALS__" in window) {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      await getCurrentWebviewWindow().onCloseRequested((e) => {
        e.preventDefault();
        void closeActive();
      });
    }
  }

  onMount(async () => {
    window.addEventListener("keydown", onGlobalKey, true);
    void loadFaces();
    await whenOpened(start);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onGlobalKey, true);
    editor?.destroy();
    scratchEd?.destroy();
  });

  const renderHighlighted = (text: string) => (
    <For each={highlightParts(text, q())}>{(seg) => (seg.hit ? <mark class="read-mark">{seg.text}</mark> : seg.text)}</For>
  );
  const selectionSnippet = () => {
    const t = selectionText().replace(/\s+/g, " ");
    return t.length > 24 ? `${t.slice(0, 24)}…` : t;
  };
  const activeDestLabel = () => targetLabel(target() ?? implied());
  const isDestOn = (t: Target | null) => {
    const cur = target() ?? implied();
    if (!t) return !cur;
    if (!cur || cur.kind !== t.kind) return false;
    if (t.kind === "day") return (t.date ?? today()) === (cur.kind === "day" ? (cur.date ?? today()) : "");
    if (t.kind === "folder") return cur.kind === "folder" && cur.folder === t.folder;
    return cur.kind === "note" && cur.id === t.id;
  };
  const saveLabel = () => (note() || save() !== "saved" ? { saved: "Saved", dirty: "Editing", saving: "Saving…", error: "Not saved" }[save()] : "");

  return (
    <div class="quickbar" classList={{ leaving: leaving() }} data-tauri-drag-region>
      {/* Unified Top Bar: Mode Switcher + Search/Hint */}
      <header class="qb-top" data-tauri-drag-region>
        <div class="seg qb-mode-seg" role="tablist" aria-label="Quick Bar mode">
          <button type="button" role="tab" aria-selected={mode() === "copy"} classList={{ on: mode() === "copy" }} onClick={() => void switchMode("copy")}>
            Copy
          </button>
          <button type="button" role="tab" aria-selected={mode() === "capture"} classList={{ on: mode() === "capture" }} onClick={() => void switchMode("capture")}>
            Capture
          </button>
        </div>

        <Show
          when={mode() === "copy"}
          fallback={
            <div class="qb-cap-bar" data-tauri-drag-region>
              <span class="muted small" data-tauri-drag-region>
                {page() ? `Scratch pad ${page()}` : "Quick capture · @topic or click a place below"}
              </span>
              <span class="grow" data-tauri-drag-region />
              <button
                type="button"
                class="chip small"
                classList={{ on: page() > 0 }}
                onClick={() => void openScratch(page() || 1)}
                title="Persistent scratch pad (Ctrl 1..5)"
              >
                Scratch{filled().some(Boolean) ? ` (${filled().filter(Boolean).length})` : ""}
              </button>
            </div>
          }
        >
          <div class="qb-search-wrap">
            <input
              ref={searchInput}
              class="qb-search"
              placeholder="Find a prompt, snippet or page…"
              value={q()}
              onInput={(e) => (setQ(e.currentTarget.value), setI(0), setVi(0), setRun(null))}
            />
            <Show when={selectionText()}>
              <span class="picker-sel-pill" title={`From ${ctx()?.app || "front app"} — fills {{selection}}`}>
                <span class="picker-sel-dot" aria-hidden="true" />
                <span class="picker-sel-text">
                  <Show when={ctx()?.app}><b>{ctx()!.app}</b> · </Show>“{selectionSnippet()}”
                </span>
                <button type="button" class="picker-sel-x" aria-label="Clear selection" onClick={() => (setSelCleared(true), searchInput?.focus())}>×</button>
              </span>
            </Show>
          </div>
        </Show>
      </header>

      {/* COPY MODE BODY */}
      <Show when={mode() === "copy"}>
        <div class="picker-scopes" role="tablist" aria-label="Scope">
          <For each={scopes()}>
            {(sc) => (
              <button
                type="button"
                role="tab"
                class="picker-scope"
                aria-selected={scope() === sc.id}
                classList={{ on: scope() === sc.id }}
                onClick={() => (setScope(sc.id), setI(0), setVi(0), setRun(null), searchInput?.focus())}
              >
                {sc.label}
              </button>
            )}
          </For>
        </div>
        <div class="picker-body">
          <div class="palette-list" ref={listEl}>
            <For each={rows()}>
              {(n, k) => {
                const pg = () => isPage(n);
                const text = () => bodies()?.get(n.id) ?? n.preview;
                const vs = () => (pg() || !hasVersions(n.folder, faces()) ? [] : lastFirst(versionsOf(text()), last()?.[n.path]));
                const bCount = () => (pg() ? 0 : blankNames(vs().length > 1 ? vs()[0].text : text()).length);
                return (
                  <>
                    <Show when={scope() === "all" && pg() && (k() === 0 || !isPage(rows()[k() - 1]))}>
                      <div class="picker-section">Pages</div>
                    </Show>
                    <button
                      type="button"
                      class={`palette-row picker-row ${hueClass(n.folder)}`}
                      classList={{ on: k() === i() }}
                      onPointerMove={(e) => {
                        const dx = Math.abs(e.clientX - lastPointer.x);
                        const dy = Math.abs(e.clientY - lastPointer.y);
                        if (kbLock && dx < 4 && dy < 4) return;
                        kbLock = false;
                        lastPointer = { x: e.clientX, y: e.clientY };
                        if (k() !== i()) (setI(k()), setVi(0), setRun(null));
                      }}
                      onClick={() => {
                        setI(k());
                        setVi(0);
                        setRun(null);
                        if (!pg() && bCount()) setTimeout(focusFirstBlank);
                        else void doCopy(n, false);
                      }}
                    >
                      <span class="picker-row-mark">
                        <Mark folder={n.folder} size={12} />
                      </span>
                      <span class="row-two">
                        <span class="row-label">{renderHighlighted(n.title)}</span>
                        <Show
                          when={used()[n.path]}
                          fallback={
                            <span class="row-used">
                              {folderName(n.folder)}
                              {vs().length > 1 ? ` · ${vs().length}v` : ""}
                            </span>
                          }
                        >
                          {(u) => <span class="row-used">{u()[0]} · {ago(u()[1])}</span>}
                        </Show>
                      </span>
                      <Show
                        when={here()[n.path]}
                        fallback={
                          <Show when={bCount()}>
                            <span class="row-sub picker-blanks">{bCount()} {bCount() === 1 ? "blank" : "blanks"}</span>
                          </Show>
                        }
                      >
                        <span class="row-here">{here()[n.path]}× here</span>
                      </Show>
                    </button>
                  </>
                );
              }}
            </For>
            <Show when={data() && !rows().length}>
              <p class="muted pad">{q() ? "Nothing matches." : "Nothing to copy yet."}</p>
            </Show>
          </div>

          {/* Right Pane: Inline Preview + Direct Editable Blanks (OR Inline AI Run) */}
          <div class="picker-peek" ref={peekEl}>
            <Show
              when={!run()}
              fallback={
                <div class="qb-run">
                  <div class="run-head">
                    <span class="row-label">{run()!.item.title}</span>
                    <span class="muted small">on selection{ctx()?.app ? ` in ${ctx()!.app}` : ""}</span>
                  </div>
                  <Show when={run()!.phase === "ready"}>
                    <p class="run-text run-prompt">{run()!.prompt}</p>
                    <p class="run-text run-sel">{selectionText().slice(0, 800)}</p>
                    <div class="row end">
                      <button type="button" class="btn small" onClick={() => (setRun(null), searchInput?.focus())}>Back <kbd>Esc</kbd></button>
                      <button type="button" class="btn small primary" onClick={() => void executeRun()}>Send to Claude <kbd>↵</kbd></button>
                    </div>
                  </Show>
                  <Show when={run()!.phase !== "ready"}>
                    <p class="run-text run-out" classList={{ bad: run()!.phase === "error", live: run()!.phase === "running" }}>
                      {run()!.out || "Claude is working…"}
                    </p>
                    <Show when={run()!.phase === "done"}>
                      <div class="row end">
                        <button type="button" class="btn small" onClick={() => void useRunResult(false)}>Copy</button>
                        <button type="button" class="btn small primary" onClick={() => void useRunResult(true)}>Paste over selection <kbd>↵</kbd></button>
                      </div>
                    </Show>
                  </Show>
                </div>
              }
            >
              <Show when={sel()}>
                {(n) => {
                  const pg = () => isPage(n());
                  const code = () => isCodeSel();
                  const sub = () => subOf(n().folder, topOf(n().folder));
                  const cp = () => codePreview(shown());
                  return (
                    <div class={`qb-peek-inner ${hueClass(n().folder)}`}>
                      <div class="picker-peek-head">
                        <div class="picker-peek-meta">
                          <span class="lcard-where">
                            <Mark folder={n().folder} size={12} />
                            {folderName(topOf(n().folder))}
                            <Show when={sub()}><span class="picker-peek-sub">/ {sub()}</span></Show>
                          </span>
                          <h2 class="picker-peek-title" classList={{ serif: pg() }}>{n().title}</h2>
                        </div>
                        <button type="button" class="btn small primary" onClick={() => void doCopy(n(), !!ctx()?.app)}>
                          {ctx()?.app ? `Paste` : "Copy"} <kbd>↵</kbd>
                        </button>
                      </div>
                      <Show when={versions().length > 1}>
                        <div class="versions" role="tablist" aria-label="Versions">
                          <For each={versions()}>
                            {(v, idx) => (
                              <button type="button" role="tab" class="chip small" aria-selected={idx() === vi() % versions().length} classList={{ on: idx() === vi() % versions().length }} onClick={() => setVi(idx())}>
                                {v.name}
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                      <div class="picker-peek-body">
                        <Show
                          when={!pg()}
                          fallback={<ReadNote compact body={shown()} folder={n().folder} highlight={q()} />}
                        >
                          <Show when={code() && cp().lang}>
                            <div class="picker-peek-lang">{cp().lang}</div>
                          </Show>
                          <InlineTemplate
                            text={code() ? cp().text : shown()}
                            state={blankState}
                            code={code()}
                            renderText={renderHighlighted}
                            onSubmit={(paste, shift) => void doCopy(n(), paste, shift)}
                            onEscape={() => searchInput?.focus()}
                          />
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </Show>
            </Show>
          </div>
        </div>
        <footer class="picker-foot">
          <KeyHints
            hints={[
              shownBlanks().length > 0 && ["Tab", "edit blanks"],
              ["Enter", "copy"],
              ["Ctrl Enter", ctx()?.app ? `paste into ${ctx()!.app}` : "paste"],
              !!selectionText() && ["Ctrl J", "run on selection"],
              ["Ctrl Tab", "capture"],
            ]}
          />
          <span class="grow" />
          <KeyHints hints={[["Esc", q() || scope() !== "all" ? "clear" : "close"]]} />
        </footer>
      </Show>

      {/* CAPTURE MODE BODY (kept mounted once booted so typing survives switching modes) */}
      <div class="qb-capture" classList={{ away: mode() !== "capture" }}>
        <Show
          when={earlier() !== null}
          fallback={
            <Show when={goesToday() && todayLast() !== null}>
              <div class="cap-top" data-tauri-drag-region>
                <Mark folder="journal" size={12} />
                <span>{todayLast() ? "Today, after" : "Today's page, first entry"}</span>
                <Show when={todayLast()}><span class="cap-top-text">{todayLast()}</span></Show>
              </div>
            </Show>
          }
        >
          <div class="cap-top" data-tauri-drag-region>
            <span>Adding after</span>
            <button type="button" class="cap-top-text" onClick={() => showEarlier(!earlierShown())}>
              {lastLine(earlier() ?? "")}
            </button>
            <span class="grow" />
            <Kbd keys={keyLabel("capNew")} /> <span>fresh</span>
          </div>
        </Show>

        <div class="capture-text-host" ref={capHost} classList={{ away: page() > 0 }} />
        <div class={`capture-text-host scratch-host hue-${PAGE_HUES[page() - 1] ?? "slate"}`} ref={scratchHost} classList={{ away: page() === 0 }} />

        {/* Inline 1-Click Destination Chips (Zero Destination Modal!) */}
        <Show when={page() === 0}>
          <div class="qb-dest-strip" role="group" aria-label="Where this capture goes">
            <span class="muted small">Goes to</span>
            <button type="button" class="chip small" classList={{ on: isDestOn(null) }} onClick={() => (setTarget(null), editor?.view.focus())}>
              Inbox
            </button>
            <button type="button" class="chip small" classList={{ on: isDestOn({ kind: "day", date: today() }) }} onClick={() => void toggleToday()}>
              @today
            </button>
            <For each={quickTargets()}>
              {(r) => (
                <button
                  type="button"
                  class="chip small"
                  classList={{ on: isDestOn(r.t) }}
                  onClick={() => (setTarget(r.t), editor?.view.focus())}
                >
                  <Mark folder={r.folder} size={10} />
                  {r.label}
                </button>
              )}
            </For>
            <Show when={target() && !isDestOn(null) && !isDestOn({ kind: "day", date: today() }) && !quickTargets().some((r) => isDestOn(r.t))}>
              <span class="chip small on">
                {activeDestLabel()}
                <button type="button" class="chip-x" aria-label="Clear place" onClick={() => setTarget(null)}>×</button>
              </span>
            </Show>
            <Show when={quoted() && quoteText}>
              <button type="button" class="chip small" onClick={dropQuote} title="Drop quote">Drop quote ×</button>
            </Show>
          </div>
        </Show>

        <footer class="capture-foot" data-tauri-drag-region>
          <Show when={msg()} fallback={<Show when={saveLabel()}><span class={`cap-saved ${save()}`} role="status">{saveLabel()}</span></Show>}>
            <span class="bad">{msg()}</span>
          </Show>
          <KeyHints hints={[["Ctrl Tab", "copy mode"], ["Ctrl D", "today"]]} />
          <span class="grow" />
          <button type="button" class="btn small primary" onClick={() => void finishCapture()}>
            {page() ? "Done" : `Save to ${activeDestLabel()}`} <kbd>Esc</kbd>
          </button>
        </footer>
      </div>

      <ToastView />
    </div>
  );
}
