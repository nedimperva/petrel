import { createSignal, For, lazy, onCleanup, onMount, Show } from "solid-js";
import { api, type Action, type AppInfo, type Draft, type HostRequest, type RunLogEntry, type RunReport, type TagCount, type UndoToken } from "./api";
import ActionList, { type ActionListHandle } from "./actions/ActionList";
import type { LogHandle } from "./actions/ActionLog";
import HostDialog from "./actions/HostDialog";
import { fromEvent, isChord, same } from "./actions/shortcut";
import { createEditor, type EditorHandle } from "./editor/editor";
import DraftList, { type ListHandle } from "./list/DraftList";

// Not on the launch path: loaded the first time they open.
const ActionEditor = lazy(() => import("./actions/ActionEditor"));
const ActionLog = lazy(() => import("./actions/ActionLog"));

type SaveState = "saved" | "dirty" | "saving" | "error";

/** Autosave waits this long after the last keystroke. The kill test allows exactly this much loss. */
export const AUTOSAVE_MS = 300;

/** Coming back after this long away opens a new draft (package 02 "open to new draft"; a setting later). */
export const NEW_AFTER_AWAY_MS = 10 * 60 * 1000;

/** How long a toast stays in the strip. */
const TOAST_MS = 5000;

/** A run shows as running (and the editor stops taking keys) only after this long; most runs are done by then. */
const RUNNING_AFTER_MS = 150;

const ACTIONS_KEY = "petrel.actions.visible";

function actionsVisible(): boolean {
  try {
    return localStorage.getItem(ACTIONS_KEY) !== "0";
  } catch {
    return true;
  }
}

interface Undoable {
  label: string;
  token: string;
  /** The draft the editor showed when it was archived or trashed from the editor, reopened on undo. */
  reopen?: number;
}

