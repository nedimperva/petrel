// Settings (`Ctrl ,`, ui.md §4.7): when a new draft opens, the editor's type, the capture hotkey and start at
// login. Each row says what it does and what state it is in, so nothing needs the docs. Changes apply at once.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, type DesktopSettings } from "../api";
import { applyEditorPrefs, prefs, type Prefs, setPrefs, SIZES, storedValue } from "./prefs";

interface Props {
  onClose(): void;
  /** A preference changed; the window applies what CSS can't (typewriter scrolling). */
  onPrefs(p: Prefs): void;
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

  async function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
    const next = { ...prefs(), [key]: value };
    setPrefs(next);
    applyEditorPrefs(next);
    props.onPrefs(next);
    try {
      await (await api).setUiSetting(...storedValue(key, value));
    } catch (e) {
      setError(`Not saved: ${e}`);
    }
  }

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
        <section>
          <h3>New draft</h3>
          <p class="hint">Coming back to Petrel with a draft open starts a fresh one; the old one stays in the Inbox.</p>
          <div class="setting-row">
            <select
              value={prefs().newDraft}
              onChange={(e) => setPref("newDraft", e.currentTarget.value as Prefs["newDraft"])}
            >
              <option value="away">After some time away</option>
              <option value="always">Every time</option>
              <option value="never">Never: keep the last draft</option>
            </select>
            <Show when={prefs().newDraft === "away"}>
              <input
                type="number"
                class="minutes"
                min="1"
                max="1440"
                value={prefs().awayMinutes}
                onChange={(e) => {
                  const n = Math.round(Number(e.currentTarget.value));
                  if (n >= 1 && n <= 1440) void setPref("awayMinutes", n);
                  else e.currentTarget.value = String(prefs().awayMinutes);
                }}
              />
              <span>minutes</span>
            </Show>
          </div>
        </section>
        <section>
          <h3>Editor</h3>
          <div class="setting-row">
            <span class="label">Text size</span>
            <select value={prefs().editorSize} onChange={(e) => setPref("editorSize", Number(e.currentTarget.value))}>
              <For each={SIZES}>{(n) => <option value={n}>{n} px</option>}</For>
            </select>
            <span class="label">Typeface</span>
            <select
              value={prefs().editorFont}
              onChange={(e) => setPref("editorFont", e.currentTarget.value as Prefs["editorFont"])}
            >
              <option value="sans">Sans</option>
              <option value="serif">Serif</option>
              <option value="mono">Monospace</option>
            </select>
          </div>
          <label class="setting-row">
            <input type="checkbox" checked={prefs().typewriter} onChange={(e) => setPref("typewriter", e.currentTarget.checked)} />
            <span>Typewriter scrolling: the line you type stays in the middle of the window.</span>
          </label>
          <p class="hint">
            <kbd>Ctrl Shift D</kbd> focus mode dims everything but the paragraph you're writing.
          </p>
        </section>
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
