// Settings (`Ctrl ,`): the Petrel folder (put it inside Google Drive to sync), AI with your own Claude key, the
// two hotkeys, start at login, how the page looks and feels.

import { createResource, createSignal, For, Show } from "solid-js";
import { api, errText, type AiStatus, type DesktopSettings } from "../api";
import { say } from "../ui";
import { tick } from "../joy/sound";
import { applyPrefs, FONTS, prefs, setPrefs, SIZES, storedValue, THEMES, type Prefs } from "./prefs";

/** Ctrl+Alt with a letter, digit or sign is AltGr+that key to Windows, which types a character on many layouts. */
export function typesCharacter(hotkey: string): boolean {
  const parts = hotkey.split("+").map((x) => x.trim().toLowerCase());
  const key = parts[parts.length - 1] ?? "";
  const mods = parts.slice(0, -1);
  const altGr = mods.includes("alt") && (mods.includes("ctrl") || mods.includes("control"));
  return altGr && !mods.includes("shift") && (key.length === 1 || /^(key|digit)[a-z0-9]$/.test(key));
}

export default function Settings(p: { section?: "ai"; onClose(): void; onRoot(root: string): void; onAi(s: AiStatus): void }) {
  const [info, { refetch: refetchInfo }] = createResource(async () => (await api()).notesInfo());
  const [desk, { mutate: setDesk }] = createResource<DesktopSettings>(async () => (await api()).desktopSettings());
  const [ai, { mutate: setAi }] = createResource<AiStatus>(async () => (await api()).aiStatus());
  const [key, setKey] = createSignal("");
  const [hk, setHk] = createSignal<{ capture?: string; picker?: string }>({});

  const pref = async <K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    const next = { ...prefs(), [k]: v };
    setPrefs(next);
    applyPrefs(next);
    const [sk, sv] = storedValue(k, v);
    await (await api()).setUiSetting(sk, sv).catch((e) => say(errText(e), { error: true }));
  };

  async function chooseFolder() {
    const s = await api();
    const picked = await s.pickFolder();
    if (!picked) return;
    try {
      const r = await s.setNotesRoot(picked);
      await refetchInfo();
      p.onRoot(r.root);
      say(`Petrel now reads ${r.root}: ${r.added} notes found`);
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function saveKey(k: string | null) {
    try {
      const st = await (await api()).setAiKey(k);
      setAi(st);
      p.onAi(st);
      setKey("");
      say(k ? "Key saved in the system keyring" : "Key removed");
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function setHotkey(which: "capture" | "picker") {
    const v = hk()[which];
    if (v === undefined) return;
    try {
      setDesk(await (await api()).setHotkey(which, v.trim() || null));
      setHk({ ...hk(), [which]: undefined });
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  const drive = () => /google drive|googledrive|my drive/i.test(info()?.root ?? "");

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()} onKeyDown={(e) => e.key === "Escape" && p.onClose()}>
      <div class="dialog settings" tabindex={-1} ref={(el) => setTimeout(() => el.focus())}>
        <header class="dialog-head">
          <h2>Settings</h2>
          <span class="grow" />
          <button class="btn" onClick={p.onClose}>
            Done <kbd>Esc</kbd>
          </button>
        </header>

        <section>
          <h3>Your Petrel folder</h3>
          <p class="muted">Every note, capture and collection is a Markdown file here. Put it inside your Google Drive folder and Drive keeps a copy on every computer.</p>
          <div class="row">
            <code class="path">{info()?.root ?? "…"}</code>
            <button class="btn" onClick={chooseFolder}>
              Change…
            </button>
          </div>
          <Show when={!drive()}>
            <p class="muted small">
              Windows: Google Drive for desktop, "Mirror files", then a folder under <code>My Drive</code>. Linux: rclone bisync or Syncthing to the same folder.
            </p>
          </Show>
          <p class="muted small">If a note changes in two places, Petrel keeps both copies and tells you. The index lives outside the folder and is rebuilt from it.</p>
        </section>

        <section classList={{ highlight: p.section === "ai" }}>
          <h3>
            <span class="spark">✦</span> AI
          </h3>
          <p class="muted">Claude runs only when you ask: Ctrl J on a selection, / on an empty line, S in the inbox, a question in Ctrl K. It uses your own Claude API key, kept in the system keyring.</p>
          <Show
            when={ai()?.ready}
            fallback={
              <form
                class="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (key().trim()) void saveKey(key().trim());
                }}
              >
                <input class="grow" type="password" placeholder="sk-ant-…" value={key()} onInput={(e) => setKey(e.currentTarget.value)} autocomplete="off" />
                <button class="btn primary" type="submit" disabled={!key().trim()}>
                  Save key
                </button>
              </form>
            }
          >
            <div class="row">
              <span class="ok">On · {ai()!.model}</span>
              <span class="grow" />
              <button class="btn" onClick={() => saveKey(null)}>
                Remove key
              </button>
            </div>
          </Show>
          <Show when={ai()?.error}>
            <p class="bad small">{ai()!.error}</p>
          </Show>
          <p class="muted small">Get a key at console.anthropic.com. A short rewrite costs well under a cent.</p>
        </section>

        <section>
          <h3>Hotkeys</h3>
          <Show
            when={desk()?.hotkeySupported !== false}
            fallback={
              <p class="muted">
                On Wayland your compositor binds keys. In Hyprland: <code>bind = SUPER, N, exec, petrel --capture</code> and <code>bind = SUPER, V, exec, petrel --picker</code>.
              </p>
            }
          >
            <For each={["capture", "picker"] as const}>
              {(w) => {
                const cur = () => (w === "capture" ? desk()?.hotkey : desk()?.pickerHotkey) ?? "";
                const err = () => (w === "capture" ? desk()?.hotkeyError : desk()?.pickerHotkeyError);
                return (
                  <div class="row">
                    <span class="label">{w === "capture" ? "Quick capture" : "Quick picker"}</span>
                    <input
                      value={hk()[w] ?? cur()}
                      placeholder="off"
                      onInput={(e) => setHk({ ...hk(), [w]: e.currentTarget.value })}
                      onKeyDown={(e) => e.key === "Enter" && setHotkey(w)}
                    />
                    <button class="btn" disabled={hk()[w] === undefined} onClick={() => setHotkey(w)}>
                      Set
                    </button>
                    <Show when={err()}>
                      <span class="bad small">{err()}</span>
                    </Show>
                    <Show when={!err() && typesCharacter(hk()[w] ?? cur())}>
                      <span class="bad small">Ctrl Alt with a key is AltGr on many keyboards (AltGr V is @ in Bosnian): it would take that character from every app.</span>
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
          <label class="row check">
            <input
              type="checkbox"
              checked={desk()?.autostart ?? false}
              onChange={async (e) => {
                try {
                  setDesk(await (await api()).setAutostart(e.currentTarget.checked));
                } catch (err) {
                  say(errText(err), { error: true });
                }
              }}
            />
            Start Petrel at login, in the tray, so capture is instant
          </label>
          <label class="row check">
            <input type="checkbox" checked={prefs().captureSelection} onChange={(e) => pref("captureSelection", e.currentTarget.checked)} />
            Bring the text selected in the app you were in into a capture, as a quote with where it came from
          </label>
        </section>

        <section>
          <h3>Look</h3>
          <div class="row">
            <span class="label">Paper</span>
            <div class="seg">
              <For each={THEMES}>
                {(t) => (
                  <button classList={{ on: prefs().theme === t.id }} onClick={() => pref("theme", t.id)}>
                    {t.label}
                  </button>
                )}
              </For>
            </div>
          </div>
          <Show when={prefs().theme === "clock"}>
            <p class="muted small">Paper by day, Linen from 19:00, Night from 23:00 until 7:00.</p>
          </Show>
          <div class="row">
            <span class="label">Writing font</span>
            <div class="seg">
              <For each={FONTS}>
                {(f) => (
                  <button classList={{ on: prefs().writeFont === f.id }} style={{ "font-family": f.css }} onClick={() => pref("writeFont", f.id)}>
                    {f.label}
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="row">
            <span class="label">Writing size</span>
            <div class="seg">
              <For each={SIZES}>
                {(s) => (
                  <button classList={{ on: prefs().editorSize === s }} onClick={() => pref("editorSize", s)}>
                    {s}
                  </button>
                )}
              </For>
            </div>
          </div>
          <label class="row check">
            <input type="checkbox" checked={prefs().typewriter} onChange={(e) => pref("typewriter", e.currentTarget.checked)} />
            Typewriter scrolling: the line you type stays in the middle
          </label>
          <label class="row check">
            <input type="checkbox" checked={prefs().focus} onChange={(e) => pref("focus", e.currentTarget.checked)} />
            Paragraph focus: the other paragraphs fade while you type
          </label>
        </section>

        <section>
          <h3>Feel</h3>
          <label class="row check">
            <input type="checkbox" checked={prefs().petrel} onChange={(e) => pref("petrel", e.currentTarget.checked)} />
            The petrel crosses the page when the Inbox is clear
          </label>
          <label class="row check">
            <input
              type="checkbox"
              checked={prefs().sound}
              onChange={(e) => {
                void pref("sound", e.currentTarget.checked);
                if (e.currentTarget.checked) tick();
              }}
            />
            A soft pencil sound as you type
          </label>
          <p class="muted small">No streaks, no badges, nothing that counts against you.</p>
        </section>
      </div>
    </div>
  );
}
