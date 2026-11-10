// Fill in the blanks, then copy: one field per `{{name}}`, Tab to the next, Enter copies. The finished text is
// shown as it will be pasted.

import { createSignal, For } from "solid-js";
import { blanks, fill } from "../blanks";

export default function FillBlanks(p: { title: string; text: string; onCopy(text: string): void; onClose(): void; inline?: boolean }) {
  const list = blanks(p.text);
  const [values, setValues] = createSignal<Record<string, string>>(Object.fromEntries(list.map((b) => [b.name, b.value])));
  const out = () => fill(p.text, values());
  const done = () => p.onCopy(out());

  const form = (
    <form
      class="fill"
      onSubmit={(e) => {
        e.preventDefault();
        done();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          p.onClose();
        } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement && !e.ctrlKey)) {
          e.preventDefault();
          done();
        }
      }}
    >
      <div class="fill-head">
        <span>{p.title}</span>
        <span class="muted">Fill in the blanks</span>
      </div>
      <For each={list}>
        {(b, i) => (
          <label class="fill-field">
            <span class="chip blank">{b.name}</span>
            {/^(code|text|commits|body|notes)$/i.test(b.name) ? (
              <textarea
                rows={3}
                value={values()[b.name]}
                ref={(el) => i() === 0 && setTimeout(() => el.focus())}
                onInput={(e) => setValues({ ...values(), [b.name]: e.currentTarget.value })}
              />
            ) : (
              <input
                value={values()[b.name]}
                ref={(el) => i() === 0 && setTimeout(() => el.focus())}
                onInput={(e) => setValues({ ...values(), [b.name]: e.currentTarget.value })}
              />
            )}
          </label>
        )}
      </For>
      <pre class="fill-preview">{out()}</pre>
      <div class="row end">
        <span class="muted small">
          <kbd>Tab</kbd> next blank
        </span>
        <span class="grow" />
        <button type="button" class="btn" onClick={p.onClose}>
          Cancel <kbd>Esc</kbd>
        </button>
        <button type="submit" class="btn primary">
          Copy <kbd>Enter</kbd>
        </button>
      </div>
    </form>
  );
  if (p.inline) return form;
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="dialog">{form}</div>
    </div>
  );
}
