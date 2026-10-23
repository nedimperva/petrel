// The action editor (`Ctrl Shift A`, ui.md §4.3): an action's settings and its steps, each step a form drawn
// from the table below. Saving here trusts the steps, since the person just wrote them (actions.md "Trust").

import { createMemo, createSignal, For, Index, onMount, Show } from "solid-js";
import { api, type Action, type AfterSuccess, type Step } from "../api";
import Icon, { COLORS, ICONS } from "./icons";
import { ADVANCED, SIMPLE, type Example } from "./examples";
import { caps, conflict, fromEvent } from "./shortcut";

type Kind = "text" | "textarea" | "bool" | "select" | "number" | "list" | "json";

interface Field {
  key: string;
  label: string;
  kind: Kind;
  options?: string[];
  /** The value a new step starts with. */
  def?: unknown;
  /** Empty is stored as null (the engine's default). */
  nullable?: boolean;
  hint?: string;
}

const T = (key: string, label: string, def: unknown = "", more: Partial<Field> = {}): Field => ({ key, label, kind: "text", def, ...more });
const area = (key: string, label: string, def = "[[draft]]", more: Partial<Field> = {}): Field => ({ key, label, kind: "textarea", def, ...more });
const bool = (key: string, label: string, def = false): Field => ({ key, label, kind: "bool", def });
const pick = (key: string, label: string, options: string[], more: Partial<Field> = {}): Field => ({ key, label, kind: "select", options, def: options[0], ...more });

/** Step forms, from the step table in docs/design/actions.md. Template fields take `[[tags]]`. */
export const STEP_TYPES: Record<string, { label: string; fields: Field[] }> = {
  clipboard: { label: "Copy to clipboard", fields: [area("text", "Text"), pick("mode", "Mode", ["replace", "prepend", "append"])] },
  insertText: {
    label: "Insert text",
    fields: [area("text", "Text", ""), pick("position", "Where", ["cursor", "start", "end", "replaceSelection", "replaceAll"]), bool("moveCursor", "Move the cursor after it")],
  },
  url: { label: "Open URL", fields: [T("url", "URL"), bool("encode", "Encode tag values", true), pick("openIn", "Open in", ["default", "browser"])] },
  file: {
    label: "Write a file",
    fields: [
      T("path", "Path", "", { hint: "~ and $VAR work; a relative path is under Petrel's files folder. Use / on Windows too." }),
      area("text", "Text"),
      pick("mode", "If it exists", ["create", "append", "prepend", "overwrite"]),
      bool("createDirs", "Create folders", true),
    ],
  },
  runCommand: {
    label: "Run a command",
    fields: [
      area("command", "Command", ""),
      T("stdin", "Input (stdin)", "[[draft]]"),
      pick("shell", "Shell", ["", "sh", "bash", "zsh", "fish", "$SHELL", "powershell", "cmd", "none"], { def: null, nullable: true, hint: "Empty: sh on Linux, PowerShell on Windows." }),
      { key: "timeoutSecs", label: "Time limit (s)", kind: "number", def: null, nullable: true },
      T("output", "Output", "ignore", { hint: "ignore, insert, replace, clipboard, or templateTag:name" }),
      T("cwd", "Folder", null, { nullable: true }),
    ],
  },
  runAction: { label: "Run another action", fields: [T("action", "Action (name or id)"), bool("stopOnFail", "Stop if it fails", true)] },
  prompt: {
    label: "Ask",
    fields: [
      T("title", "Title"),
      T("message", "Message"),
      { key: "buttons", label: "Buttons", kind: "list", def: ["OK"], hint: "Comma separated. Answers become [[prompt_button]] and [[prompt_<key>]]." },
      { key: "fields", label: "Fields (JSON)", kind: "json", def: [{ key: "text", kind: "text", label: "Text", default: "", options: [] }], hint: "kind: text, textarea, select, switch or date" },
      bool("cancelButton", "Can be cancelled", true),
    ],
  },
  htmlPreview: {
    label: "Preview",
    fields: [area("template", "Markdown"), bool("html", "It is HTML, not Markdown"), T("css", "CSS file (in Petrel's css folder)", null, { nullable: true }), bool("continueButton", "Show Continue", true)],
  },
  mail: { label: "Write a mail", fields: [T("to", "To"), T("cc", "Cc"), T("bcc", "Bcc"), T("subject", "Subject", "[[title]]"), area("body", "Body", "[[trimmed_body]]")] },
  setTags: { label: "Change tags", fields: [{ key: "add", label: "Add", kind: "list", def: [] }, { key: "remove", label: "Remove", kind: "list", def: [] }] },
  setFlag: { label: "Flag", fields: [bool("flagged", "Flagged", true)] },
  move: { label: "Move", fields: [pick("folder", "To", ["archive", "inbox", "trash"])] },
  openDraft: { label: "Open a draft", fields: [T("uuid", "Draft id", null, { nullable: true }), T("title", "or title", null, { nullable: true }), bool("newIfMissing", "Create it if missing")] },
  script: { label: "Script (arrives in 0.3)", fields: [area("script", "Script", "")] },
};

