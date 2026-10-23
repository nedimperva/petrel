// The action list column (`Ctrl 2`, ui.md §4.3): groups of actions, each row with its colour, icon, name and key.
// It shows and picks; App.tsx runs (it owns the draft, the editor and the dialogs).

import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { Action } from "../api";
import Icon from "./icons";
import { caps, isChord, same } from "./shortcut";

export interface ActionListHandle {
  /** Returns true when the key was the list's. Called only while the list has focus. */
  key(e: KeyboardEvent): boolean;
  focus(): void;
  /** The active group's first action: what `Ctrl Enter` runs. */
  first(): Action | null;
  /** The highlighted action, for `Ctrl Shift A`. */
  current(): Action | null;
  /** Opens the action's group and highlights it (after it was saved). */
  reveal(uuid: string): void;
}

interface Props {
  actions: Action[];
  /** The name of the running action once it has run for 150 ms. */
  running: string | null;
  onRun(a: Action, source: "ui" | "shortcut"): void;
  onEdit(a: Action | null): void;
  onBack(): void;
  ref(h: ActionListHandle): void;
}

const STORE_KEY = "petrel.actions.open";

function remembered(): Set<string> | null {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v ? new Set(JSON.parse(v) as string[]) : null;
  } catch {
    return null;
  }
}

export default function ActionList(props: Props) {
  let panel!: HTMLDivElement;
  // Which groups are open; the first group alone on first run.
  const [open, setOpen] = createSignal<Set<string>>(remembered() ?? new Set());
  const [at, setAt] = createSignal(0);
  const [active, setActive] = createSignal<string | null>(null);
  const [showHidden, setShowHidden] = createSignal(false);
  const hiddenCount = () => props.actions.filter((a) => a.hidden).length;

  const groups = createMemo(() => {
    const by = new Map<string, Action[]>();
    for (const a of props.actions) {
      if (a.hidden && !showHidden()) continue;
      by.set(a.group, [...(by.get(a.group) ?? []), a]);
    }
    return [...by].map(([name, actions]) => ({ name, actions }));
  });

  createEffect(() => {
    const g = groups();
    if (g.length && open().size === 0) setOpen(new Set([g[0].name]));
    if (!active() && g.length) setActive([...open()].find((n) => g.some((x) => x.name === n)) ?? g[0].name);
  });

  function keep(next: Set<string>) {
    setOpen(next);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify([...next]));
    } catch {
      // Remembering is a convenience.
    }
  }

  /** What `j`/`k` walk: group headers and the rows of open groups. */
  const rows = createMemo(() =>
    groups().flatMap((g) => [
      { group: g.name, action: null as Action | null },
      ...(open().has(g.name) ? g.actions.map((a) => ({ group: g.name, action: a as Action | null })) : []),
    ]),
  );

  createEffect(() => {
    const r = rows()[at()];
    if (r) setActive(r.group);
    panel?.querySelector(`[data-i="${at()}"]`)?.scrollIntoView({ block: "nearest" });
  });

  function toggle(name: string) {
    const next = new Set(open());
    next.has(name) ? next.delete(name) : next.add(name);
    keep(next);
    setActive(name);
  }

  function run(a: Action) {
    setActive(a.group);
    props.onRun(a, "ui");
  }

  function key(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const n = rows().length;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        setAt((i) => Math.min(i + 1, n - 1));
        return true;
      case "k":
      case "ArrowUp":
        setAt((i) => Math.max(i - 1, 0));
        return true;
      case "Enter":
      case " ": {
        const r = rows()[at()];
        if (r?.action) run(r.action);
        else if (r) toggle(r.group);
        return true;
      }
      case "Escape":
        props.onBack();
        return true;
      case "e": {
        const r = rows()[at()];
        if (r?.action) props.onEdit(r.action);
        return true;
      }
    }
    // A bare-key shortcut, from any group.
    const hit = props.actions.find((a) => a.shortcut && !isChord(a.shortcut) && same(a.shortcut, e.key));
    if (hit) {
      setActive(hit.group);
      props.onRun(hit, "shortcut");
      return true;
    }
    return false;
  }

  onMount(() =>
    props.ref({
      key,
      focus: () => panel.focus(),
      first: () => groups().find((g) => g.name === active())?.actions[0] ?? groups()[0]?.actions[0] ?? null,
      current: () => rows()[at()]?.action ?? null,
      reveal(uuid) {
        const a = props.actions.find((x) => x.uuid === uuid);
        if (!a) return;
        if (!open().has(a.group)) keep(new Set([...open(), a.group]));
        setAt(Math.max(0, rows().findIndex((r) => r.action?.uuid === uuid)));
      },
    }),
  );

  return (
    <aside class="actions" ref={panel} tabindex="-1" aria-label="Actions">
      <For each={groups()}>
        {(g) => (
          <section>
            <button
              class="group"
              classList={{ at: rows()[at()]?.group === g.name && !rows()[at()]?.action }}
              data-i={rows().findIndex((r) => r.group === g.name && !r.action)}
              aria-expanded={open().has(g.name)}
              onClick={() => toggle(g.name)}
            >
              <span class="caret">{open().has(g.name) ? "▾" : "▸"}</span>
              {g.name}
            </button>
            <Show when={open().has(g.name)}>
              <For each={g.actions}>
                {(a) => {
                  const i = () => rows().findIndex((r) => r.action?.uuid === a.uuid);
                  return (
                    <div
                      class="action"
                      classList={{
                        at: at() === i(),
                        running: props.running === a.name,
                        off: a.disabled || a.steps.some((s) => s.type === "unsupported"),
                        hidden: a.hidden,
                      }}
                      data-i={i()}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        props.onEdit(a);
                      }}
                    >
                      <button
                        class="run"
                        title={a.description || a.name}
                        onClick={() => {
                          setAt(i());
                          run(a);
                        }}
                      >
                        <span class={`dot c-${a.color || "grey"}`} />
                        <Icon name={a.icon} />
                        <span class="name">{a.name}</span>
                        <Show when={a.shortcut}>
                          {(s) => (
                            <span class="caps">
                              <For each={caps(s())}>{(c) => <kbd>{c}</kbd>}</For>
                            </span>
                          )}
                        </Show>
                      </button>
                      <button class="edit" title="Edit, hide or delete (e)" aria-label={`Edit ${a.name}`} onClick={() => props.onEdit(a)}>
                        <Icon name="edit" />
                      </button>
                      <Show when={props.running === a.name}>
                        <span class="progress" />
                      </Show>
                    </div>
                  );
                }}
              </For>
            </Show>
          </section>
        )}
      </For>
      <div class="actions-foot">
        <button class="link" onClick={() => props.onEdit(null)} title="Ctrl Shift A">
          New action
        </button>
        <Show when={hiddenCount() > 0}>
          <button class="link" onClick={() => setShowHidden(!showHidden())}>
            {showHidden() ? "Hide hidden" : `Show hidden (${hiddenCount()})`}
          </button>
        </Show>
        <p class="hint">
          Click to run. <Icon name="edit" /> or <kbd>e</kbd> to edit, hide or delete.
        </p>
      </div>
    </aside>
  );
}