export default function App() {
  let editorEl!: HTMLDivElement;
  let tagInput: HTMLInputElement | undefined;
  let editor: EditorHandle | undefined;
  let list: ListHandle | undefined;
  let actionList: ActionListHandle | undefined;
  let actionLog: LogHandle | undefined;
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [save, setSave] = createSignal<SaveState>("saved");
  const [info, setInfo] = createSignal<AppInfo | null>(null);
  const [listOpen, setListOpen] = createSignal(false);
  const [tagging, setTagging] = createSignal(false);
  const [allTags, setAllTags] = createSignal<TagCount[]>([]);
  const [toast, setToast] = createSignal<{ text: string; undo: boolean; log?: boolean } | null>(null);
  const [actions, setActions] = createSignal<Action[]>([]);
  const [actionsOpen, setActionsOpen] = createSignal(actionsVisible());
  /** The action editor is open; `action` null is a new one. */
  const [editing, setEditing] = createSignal<{ action: Action | null } | null>(null);
  const [logOpen, setLogOpen] = createSignal(false);
  const [requests, setRequests] = createSignal<HostRequest[]>([]);
  /** The action that is running, and whether it has run long enough to show. */
  const [running, setRunning] = createSignal<{ name: string; shown: boolean } | null>(null);
  let undoStack: Undoable[] = [];
  let toastTimer: number | undefined;
  let timer: number | undefined;
  let saving: Promise<void> | null = null;
  let awaySince: number | null = null;
  let gPending = false;

  // The row is created on the first keystroke, never for an untouched new draft.
  async function flush() {
    const a = await api;
    if (!editor) return;
    const text = editor.text();
    const cursor = editor.cursor();
    const current = draft();
    if (!current && text === "") return;
    setSave("saving");
    try {
      if (!current) {
        const d = await a.newDraft(text);
        setDraft(d);
        // Text may have changed while the insert ran.
        if (editor.text() !== text) await a.saveDraft(d.id, editor.text(), editor.cursor());
      } else {
        const ok = await a.saveDraft(current.id, text, cursor);
        if (!ok) throw new Error("draft vanished");
      }
      setSave(editor.text() === text ? "saved" : "dirty");
    } catch (e) {
      console.error(e);
      setSave("error");
      schedule(2000); // not a dialog: retry quietly
    }
  }

  function schedule(ms = AUTOSAVE_MS) {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      saving = flush().finally(() => (saving = null));
    }, ms);
  }

  function onChange() {
    setSave("dirty");
    schedule();
  }

  async function flushNow() {
    window.clearTimeout(timer);
    if (saving) await saving;
    await flush();
  }

  async function newDraft() {
    await flushNow();
    setDraft(null);
    setListOpen(false);
    editor?.load("", 0);
    setSave("saved");
  }

  async function openDraft(id: number) {
    await flushNow();
    try {
      const d = await (await api).openDraft(id);
      setDraft(d);
      setListOpen(false);
      editor?.load(d.content, d.cursor);
      setSave("saved");
    } catch (e) {
      say(`Cannot open: ${e}`);
    }
  }

  function say(text: string, undo = false, log = false) {
    window.clearTimeout(toastTimer);
    setToast({ text, undo, log });
    toastTimer = window.setTimeout(() => setToast(null), TOAST_MS);
  }

  function remember(u: Undoable, count: number) {
    if (count === 0) {
      say(`${u.label}: nothing changed.`);
      return;
    }
    undoStack.push(u);
    if (undoStack.length > 20) undoStack.shift();
    say(u.label, true);
  }

  async function undo() {
    const u = undoStack.pop();
    if (!u) {
      say("Nothing to undo.");
      return;
    }
    try {
      const n = await (await api).undo(u.token);
      say(`Undone: ${u.label.toLowerCase()} (${n}).`);
      if (u.reopen && !draft() && editor?.text() === "") await openDraft(u.reopen);
      else if (draft()) refreshDraft();
      list?.reload();
    } catch (e) {
      say(String(e).replace(/^Error: /, ""));
    }
  }

  async function refreshDraft() {
    const d = draft();
    if (d) setDraft({ ...(await (await api).openDraft(d.id)), content: d.content });
  }

  /** Archive or trash the draft in the editor, then start a new one (Drafts' habit: the next thing is new). */
  async function moveCurrent(folder: "archive" | "trash") {
    await flushNow();
    const d = draft();
    if (!d) return;
    const label = folder === "archive" ? "Archived" : "Trashed";
    try {
      const t: UndoToken = await (await api).moveDrafts([d.id], folder);
      await newDraft();
      remember({ label: `${label} “${d.title || "untitled"}”`, token: t.token, reopen: d.id }, t.count);
    } catch (e) {
      say(`${label} failed: ${e}`);
    }
  }

  async function flagCurrent() {
    await flushNow();
    const d = draft();
    if (!d) return;
    const flagged = !d.flagged;
    const t = await (await api).flagDrafts([d.id], flagged);
    setDraft({ ...d, flagged });
    remember({ label: flagged ? "Flagged" : "Unflagged", token: t.token }, t.count);
  }

  async function startTagging() {
    await flushNow();
    if (!draft()) {
      say("Type something first: an empty draft has nothing to tag.");
      return;
    }
    setAllTags(await (await api).tagCounts(null));
    setTagging(true);
    queueMicrotask(() => {
      if (!tagInput) return;
      tagInput.value = draft()!.tags.join(", ");
      tagInput.focus();
      tagInput.select();
    });
  }

  async function saveTags() {
    const d = draft();
    const names = (tagInput?.value ?? "").split(/[,\s]+/).filter(Boolean);
    setTagging(false);
    editor?.view.focus();
    if (!d) return;
    try {
      const tags = await (await api).setTags(d.id, names);
      setDraft({ ...d, tags });
      say(tags.length ? `Tags: ${tags.join(", ")}` : "Tags cleared.");
    } catch (e) {
      say(`Tagging failed: ${e}`);
    }
  }

  function toggleList() {
    if (listOpen()) {
      setListOpen(false);
      editor?.view.focus();
    } else {
      flushNow();
      setLogOpen(false);
      setListOpen(true);
    }
  }

  // ---- actions ------------------------------------------------------------------------------------------------

  async function loadActions() {
    try {
      setActions(await (await api).listActions());
    } catch (e) {
      say(`Actions cannot be read: ${e}`);
    }
  }

  /** `Ctrl 2`: show and focus the column; from inside it, hide it. */
  function toggleActions() {
    const inside = !!document.activeElement?.closest("aside.actions");
    const show = !actionsOpen() || !inside;
    setActionsOpen(show);
    try {
      localStorage.setItem(ACTIONS_KEY, show ? "1" : "0");
    } catch {
      // Remembering is a convenience.
    }
    if (show) queueMicrotask(() => actionList?.focus());
    else editor?.view.focus();
  }

  function openLog() {
    setListOpen(false);
    setLogOpen(true);
  }

  function closeLog() {
    setLogOpen(false);
    editor?.view.focus();
  }

  function editAction(a: Action | null) {
    setListOpen(false);
    setLogOpen(false);
    setEditing({ action: a });
  }

  function closeEditor() {
    setEditing(null);
    editor?.view.focus();
  }

  async function runAction(a: Action, source: "ui" | "shortcut", draftId?: number) {
    if (running()) {
      say(`${running()!.name} is still running. Esc stops it.`);
      return;
    }
    await flushNow();
    const id = draftId ?? draft()?.id;
    if (id === undefined) {
      say("Type something first: an action needs a draft.");
      return;
    }
    const onEditor = id === draft()?.id;
    setRunning({ name: a.name, shown: false });
    const slow = window.setTimeout(() => {
      setRunning((r) => r && { ...r, shown: true });
      if (onEditor) editor?.setReadOnly(true);
    }, RUNNING_AFTER_MS);
    let report: RunReport | null = null;
    try {
      report = await (await api).runAction(a.uuid, id, onEditor && editor ? editor.selection() : null, source);
    } catch (e) {
      say(`${a.name}: ${String(e).replace(/^Error: /, "")}`);
    } finally {
      window.clearTimeout(slow);
      editor?.setReadOnly(false);
      setRunning(null);
    }
    if (report) await afterRun(report, onEditor);
    if (logOpen()) actionLog?.reload();
  }

  async function afterRun(r: RunReport, onEditor: boolean) {
    const o = r.outcome;
    if (o.status === "failed") {
      say(`${r.action}: failed at step ${o.step}: ${o.message}`, false, true);
      return;
    }
    if (o.status === "cancelled") return say(`${r.action}: cancelled.`);
    // Stopped is a clean exit (a dismissed prompt): nothing to say.
    if (o.status === "stopped") return;
    const unknown = r.unknownTags.length ? ` Unknown tags left as written: ${r.unknownTags.join(", ")}.` : "";
    const last = r.log.length ? ` ${r.log[r.log.length - 1]}` : "";
    say(`${r.action}: done.${last}${unknown}`, false, !!unknown);
    list?.reload();
    if (r.openDraft !== null) return openDraft(r.openDraft);
    if (!onEditor) return;
    const fresh = await (await api).openDraft(r.draftId);
    // Drafts' habit: a draft the action filed away makes room for the next one.
    if (r.newDraft || fresh.folder !== draft()?.folder) return newDraft();
    setDraft(fresh);
    if (r.changed) {
      editor?.load(fresh.content, r.selection.head);
      editor?.select(r.selection.anchor, r.selection.head);
    }
  }

  async function runAgain(e: RunLogEntry) {
    const a = actions().find((x) => x.uuid === e.actionUuid);
    if (!a) return say("That action is gone.");
    if (e.draftId !== null && e.draftId !== draft()?.id) await openDraft(e.draftId);
    await runAction(a, "ui", e.draftId ?? undefined);
  }

  async function answer(r: HostRequest, value: unknown) {
    setRequests((q) => q.filter((x) => x.id !== r.id));
    await (await api).hostReply(r.id, value);
  }

  function onKey(e: KeyboardEvent) {
    // A dialog or the action editor takes every key.
    if (requests().length || editing()) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape" && running()) return stop(e, async () => (await api).cancelRun());
    if (ctrl && e.shiftKey && !e.altKey && k === "a") {
      const inside = !!document.activeElement?.closest("aside.actions");
      return stop(e, () => editAction(inside ? (actionList?.current() ?? null) : null));
    }
    if (ctrl && !e.shiftKey && !e.altKey) {
      if (k === "n") return stop(e, newDraft);
      if (k === "l") return stop(e, toggleList);
      if (k === "2") return stop(e, toggleActions);
      if (k === "enter") {
        const first = actionList?.first();
        return stop(e, () => (first ? runAction(first, "shortcut") : say("No actions yet. Ctrl Shift A makes one.")));
      }
      if (k === "e" && !listOpen()) return stop(e, () => moveCurrent("archive"));
      if (k === "t" && !listOpen()) return stop(e, startTagging);
    }
    if (ctrl && e.shiftKey && !e.altKey && !listOpen()) {
      if (k === "f") return stop(e, flagCurrent);
      // `Ctrl #` is Ctrl Shift 3 on most layouts; match the key and the physical key.
      if (e.key === "#" || e.code === "Digit3") return stop(e, () => moveCurrent("trash"));
    }
    // An action's own chord works anywhere.
    const chord = fromEvent(e);
    if (chord && isChord(chord)) {
      const a = actions().find((x) => x.shortcut && isChord(x.shortcut) && same(x.shortcut, chord));
      if (a) return stop(e, () => runAction(a, "shortcut"));
    }
    const el = e.target as HTMLElement | null;
    const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    if (typing) return;
    if (logOpen()) {
      if (actionLog?.key(e)) e.preventDefault();
      return;
    }
    if (listOpen()) {
      if (list?.key(e)) e.preventDefault();
      return;
    }
    if (el?.closest("aside.actions") && !ctrl && !e.altKey) {
      if (gPending) {
        gPending = false;
        if (e.key === "l") return stop(e, openLog);
        if ("ifatd".includes(e.key)) return stop(e, toggleList);
      }
      if (e.key === "g") {
        gPending = true;
        return stop(e, () => {});
      }
      if (actionList?.key(e)) e.preventDefault();
    }
  }

  function stop(e: KeyboardEvent, run: () => unknown) {
    e.preventDefault();
    e.stopPropagation();
    run();
  }

  /** Back after `NEW_AFTER_AWAY_MS` with a draft open: start a new one, as Drafts does. The old one is saved. */
  function away(hidden: boolean) {
    if (hidden) {
      awaySince ??= Date.now();
      flushNow();
      return;
    }
    const since = awaySince;
    awaySince = null;
    if (since !== null && Date.now() - since >= NEW_AFTER_AWAY_MS && draft() && !listOpen() && !tagging()) {
      newDraft();
    }
  }

  onMount(async () => {
    editor = createEditor(editorEl, onChange);
    editor.view.focus();
    const a = await api;
    await a.showWindow();
    setInfo(await a.appInfo());
    window.addEventListener("blur", () => away(true));
    window.addEventListener("focus", () => away(false));
    window.addEventListener("beforeunload", flushNow);
    document.addEventListener("visibilitychange", () => away(document.hidden));
    window.addEventListener("keydown", onKey, true);
    await a.listenHost({
      request: (r) => setRequests((q) => [...q, r]),
      closed: (id) => setRequests((q) => q.filter((x) => x.id !== id)),
      message: (_kind, text) => say(text),
    });
    loadActions();
  });
  onCleanup(() => editor?.destroy());

  return (
    <div class="app">
      <div class="work">
        <div class="center">
          <main class="editor" ref={editorEl} />
          <Show when={listOpen()}>
            <DraftList
              ref={(h) => (list = h)}
              openId={draft()?.id ?? null}
              onOpen={openDraft}
              onClose={toggleList}
              onBatch={(label, t) => remember({ label, token: t.token }, t.count)}
              onUndo={undo}
              onToast={say}
              onLog={openLog}
            />
          </Show>
          <Show when={logOpen()}>
            <ActionLog
              ref={(h) => (actionLog = h)}
              onRunAgain={runAgain}
              onOpenDraft={(id) => {
                setLogOpen(false);
                openDraft(id);
              }}
              onClose={closeLog}
            />
          </Show>
          <Show when={editing()}>
            {(a) => (
              <ActionEditor
                action={a().action}
                all={actions()}
                onSaved={async (saved) => {
                  await loadActions();
                  actionList?.reveal(saved.uuid);
                  say(`Saved “${saved.name}”.`);
                }}
                onDeleted={() => {
                  loadActions();
                  closeEditor();
                  say("Action deleted.");
                }}
                onClose={closeEditor}
              />
            )}
          </Show>
          <Show when={tagging()}>
            <div class="bar tagbar">
              <span>Tags:</span>
              <input
                ref={tagInput}
                list="petrel-tags"
                placeholder="work, idea"
                onKeyDown={(e) => {
                  e.stopPropagation();
                  // preventDefault: focus moves to the editor before the key's default action would type there.
                  if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
                  if (e.key === "Enter") saveTags();
                  else if (e.key === "Escape") {
                    setTagging(false);
                    editor?.view.focus();
                  }
                }}
              />
              <span class="hint">
                <kbd>Enter</kbd> save <kbd>Esc</kbd> cancel
              </span>
            </div>
          </Show>
        </div>
        <Show when={actionsOpen()}>
          <ActionList
            ref={(h) => (actionList = h)}
            actions={actions()}
            running={running()?.shown ? running()!.name : null}
            onRun={runAction}
            onEdit={editAction}
            onBack={() => editor?.view.focus()}
          />
        </Show>
      </div>
      <Show when={requests()[0]}>
        {(r) => <HostDialog request={r()} onAnswer={(v) => answer(r(), v)} />}
      </Show>
      <datalist id="petrel-tags">
        <For each={allTags()}>{(t) => <option value={t.name} />}</For>
      </datalist>
      <footer class="strip">
        <span class={`save save-${save()}`}>
          {save() === "saved" && "saved"}
          {save() === "dirty" && "…"}
          {save() === "saving" && "saving…"}
          {save() === "error" && "not saved — retrying"}
        </span>
        <span class="sep" />
        <Show when={draft()}>
          {(d) => (
            <>
              <Show when={d().flagged}>
                <span class="flag on" title="Flagged" />
              </Show>
              <span class="meta">{d().title || "untitled"}</span>
              <Show when={d().folder !== "inbox"}>
                <span class="meta">· {d().folder}</span>
              </Show>
              <For each={d().tags}>{(t) => <span class="tag">{t}</span>}</For>
            </>
          )}
        </Show>
        <Show when={toast()}>
          {(t) => (
            <>
              <span class="sep" />
              <span class="toast">{t().text}</span>
              <Show when={t().log}>
                <button class="link" onClick={openLog}>
                  Log
                </button>
              </Show>
              <Show when={t().undo}>
                <button class="link" onClick={undo}>
                  Undo
                </button>
                <span class="meta">
                  <kbd>z</kbd> in the list
                </span>
              </Show>
            </>
          )}
        </Show>
        <span class="grow" />
        <Show when={running()?.shown}>
          <span class="meta">
            {running()!.name} running · <kbd>Esc</kbd> stop
          </span>
          <span class="sep" />
        </Show>
        <Show
          when={listOpen()}
          fallback={
            <span class="meta keys">
              <kbd>Ctrl</kbd>
              <kbd>L</kbd> list <kbd>Ctrl</kbd>
              <kbd>N</kbd> new <kbd>Ctrl</kbd>
              <kbd>E</kbd> archive <kbd>Ctrl</kbd>
              <kbd>T</kbd> tag <kbd>Ctrl</kbd>
              <kbd>Enter</kbd> run <kbd>Ctrl</kbd>
              <kbd>2</kbd> actions
            </span>
          }
        >
          <span class="meta keys">
            <kbd>j</kbd>
            <kbd>k</kbd> move <kbd>Enter</kbd> open <kbd>x</kbd> select <kbd>e</kbd> archive <kbd>#</kbd> trash{" "}
            <kbd>f</kbd> flag <kbd>t</kbd> tag <kbd>z</kbd> undo <kbd>/</kbd> search <kbd>Esc</kbd> back
          </span>
        </Show>
        <Show when={info()?.debug}>
          <span class="sep" />
          <span class="meta" title={info()?.dbPath}>
            dev
          </span>
        </Show>
      </footer>
    </div>
  );
}
