// Settings (`Ctrl ,`, or the sliders in the title bar): a screen of its own, the categories on the left. General
// (the folder, start at login), Writing, Look, Capture, Keys (every shortcut on this computer, changeable), AI and
// About. Each change is saved at once; Esc goes back.

import { createResource, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { api, errText, type AiStatus, type DesktopSettings } from "../api";
import { comboOf, conflicts, customKeys, hyprBind, keyOf, platform, setCustomKeys, SHORTCUTS, typesCharacter, type Shortcut } from "../keys";
import { keyChips } from "../Shortcuts";
import { Kbd, say } from "../ui";
import { tick } from "../joy/sound";
import { applyPrefs, FONTS, prefs, setPrefs, SIZES, storedValue, THEMES, type Prefs } from "./prefs";

export { typesCharacter };

export type Section = "general" | "writing" | "look" | "capture" | "keys" | "ai" | "about";

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "M3 7h18M3 12h18M3 17h18" },
  { id: "writing", label: "Writing", icon: "M4 20h4L19 9l-4-4L4 16z" },
  { id: "look", label: "Look", icon: "M12 3a9 9 0 1 0 9 9c0-1-1-2-2-2h-2a2 2 0 0 1-2-2V6c0-1-1-3-3-3z" },
  { id: "capture", label: "Capture", icon: "M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z" },
  { id: "keys", label: "Keys", icon: "M3 7h18v10H3zM7 11h1M11 11h1M15 11h2M7 14h10" },
  { id: "ai", label: "AI", icon: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" },
  { id: "about", label: "About", icon: "M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" },
];

function Row(p: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <div class="set-row">
      <div class="set-label">
        <span>{p.label}</span>
        <Show when={p.hint}>
          <span class="muted small">{p.hint}</span>
        </Show>
      </div>
      <div class="set-control">{p.children}</div>
    </div>
  );
}

function Toggle(p: { on: boolean; label: string; hint?: string; onChange(on: boolean): void }) {
  return (
    <label class="set-row set-toggle">
      <div class="set-label">
        <span>{p.label}</span>
        <Show when={p.hint}>
          <span class="muted small">{p.hint}</span>
        </Show>
      </div>
      <input type="checkbox" role="switch" checked={p.on} onChange={(e) => p.onChange(e.currentTarget.checked)} />
    </label>
  );
}

/** One line under each paper in Settings › Look. */
const PAPER_SAY: Record<string, string> = {
  light: "Cool white, for the day",
  linen: "Warm, for long writing",
  dark: "Dark, for the evening",
  system: "Light or dark, as the system is",
  clock: "Paper, Linen, then Night",
};

