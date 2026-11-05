// Settings (`Ctrl ,`, ui.md §4.7). For now one section, Desktop: the capture hotkey and start at login. Each
// row says what it does and what state it is in, so nothing needs the docs.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, type DesktopSettings } from "../api";

interface Props {
  onClose(): void;
}

/** A key press as a hotkey the engine can register (`Ctrl+Alt+Space`), or null for a lone modifier. */
export function accelerator(e: KeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta", "AltGraph", "OS"].includes(e.key)) return null;
  const mods = [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt", e.metaKey && "Super"].filter(Boolean);
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code) || /^Arrow/.test(e.code)) key = e.code;
  else if (["Space", "Enter", "Tab", "Home", "End", "PageUp", "PageDown", "Insert", "Delete"].includes(e.code)) key = e.code;
  else return null;
  return [...mods, key].join("+");
}

const caps = (s: string) => s.split("+").map((k) => (k === "Space" ? "Space" : k.replace(/^Arrow/, "")));

export default function Settings(props: Props) {
  let dialog!: HTMLDivElement;
  const [s, setS] = createSignal<DesktopSettings | null>(null);
  const [recording, setRecording] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  onMount(async () => {
    // On the window, not the dialog: a button that disappears when clicked (Turn off) drops focus to the body.
    window.addEventListener("keydown", onKey);
    dialog.focus();
    try {
      setS(await (await api).desktopSettings());
    } catch (e) {
      setError(`Settings cannot be read: ${e}`);
    }
  });

  async function apply(run: () => Promise<DesktopSettings>) {
    setBusy(true);
    setError(null);
    try {
      setS(await run());
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }

  onCleanup(() => window.removeEventListener("keydown", onKey));

  const setHotkey = (h: string | null) => apply(async () => (await api).setHotkey(h));

  function onKey(e: KeyboardEvent) {
    // The app's own keys must not act on the text behind the dialog.
    e.stopPropagation();
    if (recording()) {
      e.preventDefault();
      if (e.key === "Escape") return setRecording(false);
      const a = accelerator(e);
      if (!a) return;
      if (!/(Ctrl|Alt|Super)\+/.test(a) && !/^Shift\+F\d/.test(a)) {
        setError(`${a.replace(/\+/g, " ")} would be taken from every app. Add Ctrl, Alt or the Windows key.`);
        return;
      }
      setRecording(false);
      return setHotkey(a);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  }

  const status = () => {
    const v = s();
    if (!v) return "";
    if (!v.hotkey) return "Off.";
    if (v.hotkeyPaused) return "Paused from the tray.";
    if (v.hotkeyActive) return "On: press it in any app.";
    return v.hotkeyError ? `Not working: ${v.hotkeyError}` : "Not registered.";
  };

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="dialog settings" ref={dialog} tabindex="-1" role="dialog" aria-label="Settings">
        <h2>Settings</h2>
        <Show when={s()} fallback={<p>{error() ?? "Loading…"}</p>}>
          {(v) => (
            <>
              <section>
                <h3>Capture hotkey</h3>
                <p class="hint">Opens the small capture window from any app. Type, then Esc saves and closes it.</p>
                <Show
                  when={v().hotkeySupported}
                  fallback={
                    <p class="hint">
                      On Wayland the compositor owns the keys. In Hyprland, add to your config:
                      <code class="block">bind = SUPER, N, exec, petrel --capture</code>
                    </p>
                  }
                >
                  <div class="setting-row">
                    <span class="keys">
                      <Show when={recording()} fallback={<Show when={v().hotkey} fallback={<span class="meta">none</span>}>{(h) => <For each={caps(h())}>{(k) => <kbd>{k}</kbd>}</For>}</Show>}>
                        <span class="meta">Press the keys… (Esc cancels)</span>
                      </Show>
                    </span>
                    <span class="grow" />
                    <button disabled={busy()} onClick={() => (setError(null), setRecording(true))}>
                      Change
                    </button>
                    <Show when={v().hotkey !== v().hotkeyDefault}>
                      <button disabled={busy()} onClick={() => setHotkey(v().hotkeyDefault)}>
                        Use {v().hotkeyDefault.replace(/\+/g, " ")}
                      </button>
                    </Show>
                    <Show when={v().hotkey}>
                      <button disabled={busy()} onClick={() => setHotkey(null)}>
                        Turn off
                      </button>
                    </Show>
                  </div>
                  <p class="hint" classList={{ warn: !!v().hotkey && !v().hotkeyActive && !v().hotkeyPaused }}>
                    {status()}
                  </p>
                </Show>
              </section>
              <section>
                <h3>Start at login</h3>
                <label class="setting-row">
                  <input
                    type="checkbox"
                    checked={v().autostart}
                    disabled={busy()}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      void apply(async () => (await api).setAutostart(on));
                    }}
                  />
                  <span>Start Petrel when you log in, waiting in the tray, so the first capture is instant.</span>
                </label>
                <Show when={v().autostartError}>
                  <p class="hint warn">{v().autostartError}</p>
                </Show>
              </section>
              <Show when={error()}>
                <p class="hint warn">{error()}</p>
              </Show>
            </>
          )}
        </Show>
        <div class="buttons">
          <button onClick={props.onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