/** One line on what each step does, shown on its form and when picking a step to add. */
export const STEP_HELP: Record<string, string> = {
  clipboard: "Puts text on the clipboard. [[draft]] is the whole draft.",
  insertText: "Adds text to the draft itself, at the cursor, the start or the end, or replaces it.",
  url: "Opens a link in the browser or the app that handles it. Tag values are encoded so they are safe in a URL.",
  file: "Writes text to a file on disk. Choose the folder, then name the file with tags like [[safe_title]] or [[date]].",
  runCommand: "Runs a shell command. The draft goes in on stdin; what it prints can be ignored, inserted or copied.",
  runAction: "Runs another action on the same draft, then carries on.",
  prompt: "Asks you something before going on. Answers are tags: [[prompt_button]] and [[prompt_<key>]] for each field.",
  htmlPreview: "Shows the draft rendered as Markdown. With Continue, the next steps run only after you look.",
  mail: "Opens a new mail in your mail app, filled in. Nothing is sent until you send it there.",
  setTags: "Adds or removes tags on the draft.",
  setFlag: "Flags or unflags the draft.",
  move: "Moves the draft to the Inbox, the Archive or the Trash.",
  openDraft: "Opens another draft in the editor when the action is done.",
  script: "JavaScript. Scripts arrive in version 0.3; until then this step fails.",
};

/** Tags most actions need; the full list is in docs/design/actions.md. */
const TAGS: [string, string][] = [
  ["[[draft]]", "the whole draft"],
  ["[[title]]", "the first line, without #"],
  ["[[body]]", "everything after the first line"],
  ["[[selection]]", "the selected text, or the whole draft"],
  ["[[safe_title]]", "the title, safe as a file name"],
  ["[[date]]", "today, 2026-10-23; [[date|%d.%m.%Y]] for another format"],
  ["[[time]]", "now, 14:05"],
  ["[[date|+1 day]]", "tomorrow; also week, month, monday…"],
  ["[[tags]]", "the draft's tags, comma separated"],
  ["[[clipboard]]", "what is on the clipboard"],
  ["[[line|1]]", "the first line; [[line|2..4]] for a range"],
];

export function newStep(type: string): Step {
  const s: Step = { type };
  for (const f of STEP_TYPES[type]?.fields ?? []) s[f.key] = structuredClone(f.def ?? null);
  return s;
}

export function blankAction(group: string): Action {
  return {
    uuid: "",
    name: "",
    group,
    description: "",
    icon: "bolt",
    color: "grey",
    shortcut: null,
    steps: [newStep("clipboard")],
    afterSuccess: "nothing",
    addTags: [],
    confirm: false,
    hidden: false,
    disabled: false,
    trusted: true,
  };
}

interface Props {
  /** null: a new action. */
  action: Action | null;
  all: Action[];
  onSaved(a: Action): void;
  onDeleted(uuid: string): void;
  onClose(): void;
}

