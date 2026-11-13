// Every shortcut on one sheet, grouped by where it works (Shift ? when not typing, or Ctrl /). The keys shown are
// this computer's, changed or not; Settings › Keys changes them.

import { For, onCleanup, onMount } from "solid-js";
import { keyOf, platform, SHORTCUTS, type Group } from "./keys";
import { Kbd } from "./ui";

const GROUPS: Group[] = ["Anywhere", "Writing", "Library", "Capture window", "Quick picker", "Lists and menus"];

/** `Ctrl+Shift+K` as the key chips draw it. */
export const keyChips = (k: string) => k.replace(/\+/g, " ").replace(/ {2,}/g, " ");

export default function Shortcuts(p: { onClose(): void; onSettings(): void }) {
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "?" || ((e.ctrlKey || e.metaKey) && e.key === "/")) {
      e.preventDefault();
      e.stopPropagation();
      p.onClose();
    }
  };
  onMount(() => document.addEventListener("keydown", key, true));
  onCleanup(() => document.removeEventListener("keydown", key, true));

  return (
    <div class="scrim top" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="panel shortcuts" role="dialog" aria-label="Shortcuts">
        <header class="shortcuts-head">
          <h2>Shortcuts</h2>
          <span class="muted small">{platform === "linux" ? "Omarchy (Linux)" : "Windows"}</span>
          <span class="grow" />
          <button class="link small" onClick={p.onSettings}>
            Change them in Settings
          </button>
          <button class="btn small" onClick={p.onClose}>
            Close <kbd>Esc</kbd>
          </button>
        </header>
        <div class="shortcuts-grid">
          <For each={GROUPS}>
            {(g) => (
              <section>
                <h3>{g}</h3>
                <For each={SHORTCUTS.filter((s) => s.group === g)}>
                  {(s) => (
                    <div class="shortcut-row">
                      <span>{s.label}</span>
                      <Kbd keys={keyChips(keyOf(s.id))} />
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