export default function Settings(p: { section?: Section | "all"; onClose(): void; onRoot(root: string): void; onAi(s: AiStatus): void }) {
  const [at, setAt] = createSignal<Section>(p.section && p.section !== "all" ? p.section : "general");
  const [info, { refetch: refetchInfo }] = createResource(async () => (await api()).notesInfo());
  const [app] = createResource(async () => (await api()).appInfo());
  const [desk, { mutate: setDesk }] = createResource<DesktopSettings>(async () => (await api()).desktopSettings());
  const [ai, { mutate: setAi }] = createResource<AiStatus>(async () => (await api()).aiStatus());
  const [key, setKey] = createSignal("");
  // The shortcut waiting for its new key.
  const [listening, setListening] = createSignal<string | null>(null);

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

  // ---- keys -----------------------------------------------------------------------------------------------------

  /** Global hotkeys are registered by Petrel on Windows and X11; on Wayland the compositor binds them. */
  const systemBinds = () => desk()?.hotkeySupported !== false;
  const shown = (s: Shortcut) => {
    if (s.global === "capture" && systemBinds()) return desk()?.hotkey ?? "off";
    if (s.global === "picker" && systemBinds()) return desk()?.pickerHotkey ?? "off";
    return keyOf(s.id);
  };

  async function setShortcut(s: Shortcut, combo: string | null) {
    setListening(null);
    if (s.global && systemBinds()) {
      try {
        setDesk(await (await api()).setHotkey(s.global, combo));
      } catch (e) {
        say(errText(e), { error: true });
      }
      return;
    }
    const mine = { ...(customKeys()[platform] ?? {}) };
    if (combo === null || combo === s.keys[platform]) delete mine[s.id];
    else mine[s.id] = combo;
    const next = { ...customKeys(), [platform]: mine };
    setCustomKeys(next);
    await (await api()).setUiSetting("ui.keys", JSON.stringify(next)).catch((e) => say(errText(e), { error: true }));
  }

  const listen = (e: KeyboardEvent) => {
    const id = listening();
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setListening(null);
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    const combo = comboOf(e);
    if (!combo.includes("+")) return say("A shortcut needs Ctrl, Alt or Shift with the key");
    const s = SHORTCUTS.find((x) => x.id === id);
    if (s) void setShortcut(s, combo);
  };
  const escape = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !listening() && !(e.target instanceof HTMLInputElement && e.target.value)) {
      e.preventDefault();
      p.onClose();
    }
  };
  onMount(() => {
    document.addEventListener("keydown", listen, true);
    document.addEventListener("keydown", escape);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", listen, true);
    document.removeEventListener("keydown", escape);
  });

  const clash = () => conflicts(platform);
  const copyBind = async (line: string) => {
    await (await api()).copyText(line, false).catch(() => {});
    say("Copied. Paste it into your Hyprland config (Omarchy: ~/.config/hypr/bindings.conf).");
  };

  const drive = () => /google drive|googledrive|my drive/i.test(info()?.root ?? "");

  return (
    <div class="settings-page" role="dialog" aria-label="Settings">
      <nav class="set-nav" aria-label="Settings sections">
        <h2>Settings</h2>
        <For each={SECTIONS}>
          {(s) => (
            <button type="button" class="side-row" classList={{ on: at() === s.id }} onClick={() => setAt(s.id)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d={s.icon} />
              </svg>
              <span class="side-name">{s.label}</span>
            </button>
          )}
        </For>
        <span class="grow" />
        <button type="button" class="btn wide" onClick={p.onClose}>
          Back to writing <kbd>Esc</kbd>
        </button>
      </nav>

      <div class="set-body">
        <Show when={at() === "general"}>
          <h1>General</h1>
          <section class="set-card">
            <Row label="Your Petrel folder" hint="Every note is a Markdown file here. Put it in Google Drive and every computer has it.">
              <code class="path">{info()?.root ?? "…"}</code>
              <button class="btn" onClick={chooseFolder}>
                Change…
              </button>
            </Row>
            <Show when={!drive()}>
              <p class="muted small set-note">
                Windows: Google Drive for desktop, "Mirror files", then a folder under <code>My Drive</code>. Linux: rclone bisync or Syncthing to the same folder.
              </p>
            </Show>
            <p class="muted small set-note">If a note changes in two places, Petrel keeps both and shows a card to settle it. The index lives outside the folder and is rebuilt from it.</p>
          </section>
          <section class="set-card">
            <Toggle
              label="Start Petrel at login"
              hint="In the tray, so capture is instant."
              on={desk()?.autostart ?? false}
              onChange={async (on) => {
                try {
                  setDesk(await (await api()).setAutostart(on));
                } catch (err) {
                  say(errText(err), { error: true });
                }
              }}
            />
            <Toggle label="The petrel" hint="It crosses the page once when the inbox is clear." on={prefs().petrel} onChange={(on) => void pref("petrel", on)} />
          </section>
        </Show>

        <Show when={at() === "writing"}>
          <h1>Writing</h1>
          <section class="set-card">
            <Row label="Font">
              <div class="seg wrap">
                <For each={FONTS}>
                  {(f) => (
                    <button classList={{ on: prefs().writeFont === f.id }} style={{ "font-family": f.css }} onClick={() => pref("writeFont", f.id)}>
                      {f.label}
                    </button>
                  )}
                </For>
              </div>
            </Row>
            <Row label="Size">
              <div class="seg">
                <For each={SIZES}>
                  {(s) => (
                    <button classList={{ on: prefs().editorSize === s }} onClick={() => pref("editorSize", s)}>
                      {s}
                    </button>
                  )}
                </For>
              </div>
            </Row>
            <p class="set-sample" style={{ "font-family": FONTS.find((f) => f.id === prefs().writeFont)?.css, "font-size": `${prefs().editorSize}px` }}>
              Three days in May, by car from Sarajevo. Lejla knows a place by the river.
            </p>
          </section>
          <section class="set-card">
            <Toggle label="A quiet page" hint="The title bar, sidebar, margin and footer fade while you type. Move the mouse and they come back." on={prefs().quiet} onChange={(on) => void pref("quiet", on)} />
            <Toggle label="Paragraph focus" hint="The other paragraphs fade while you type." on={prefs().focus} onChange={(on) => void pref("focus", on)} />
            <Toggle label="Typewriter scrolling" hint="The line you type stays in the middle of the window." on={prefs().typewriter} onChange={(on) => void pref("typewriter", on)} />
            <Toggle
              label="A pencil sound as you type"
              hint="Soft, and only while the window is in front."
              on={prefs().sound}
              onChange={(on) => {
                void pref("sound", on);
                if (on) tick();
              }}
            />
          </section>
        </Show>

        <Show when={at() === "look"}>
          <h1>Look</h1>
          <section class="set-card">
            <Row label="Paper" hint={prefs().theme === "clock" ? "Paper by day, Linen from 19:00, Night from 23:00 until 7:00." : undefined}>
              <div class="papers">
                <For each={THEMES}>
                  {(t) => (
                    <button class="paper" classList={{ on: prefs().theme === t.id }} data-paper={t.id} onClick={() => pref("theme", t.id)} aria-pressed={prefs().theme === t.id}>
                      {/* A small page in that paper: a title, lines of text, a link in the accent. */}
                      <span class="paper-mini" aria-hidden="true">
                        <span class="pm-title" />
                        <span class="pm-line" />
                        <span class="pm-line" />
                        <span class="pm-line short" />
                        <span class="pm-link" />
                      </span>
                      <span class="paper-name">{t.label}</span>
                      <span class="paper-say">{PAPER_SAY[t.id]}</span>
                    </button>
                  )}
                </For>
              </div>
            </Row>
          </section>
        </Show>

        <Show when={at() === "capture"}>
          <h1>Capture</h1>
          <section class="set-card">
            <Toggle
              label="Bring the selection along"
              hint="Text selected in the app you were in comes into a capture as a quote, with where it came from. The picker uses it for {{selection}}."
              on={prefs().captureSelection}
              onChange={(on) => void pref("captureSelection", on)}
            />
          </section>
          <section class="set-card">
            <p class="set-note">
              In the capture window, <kbd>@</kbd> says where it goes: <code>@recipes</code> a collection, <code>@today</code> or <code>@fri</code> a day's page, <code>@Groceries</code> the end of a note. A list
              offers places as you type after the <kbd>@</kbd>; <kbd>Ctrl K</kbd> there picks one from a list. Opened again within two minutes, the window adds to the last capture.
            </p>
            <p class="muted small set-note">The keys that open the capture window and the picker are under Keys.</p>
          </section>
        </Show>

        <Show when={at() === "keys"}>
          <h1>Keys</h1>
          <p class="muted">
            The shortcuts on this computer ({platform === "linux" ? "Omarchy" : "Windows"}). Click one and press the new keys; <kbd>Esc</kbd> cancels. All of them, with the fixed ones, are on <kbd>Shift</kbd> <kbd>?</kbd>.
          </p>
          <section class="set-card">
            <For each={SHORTCUTS.filter((s) => s.editable)}>
              {(s) => (
                <div class="set-row key-row">
                  <div class="set-label">
                    <span>{s.label}</span>
                    <Show when={s.global && !systemBinds()}>
                      <span class="muted small">Hyprland owns keys on Wayland: add this line to its config.</span>
                    </Show>
                    <Show when={clash()[s.id]}>
                      <span class="bad small">Same keys as “{SHORTCUTS.find((x) => x.id === clash()[s.id])?.label}”</span>
                    </Show>
                    <Show when={platform === "win" && typesCharacter(shown(s))}>
                      <span class="bad small">Ctrl Alt with a key is AltGr: it would take that character (AltGr V is @ in Bosnian).</span>
                    </Show>
                    <Show when={s.global === "capture" && systemBinds() && desk()?.hotkeyError}>
                      <span class="bad small">{desk()!.hotkeyError}</span>
                    </Show>
                    <Show when={s.global === "picker" && systemBinds() && desk()?.pickerHotkeyError}>
                      <span class="bad small">{desk()!.pickerHotkeyError}</span>
                    </Show>
                  </div>
                  <div class="set-control">
                    <Show when={s.global && !systemBinds()}>
                      <code class="bind-line">{hyprBind(s, keyOf(s.id))}</code>
                      <button class="btn small" onClick={() => void copyBind(hyprBind(s, keyOf(s.id)))}>
                        Copy
                      </button>
                    </Show>
                    <button class="key-btn" classList={{ listening: listening() === s.id }} onClick={() => setListening(listening() === s.id ? null : s.id)}>
                      <Show when={listening() !== s.id} fallback={<span class="muted">Press the keys…</span>}>
                        <Kbd keys={keyChips(shown(s))} />
                      </Show>
                    </button>
                    <Show when={!s.global && customKeys()[platform]?.[s.id]}>
                      <button class="link small" onClick={() => void setShortcut(s, null)}>
                        Reset
                      </button>
                    </Show>
                    <Show when={s.global && systemBinds()}>
                      <button class="link small" onClick={() => void setShortcut(s, s.keys.win)}>
                        Reset
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </section>
        </Show>

        <Show when={at() === "ai"}>
          <h1>
            <span class="spark">✦</span> AI
          </h1>
          <section class="set-card">
            <p class="set-note">
              Claude runs only when you ask: <kbd>Ctrl J</kbd> or <kbd>/</kbd> in a note, a question in <kbd>Ctrl K</kbd>, <kbd>s</kbd> on a capture. It uses your own Claude API key, kept in the system keyring.
            </p>
            <Show
              when={ai()?.ready}
              fallback={
                <form
                  class="set-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (key().trim()) void saveKey(key().trim());
                  }}
                >
                  <input class="grow" type="password" placeholder="sk-ant-…" aria-label="Claude API key" value={key()} onInput={(e) => setKey(e.currentTarget.value)} autocomplete="off" />
                  <button class="btn primary" type="submit" disabled={!key().trim()}>
                    Save key
                  </button>
                </form>
              }
            >
              <Row label="On" hint={ai()!.model}>
                <button class="btn" onClick={() => saveKey(null)}>
                  Remove key
                </button>
              </Row>
            </Show>
            <Show when={ai()?.error}>
              <p class="bad small set-note">{ai()!.error}</p>
            </Show>
            <p class="muted small set-note">Get a key at console.anthropic.com. A short rewrite costs well under a cent.</p>
          </section>
        </Show>

        <Show when={at() === "about"}>
          <h1>About</h1>
          <section class="set-card">
            <Row label="Petrel" hint="Quick notes and the things you copy, as Markdown files in one folder.">
              <span class="muted">{app()?.version ?? ""}</span>
            </Row>
            <Row label="Index" hint="Rebuilt from the folder whenever it is missing.">
              <code class="path">{app()?.dbPath ?? ""}</code>
            </Row>
            <p class="muted small set-note">No account, no telemetry. Nothing leaves this computer except what you send to Claude.</p>
          </section>
        </Show>
      </div>
    </div>
  );
}