function StepForm(props: { step: Step; index: number; count: number; set(s: Step): void; move(by: number): void; remove(): void }) {
  const spec = () => STEP_TYPES[props.step.type];
  const [jsonError, setJsonError] = createSignal<string | null>(null);
  const set = (key: string, value: unknown) => props.set({ ...props.step, [key]: value });
  /** Keeps the file name part of the path and puts it in the chosen folder. */
  async function chooseFolder() {
    const folder = await (await api).pickFolder();
    if (!folder) return;
    const old = String(props.step.path ?? "");
    const name = old.split("/").pop() || "[[safe_title]].md";
    // `\[[` is the template escape, so Windows paths are written with `/` (Windows accepts it).
    set("path", `${folder.replace(/\\/g, "/").replace(/\/$/, "")}/${name}`);
  }
  return (
    <fieldset
      class="step"
      onKeyDown={(e) => {
        if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          e.preventDefault();
          e.stopPropagation();
          props.move(e.key === "ArrowUp" ? -1 : 1);
        }
      }}
    >
      <legend>
        <span class="n">{props.index + 1}</span>
        {spec()?.label ?? props.step.type}
        <span class="grow" />
        <button type="button" disabled={props.index === 0} onClick={() => props.move(-1)} title="Move up (Alt ↑)">
          ↑
        </button>
        <button type="button" disabled={props.index === props.count - 1} onClick={() => props.move(1)} title="Move down (Alt ↓)">
          ↓
        </button>
        <button type="button" class="danger" onClick={() => props.remove()} title="Remove the step">
          Remove
        </button>
      </legend>
      <Show when={STEP_HELP[props.step.type]}>
        <p class="hint help">{STEP_HELP[props.step.type]}</p>
      </Show>
      <Show
        when={spec()}
        fallback={
          <p class="hint">
            “{String(props.step.originalType ?? props.step.type)}” is not a Petrel step, so this action is turned off. Remove the step to
            use the action.
          </p>
        }
      >
        {(sp) => (
          <For each={sp().fields}>
            {(f) => {
              const v = () => props.step[f.key];
              return (
                <label class="field" classList={{ inline: f.kind === "bool" }}>
                  <span>{f.label}</span>
                  {f.kind === "bool" ? (
                    <input type="checkbox" checked={!!v()} onChange={(e) => set(f.key, e.currentTarget.checked)} />
                  ) : f.kind === "textarea" ? (
                    <textarea rows={f.key === "script" ? 10 : 3} spellcheck={false} value={String(v() ?? "")} onInput={(e) => set(f.key, e.currentTarget.value)} />
                  ) : f.kind === "select" ? (
                    <select onChange={(e) => set(f.key, f.nullable && !e.currentTarget.value ? null : e.currentTarget.value)}>
                      <For each={f.options}>{(o) => <option value={o} selected={(v() ?? "") === o}>{o || "default"}</option>}</For>
                    </select>
                  ) : f.kind === "number" ? (
                    <input type="number" min="1" value={v() == null ? "" : String(v())} onInput={(e) => set(f.key, e.currentTarget.value ? Number(e.currentTarget.value) : null)} />
                  ) : f.kind === "list" ? (
                    <input
                      value={((v() as string[] | null) ?? []).join(", ")}
                      onChange={(e) => set(f.key, e.currentTarget.value.split(",").map((x) => x.trim()).filter(Boolean))}
                    />
                  ) : f.kind === "json" ? (
                    <textarea
                      rows="4"
                      spellcheck={false}
                      value={JSON.stringify(v() ?? [], null, 1)}
                      onChange={(e) => {
                        try {
                          set(f.key, JSON.parse(e.currentTarget.value));
                          setJsonError(null);
                        } catch (err) {
                          setJsonError(String(err));
                        }
                      }}
                    />
                  ) : (
                    <input
                      list={f.key === "action" ? "petrel-action-names" : undefined}
                      spellcheck={false}
                      value={String(v() ?? "")}
                      onInput={(e) => set(f.key, f.nullable && !e.currentTarget.value ? null : e.currentTarget.value)}
                    />
                  )}
                  <Show when={props.step.type === "file" && f.key === "path"}>
                    <button type="button" class="pick" onClick={() => chooseFolder()}>
                      Choose folder…
                    </button>
                  </Show>
                  <Show when={f.hint}>
                    <small class="hint">{f.hint}</small>
                  </Show>
                  <Show when={f.kind === "json" && jsonError()}>
                    <small class="hint warn">Not valid JSON; the last valid value is kept. {jsonError()}</small>
                  </Show>
                </label>
              );
            }}
          </For>
        )}
      </Show>
    </fieldset>
  );
}

