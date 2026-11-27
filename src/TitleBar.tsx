// Petrel's unified quiet top bar: one chrome strip with zero duplicate New/Settings buttons.
// Left: sidebar toggle + interactive breadcrumb (clicking the folder pill opens inline Move).
// Right: search trigger (Ctrl K), in-place Read toggle (Ctrl E), Inspector toggle (Ctrl .), and Windows frame buttons.

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { inTauri } from "./api";
import { folderName, Kbd } from "./ui";
import { keyLabel } from "./keys";

export const ownFrame = inTauri && !navigator.userAgent.includes("Linux");

async function win() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

const Icon = {
  sidebar: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  ),
  search: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  read: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3H12v18H4.5A2.5 2.5 0 0 1 2 18.5v-13zM22 5.5A2.5 2.5 0 0 0 19.5 3H12v18h7.5a2.5 2.5 0 0 0 2.5-2.5v-13z" />
    </svg>
  ),
  inspector: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  ),
};

export default function TitleBar(p: {
  title: string;
  /** Current note's folder, when editing a saved note (clickable for inline Move). */
  folder?: string | null;
  canMove?: boolean;
  onMove?(anchor: { x: number; y: number }): void;
  sidebar: boolean;
  onSidebar(): void;
  onSearch(): void;
  /** Note-level inline toggles (Read mode & right Inspector). */
  onNote?: boolean;
  readMode?: boolean;
  onToggleRead?(): void;
  inspectorOpen?: boolean;
  onToggleInspector?(): void;
}) {
  const [max, setMax] = createSignal(false);
  onMount(async () => {
    if (!ownFrame) return;
    const w = await win();
    const read = () => void w.isMaximized().then(setMax, () => {});
    read();
    const stop = await w.onResized(read);
    onCleanup(stop);
  });
  const button = (b: "min" | "max" | "close") =>
    void win().then((w) => (b === "min" ? w.minimize() : b === "max" ? w.toggleMaximize() : w.close()).catch(() => {}));

  return (
    <header class="titlebar" data-tauri-drag-region="deep">
      <div class="titlebar-left">
        <button
          type="button"
          class="icon-btn"
          classList={{ on: p.sidebar }}
          onClick={p.onSidebar}
          title={p.sidebar ? `Hide sidebar (${keyLabel("sidebar")})` : `Show sidebar (${keyLabel("sidebar")})`}
          aria-label={p.sidebar ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={p.sidebar}
        >
          {Icon.sidebar}
        </button>
        <div class="titlebar-crumb" data-tauri-drag-region>
          <Show when={p.folder != null}>
            <Show
              when={p.canMove && p.onMove}
              fallback={<span class="crumb-folder">{folderName(p.folder!)}</span>}
            >
              <button
                type="button"
                class="crumb-folder clickable"
                title={`Move note (${keyLabel("move")})`}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  p.onMove?.({ x: r.left, y: r.bottom + 6 });
                }}
              >
                {folderName(p.folder!)} <span aria-hidden="true">▾</span>
              </button>
            </Show>
            <span class="crumb-sep" aria-hidden="true">/</span>
          </Show>
          <span class="titlebar-title" data-tauri-drag-region>
            {p.title}
          </span>
        </div>
      </div>

      <div class="titlebar-right">
        <button type="button" class="titlebar-search" onClick={p.onSearch} title={`Find, command, or ask (${keyLabel("find")})`}>
          {Icon.search}
          <span class="titlebar-search-label">Find or ask</span>
          <Kbd keys={keyLabel("find")} />
        </button>
        <Show when={p.onNote}>
          <button
            type="button"
            class="icon-btn"
            classList={{ on: !!p.readMode }}
            onClick={p.onToggleRead}
            title={p.readMode ? `Back to editing (${keyLabel("read")})` : `Read view (${keyLabel("read")})`}
            aria-label={p.readMode ? "Back to editing" : "Read view"}
            aria-pressed={!!p.readMode}
          >
            {Icon.read}
          </button>
          <button
            type="button"
            class="icon-btn"
            classList={{ on: !!p.inspectorOpen }}
            onClick={p.onToggleInspector}
            title={`Inspector: Outline, Links & History (${keyLabel("inspector")})`}
            aria-label="Toggle Inspector"
            aria-pressed={!!p.inspectorOpen}
          >
            {Icon.inspector}
          </button>
        </Show>
        <Show when={ownFrame}>
          <div class="window-buttons">
            <button type="button" onClick={() => button("min")} title="Minimize" aria-label="Minimize">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 5h10" stroke="currentColor" />
              </svg>
            </button>
            <button type="button" onClick={() => button("max")} title={max() ? "Restore" : "Maximize"} aria-label={max() ? "Restore" : "Maximize"}>
              <Show
                when={max()}
                fallback={
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <rect x="0.5" y="0.5" width="9" height="9" rx="1" stroke="currentColor" />
                  </svg>
                }
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <rect x="0.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" />
                  <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" stroke="currentColor" />
                </svg>
              </Show>
            </button>
            <button type="button" class="close" onClick={() => button("close")} title="Close" aria-label="Close">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" />
              </svg>
            </button>
          </div>
        </Show>
      </div>
    </header>
  );
}
