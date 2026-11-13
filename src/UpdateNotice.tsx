// The notice that a new Petrel is ready: bottom right, until Install or Later. Quiet, and only after a check found
// one (src/updates.ts).

import { Match, Show, Switch } from "solid-js";
import { dismissUpdate, installUpdate, updateState } from "./updates";

export default function UpdateNotice() {
  const s = updateState;
  return (
    <Show when={s().kind !== "idle"}>
      <div class="update-notice" role="status">
        <Switch>
          <Match when={s().kind === "found" && s()}>
            {(x) => {
              const f = (x() as Extract<ReturnType<typeof s>, { kind: "found" }>).found;
              return (
                <>
                  <span class="update-text">
                    <b>Petrel {f.version} is ready</b>
                    <span class="muted small">It installs and Petrel opens again. Your notes are saved first.</span>
                  </span>
                  <button type="button" class="btn small" onClick={dismissUpdate}>
                    Later
                  </button>
                  <button type="button" class="btn small primary" onClick={() => void installUpdate()}>
                    Install and restart
                  </button>
                </>
              );
            }}
          </Match>
          <Match when={s().kind === "installing" && s()}>
            {(x) => {
              const i = () => x() as Extract<ReturnType<typeof s>, { kind: "installing" }>;
              return (
                <span class="update-text">
                  <b>Updating Petrel…</b>
                  <span class="muted small">{i().size ? `${Math.round((i().got / i().size) * 100)}%` : "Downloading"}</span>
                </span>
              );
            }}
          </Match>
          <Match when={s().kind === "error" && s()}>
            {(x) => (
              <>
                <span class="update-text">
                  <b>The update did not work</b>
                  <span class="muted small">{(x() as Extract<ReturnType<typeof s>, { kind: "error" }>).text}</span>
                </span>
                <button type="button" class="btn small" onClick={dismissUpdate}>
                  Close
                </button>
              </>
            )}
          </Match>
        </Switch>
      </div>
    </Show>
  );
}
