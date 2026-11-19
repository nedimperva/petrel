// The five first steps, on the empty page: what to try, with the key, ticked as it is done (firstSteps.ts).

import { For, Show } from "solid-js";
import { firstSteps, hideSteps, STEPS } from "../firstSteps";
import { keyLabel } from "../keys";
import { Kbd } from "../ui";

export default function FirstSteps() {
  return (
    <Show when={!firstSteps().hidden}>
      <aside class="first-steps" aria-label="First steps">
        <div class="first-steps-head">
          <span>Five things to try</span>
          <span class="muted small">{firstSteps().done.length} of {STEPS.length}</span>
          <button type="button" class="link small" onClick={hideSteps}>
            Hide
          </button>
        </div>
        <ol>
          <For each={STEPS}>
            {(s) => (
              <li classList={{ done: firstSteps().done.includes(s.id) }}>
                <span class="first-box" aria-hidden="true" />
                <span class="first-text">{s.text}</span>
                <Kbd keys={keyLabel(s.key)} />
              </li>
            )}
          </For>
        </ol>
      </aside>
    </Show>
  );
}