export default function ActionEditor(props: Props) {
  let panel!: HTMLDivElement;
  let nameInput!: HTMLInputElement;
  const [a, setA] = createSignal<Action>(structuredClone(props.action ?? blankAction("")));
  const [dirty, setDirty] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [recording, setRecording] = createSignal(false);
  const [confirming, setConfirming] = createSignal<null | "discard" | "delete">(null);
  const [adding, setAdding] = createSignal("clipboard");

  let examples: HTMLDetailsElement | undefined;
  /** Fills the form from an example; the name and description stay if already typed. */
  function useExample(x: Example) {
    update({
      ...x.more,
      name: a().name.trim() ? a().name : x.name,
      description: a().description || x.description,
      icon: x.icon,
      color: x.color,
      steps: x.steps.map((s) => ({ ...newStep(s.type), ...structuredClone(s) })),
    });
    if (examples) examples.open = false;
  }
  const update = (patch: Partial<Action>) => {
    setA({ ...a(), ...patch });
    setDirty(true);
    setError(null);
  };
  const others = createMemo(() => props.all.filter((x) => x.uuid !== a().uuid));
  const clash = createMemo(() => (a().shortcut ? conflict(a().shortcut!, others()) : null));
  const groups = createMemo(() => [...new Set(props.all.map((x) => x.group))]);

  function setStep(i: number, s: Step) {
    const steps = [...a().steps];
    steps[i] = s;
    update({ steps });
  }
  function moveStep(i: number, by: number) {
    const j = i + by;
    const steps = [...a().steps];
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    update({ steps });
    // Keep the keyboard on the step that moved.
    queueMicrotask(() => panel.querySelectorAll<HTMLElement>("fieldset.step")[j]?.querySelector<HTMLElement>("input, textarea, select")?.focus());
  }

  async function save() {
    if (!a().name.trim()) {
      setError("An action needs a name.");
      nameInput.focus();
      return;
    }
    if (clash()) {
      setError(clash());
      return;
    }
    try {
      const saved = await (await api).saveAction({ ...a(), name: a().name.trim() });
      setA(structuredClone(saved));
      setDirty(false);
      props.onSaved(saved);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  }

  async function remove() {
    if (!a().uuid) return props.onClose();
    try {
      await (await api).deleteAction(a().uuid);
      props.onDeleted(a().uuid);
    } catch (e) {
      setError(String(e));
    }
  }

  function close() {
    if (dirty()) setConfirming("discard");
    else props.onClose();
  }

  onMount(() => {
    nameInput.focus();
    if (a().uuid) nameInput.select();
  });

  return (
    <div
      class="list editor-panel"
      ref={panel}
      tabindex="-1"
      onKeyDown={(e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && e.key.toLowerCase() === "s") {
          e.preventDefault();
          save();
        } else if (e.key === "Escape" && !recording()) {
          e.preventDefault();
          if (confirming()) setConfirming(null);
          else close();
        } else if (e.key === "Enter" && confirming() && (e.target as HTMLElement).tagName !== "TEXTAREA") {
          e.preventDefault();
          confirming() === "delete" ? remove() : props.onClose();
        }
        e.stopPropagation();
      }}
    >
      <div class="list-head">
        <nav class="tabs">
          <span class="tab on">{a().uuid ? "Edit action" : "New action"}</span>
          <Show when={props.action && !props.action.trusted}>
            <span class="meta warn">Not trusted yet: its commands and paths are shown before the next run.</span>
          </Show>
          <span class="grow" />
          <Show when={a().uuid}>
            <button class="danger" onClick={() => setConfirming("delete")}>
              Delete
            </button>
          </Show>
          <button onClick={close}>
            Close <kbd>Esc</kbd>
          </button>
          <button class="primary" onClick={save}>
            Save <kbd>Ctrl</kbd>
            <kbd>S</kbd>
          </button>
        </nav>
        <Show when={confirming()}>
          {(c) => (
            <div class="bar danger">
              {c() === "delete" ? `Delete “${a().name}”? Its file in the actions folder goes too.` : "Close without saving?"}
              <span class="hint">
                <kbd>Enter</kbd> {c() === "delete" ? "delete" : "discard"} <kbd>Esc</kbd> keep editing
              </span>
            </div>
          )}
        </Show>
        <Show when={error()}>{(e) => <div class="bar danger">{e()}</div>}</Show>
      </div>
      <div class="list-body form">
        <div class="grid">
          <label class="field">
            <span>Name</span>
            <input ref={nameInput} value={a().name} onInput={(e) => update({ name: e.currentTarget.value })} />
          </label>
          <label class="field">
            <span>Group</span>
            <input list="petrel-groups" value={a().group} placeholder="Actions" onInput={(e) => update({ group: e.currentTarget.value })} />
          </label>
          <label class="field wide">
            <span>Description</span>
            <input
              value={a().description}
              placeholder="What it does, in a sentence. Shown when you point at the action."
              onInput={(e) => update({ description: e.currentTarget.value })}
            />
          </label>
          <div class="field">
            <span>Colour</span>
            <div class="swatches">
              <For each={COLORS}>
                {(c) => (
                  <button type="button" class={`dot c-${c}`} classList={{ on: a().color === c }} title={c} aria-label={c} onClick={() => update({ color: c })} />
                )}
              </For>
            </div>
          </div>
          <div class="field">
            <span>Icon</span>
            <div class="swatches">
              <For each={ICONS}>
                {(i) => (
                  <button type="button" class="icon-pick" classList={{ on: a().icon === i }} title={i} aria-label={i} onClick={() => update({ icon: i })}>
                    <Icon name={i} />
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="field">
            <span>Shortcut</span>
            <button
              type="button"
              class="recorder"
              classList={{ on: recording() }}
              onFocus={() => setRecording(true)}
              onBlur={() => setRecording(false)}
              onKeyDown={(e) => {
                if (e.key === "Tab") return;
                e.preventDefault();
                e.stopPropagation();
                if (e.key === "Escape") return e.currentTarget.blur();
                if (e.key === "Backspace" || e.key === "Delete") return update({ shortcut: null });
                const s = fromEvent(e);
                if (s) update({ shortcut: s });
              }}
            >
              <Show when={a().shortcut} fallback={recording() ? "Press a key…" : "None"}>
                {(s) => <For each={caps(s())}>{(c) => <kbd>{c}</kbd>}</For>}
              </Show>
            </button>
            <small class="hint" classList={{ warn: !!clash() }}>
              {clash() ?? "A single key works in the action list; with Ctrl or Alt it works anywhere. Backspace clears."}
            </small>
          </div>
          <label class="field">
            <span>After it runs</span>
            <select onChange={(e) => update({ afterSuccess: e.currentTarget.value as AfterSuccess })}>
              <For each={["nothing", "archive", "trash", "new"]}>
                {(o) => (
                  <option value={o} selected={a().afterSuccess === o}>
                    {{ nothing: "Leave the draft", archive: "Archive the draft", trash: "Trash the draft", new: "Start a new draft" }[o]}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="field">
            <span>Add tags</span>
            <input value={a().addTags.join(", ")} onChange={(e) => update({ addTags: e.currentTarget.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
          </label>
          <label class="field inline">
            <input type="checkbox" checked={a().confirm} onChange={(e) => update({ confirm: e.currentTarget.checked })} />
            <span>Ask before running</span>
          </label>
          <label class="field inline">
            <input type="checkbox" checked={a().disabled} onChange={(e) => update({ disabled: e.currentTarget.checked })} />
            <span>Turned off</span>
          </label>
          <label class="field inline">
            <input type="checkbox" checked={a().hidden} onChange={(e) => update({ hidden: e.currentTarget.checked })} />
            <span>Hide from the list (“Show hidden” under the list brings it back)</span>
          </label>
        </div>
        <Show when={!a().uuid}>
          <details class="examples" ref={examples}>
            <summary>Start from an example</summary>
            <For each={[["Simple", SIMPLE], ["Advanced", ADVANCED]] as const}>
              {([title, list]) => (
                <>
                  <h4>{title}</h4>
                  <ul>
                    <For each={list}>
                      {(x) => (
                        <li>
                          <button type="button" class="link" onClick={() => useExample(x)}>
                            {x.name}
                          </button>
                          <span class="hint">{x.description}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </>
              )}
            </For>
          </details>
        </Show>
        <h3>Steps</h3>
        <p class="hint">Steps run from top to bottom. If one fails, the draft is left as it was.</p>
        <details class="tags-help">
          <summary>Tags you can use in any text field</summary>
          <table>
            <tbody>
              <For each={TAGS}>
                {([tag, what]) => (
                  <tr>
                    <td>
                      <code>{tag}</code>
                    </td>
                    <td>{what}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </details>
        <Index each={a().steps}>
          {(s, i) => (
            <StepForm
              step={s()}
              index={i}
              count={a().steps.length}
              set={(n) => setStep(i, n)}
              move={(by) => moveStep(i, by)}
              remove={() => update({ steps: a().steps.filter((_, j) => j !== i) })}
            />
          )}
        </Index>
        <div class="add-step">
          <select onChange={(e) => setAdding(e.currentTarget.value)}>
            <For each={Object.entries(STEP_TYPES)}>{([type, t]) => <option value={type}>{t.label}</option>}</For>
          </select>
          <button type="button" onClick={() => update({ steps: [...a().steps, newStep(adding())] })}>
            Add step
          </button>
          <span class="hint">{STEP_HELP[adding()]}</span>
        </div>
      </div>
      <datalist id="petrel-groups">
        <For each={groups()}>{(g) => <option value={g} />}</For>
      </datalist>
      <datalist id="petrel-action-names">
        <For each={others()}>{(x) => <option value={x.name} />}</For>
      </datalist>
    </div>
  );
}
