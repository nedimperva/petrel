// What a running action asks of the person: the one-time trust dialog, a confirm, a prompt, a preview.
// These are the only dialogs in Petrel, and they appear only because the person ran an action.

import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import type { HostRequest, PromptSpec } from "../api";

interface Props {
  request: HostRequest;
  onAnswer(value: unknown): void;
}

/** The preview is untrusted HTML: no scripts, no network, nothing but inline styles and data images. */
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export function previewDoc(html: string, css: string): string {
  const base = `body{font:15px/1.6 system-ui,sans-serif;margin:24px auto;max-width:72ch;padding:0 16px;color:#18181b}
@media (prefers-color-scheme:dark){body{color:#e4e4e7;background:#18181b}a{color:#a5a5f0}}
pre,code{font-family:ui-monospace,monospace}img{max-width:100%}`;
  // `</style>` in user CSS would end the element early.
  const safe = (s: string) => s.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${base}</style><style>${safe(css)}</style></head><body>${html}</body></html>`;
}

function Prompt(props: { spec: PromptSpec; onAnswer(v: unknown): void }) {
  const values: Record<string, string> = {};
  for (const f of props.spec.fields) values[f.key] = f.default ?? "";
  const buttons = () => (props.spec.buttons.length ? props.spec.buttons : ["OK"]);
  const reply = (button: string) => props.onAnswer({ button, values: { ...values } });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        reply(buttons()[0]);
      }}
    >
      <For each={props.spec.fields}>
        {(f, i) => (
          <label class="field">
            <span>{f.label || f.key}</span>
            <Switch
              fallback={
                <input
                  type={f.kind === "date" ? "date" : "text"}
                  value={values[f.key]}
                  autofocus={i() === 0}
                  onInput={(e) => (values[f.key] = e.currentTarget.value)}
                />
              }
            >
              <Match when={f.kind === "textarea"}>
                <textarea
                  rows="5"
                  value={values[f.key]}
                  autofocus={i() === 0}
                  onInput={(e) => (values[f.key] = e.currentTarget.value)}
                  onKeyDown={(e) => {
                    // Enter is a newline here; Ctrl Enter submits.
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      reply(buttons()[0]);
                    }
                  }}
                />
              </Match>
              <Match when={f.kind === "select"}>
                <select onChange={(e) => (values[f.key] = e.currentTarget.value)}>
                  <For each={f.options}>{(o) => <option selected={o === f.default}>{o}</option>}</For>
                </select>
              </Match>
              <Match when={f.kind === "switch"}>
                <input
                  type="checkbox"
                  checked={values[f.key] === "true"}
                  onChange={(e) => (values[f.key] = String(e.currentTarget.checked))}
                />
              </Match>
            </Switch>
          </label>
        )}
      </For>
      <div class="buttons">
        <Show when={props.spec.cancelButton}>
          <button type="button" onClick={() => props.onAnswer(null)}>
            Cancel <kbd>Esc</kbd>
          </button>
        </Show>
        <For each={buttons()}>
          {(b, i) => (
            <button type={i() === 0 ? "submit" : "button"} class={i() === 0 ? "primary" : ""} onClick={() => i() && reply(b)}>
              {b}
              <Show when={i() === 0}>
                {" "}
                <kbd>Enter</kbd>
              </Show>
            </button>
          )}
        </For>
      </div>
    </form>
  );
}

export default function HostDialog(props: Props) {
  let box!: HTMLDivElement;
  const [answered, setAnswered] = createSignal(false);
  const answer = (v: unknown) => {
    if (answered()) return;
    setAnswered(true);
    props.onAnswer(v);
  };
  // Esc is "no" for every kind; a prompt says so with null.
  const no = () => answer(props.request.kind === "prompt" ? null : false);

  onMount(() => {
    const first = box.querySelector<HTMLElement>("[autofocus], button.primary");
    (first ?? box).focus();
  });

  return (
    <div class="scrim">
      <div
        class="dialog"
        classList={{ wide: props.request.kind === "preview" }}
        ref={box}
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            if (props.request.kind !== "prompt" || (props.request.payload as PromptSpec).cancelButton) no();
          }
        }}
      >
        <Switch>
          <Match when={props.request.kind === "confirm" && props.request}>
            {(r) => {
              const p = (r() as Extract<HostRequest, { kind: "confirm" }>).payload;
              return (
                <>
                  <h2>{p.title}</h2>
                  <p>{p.message}</p>
                  <div class="buttons">
                    <button onClick={no}>
                      Cancel <kbd>Esc</kbd>
                    </button>
                    <button class="primary" onClick={() => answer(true)}>
                      Run <kbd>Enter</kbd>
                    </button>
                  </div>
                </>
              );
            }}
          </Match>
          <Match when={props.request.kind === "scope" && props.request}>
            {(r) => {
              const p = (r() as Extract<HostRequest, { kind: "scope" }>).payload;
              return (
                <>
                  <h2>Run “{p.action}”?</h2>
                  <p>
                    This action is new to Petrel or was changed outside the action editor. It will do the following.
                    Petrel asks once; it asks again if the steps change.
                  </p>
                  <ul class="scope">
                    <For each={p.items}>
                      {(item) => (
                        <li>
                          <span class="what">{item.kind === "command" ? "Run" : "Write"}</span>
                          <code>{item.text}</code>
                        </li>
                      )}
                    </For>
                  </ul>
                  <div class="buttons">
                    <button onClick={no}>
                      Cancel <kbd>Esc</kbd>
                    </button>
                    <button class="primary" onClick={() => answer(true)}>
                      Run and trust <kbd>Enter</kbd>
                    </button>
                  </div>
                </>
              );
            }}
          </Match>
          <Match when={props.request.kind === "prompt" && props.request}>
            {(r) => {
              const p = (r() as Extract<HostRequest, { kind: "prompt" }>).payload;
              return (
                <>
                  <Show when={p.title}>
                    <h2>{p.title}</h2>
                  </Show>
                  <Show when={p.message}>
                    <p>{p.message}</p>
                  </Show>
                  <Prompt spec={p} onAnswer={answer} />
                </>
              );
            }}
          </Match>
          <Match when={props.request.kind === "preview" && props.request}>
            {(r) => {
              const p = (r() as Extract<HostRequest, { kind: "preview" }>).payload;
              return (
                <>
                  <iframe class="preview" sandbox="" srcdoc={previewDoc(p.html, p.css)} title="Preview" />
                  <div class="buttons">
                    <button onClick={no}>
                      Close <kbd>Esc</kbd>
                    </button>
                    <Show when={p.continueButton}>
                      <button class="primary" onClick={() => answer(true)}>
                        Continue <kbd>Enter</kbd>
                      </button>
                    </Show>
                  </div>
                </>
              );
            }}
          </Match>
        </Switch>
      </div>
    </div>
  );
}
