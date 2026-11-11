// The sidebar, as in Tern: where you are, on the left. New note, today's page, the inbox and the open tasks, then
// the collections, the ones to copy first and the pages after. A collection is managed right here: F2 or a
// double-click renames it, right-click (or ⋯) has the rest, and the last row makes a new one. Docked beside the
// page on a wide window; on a narrow one it slides over and closes after a pick. Ctrl 0 shows or hides it.

import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type NoteFolder } from "./api";
import { clock } from "./journal/days";
import FacePicker from "./library/FacePicker";
import Mark, { faces, loadFaces, saveFace } from "./library/Mark";
import { toCopy } from "./library/faces";
import { folderName, Kbd, say } from "./ui";

export type Place = "today" | "inbox" | "tasks" | `c:${string}` | null;

interface Data {
  folders: NoteFolder[];
  inbox: number;
  tasks: number;
}

async function load(): Promise<Data> {
  const s = await api();
  const [folders, inbox, tasks] = await Promise.all([
    s.noteFolders(),
    s.listNotes({ folder: "inbox", limit: 1000 }).then((n) => n.length, () => 0),
    s.openTasks().then((t) => t.length, () => 0),
  ]);
  return { folders: folders.filter((f) => f.path !== "inbox" && !f.path.startsWith(".")), inbox, tasks };
}

export default function Sidebar(p: {
  rev: number;
  here: Place;
  docked: boolean;
  root: string;
  onNew(): void;
  onToday(): void;
  onInbox(): void;
  onTasks(): void;
  onCollection(folder: string): void;
  /** A collection was renamed or trashed: what is open may have moved. */
  onFolderChanged(from: string, to: string | null): void;
  onSettings(): void;
  onClose(): void;
}) {
  const [data, { refetch }] = createResource(() => p.rev, load);
  const [now, setNow] = createSignal(clock());
  const [renaming, setRenaming] = createSignal<string | null>(null);
  // `""` makes a top collection; a path makes one inside it.
  const [making, setMaking] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<{ folder: string; x: number; y: number; sure: boolean } | null>(null);
  const [facing, setFacing] = createSignal<string | null>(null);

  onMount(() => {
    void loadFaces();
    const t = setInterval(() => setNow(clock()), 30_000);
    const away = (e: MouseEvent) => menu() && !(e.target as HTMLElement).closest(".side-menu") && setMenu(null);
    document.addEventListener("mousedown", away);
    onCleanup(() => (clearInterval(t), document.removeEventListener("mousedown", away)));
  });

  const tops = () => (data()?.folders ?? []).filter((f) => f.depth === 0);
  const kids = (top: string) => (data()?.folders ?? []).filter((f) => f.depth === 1 && f.path.startsWith(`${top}/`));
  const count = (path: string) => (data()?.folders ?? []).filter((f) => f.path === path || f.path.startsWith(`${path}/`)).reduce((a, f) => a + f.count, 0);
  const copyTops = () => tops().filter((f) => toCopy(f.path, faces()));
  const pageTops = () => tops().filter((f) => !toCopy(f.path, faces()));
  const open = (folder: string) => p.here === `c:${folder}` || (p.here?.startsWith(`c:${folder}/`) ?? false);

  async function rename(folder: string, name: string) {
    setRenaming(null);
    const n = name.trim();
    if (!n || n === folderName(folder)) return;
    try {
      const to = await (await api()).renameFolder(folder, n);
      say(`Renamed to ${folderName(to)}`);
      p.onFolderChanged(folder, to);
      void refetch();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function make(parent: string, name: string) {
    setMaking(null);
    const n = name.trim();
    if (!n) return;
    try {
      const made = await (await api()).createFolder(parent ? `${parent}/${n}` : n);
      void refetch();
      p.onCollection(made);
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function trash(folder: string) {
    setMenu(null);
    try {
      const k = await (await api()).trashFolder(folder);
      say(`${folderName(folder)} and its ${k} ${k === 1 ? "note" : "notes"} are in the trash in your folder`);
      p.onFolderChanged(folder, null);
      void refetch();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  const setKind = async (folder: string, copy: "yes" | "no") => {
    const f = faces()[folder] ?? { color: "", mark: "" };
    await saveFace(folder, { color: f.color, mark: f.mark, copy }).catch((e) => say(errText(e), { error: true }));
  };

  const pick = (go: () => void) => () => {
    go();
    if (!p.docked) p.onClose();
  };

  const nameInput = (start: string, done: (v: string) => void, cancel: () => void, label: string) => (
    <input
      class="side-input"
      aria-label={label}
      value={start}
      placeholder={start ? "" : "Name"}
      ref={(el) => setTimeout(() => (el.focus(), el.select()))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(e.currentTarget.value);
        else if (e.key === "Escape") cancel();
      }}
      onBlur={(e) => (e.currentTarget.value.trim() && e.currentTarget.value !== start ? done(e.currentTarget.value) : cancel())}
    />
  );

  const row = (f: NoteFolder, child = false) => (
    <>
      <Show
        when={renaming() !== f.path}
        fallback={
          <div class="side-row editing" classList={{ child }}>
            <Mark folder={f.path} size={12} />
            {nameInput(folderName(f.path), (v) => void rename(f.path, v), () => setRenaming(null), `Rename ${folderName(f.path)}`)}
          </div>
        }
      >
        <button
          type="button"
          class="side-row"
          classList={{ on: p.here === `c:${f.path}`, child }}
          onClick={pick(() => p.onCollection(f.path))}
          onDblClick={() => setRenaming(f.path)}
          onKeyDown={(e) => e.key === "F2" && (e.preventDefault(), setRenaming(f.path))}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ folder: f.path, x: e.clientX, y: e.clientY, sure: false });
          }}
          title="F2 renames · right-click for more"
        >
          <Show when={!child} fallback={<span class="side-slot" />}>
            <Mark folder={f.path} size={12} />
          </Show>
          <span class="side-name">{folderName(f.path)}</span>
          <span class="side-count">{count(f.path) || ""}</span>
          <span
            class="side-more"
            role="button"
            tabIndex={-1}
            aria-label={`More for ${folderName(f.path)}`}
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ folder: f.path, x: r.left, y: r.bottom + 4, sure: false });
            }}
          >
            ⋯
          </span>
        </button>
      </Show>
      <Show when={!child && (open(f.path) || making() === f.path)}>
        <For each={kids(f.path)}>{(k) => row(k, true)}</For>
        <Show when={making() === f.path}>
          <div class="side-row editing child">{nameInput("", (v) => void make(f.path, v), () => setMaking(null), `New collection inside ${folderName(f.path)}`)}</div>
        </Show>
      </Show>
    </>
  );

  return (
    <nav class="sidebar" classList={{ docked: p.docked }} aria-label="Sidebar">
      <button type="button" class="side-new" onClick={pick(p.onNew)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        New note
        <Kbd keys="Ctrl N" />
      </button>

      <div class="side-group">
        <button type="button" class="side-row" classList={{ on: p.here === "today" }} onClick={pick(p.onToday)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <rect x="4" y="5" width="16" height="15" rx="2" />
            <path d="M8 3v4M16 3v4M4 10h16" />
          </svg>
          <span class="side-name">Today</span>
          <span class="side-count">{now()}</span>
        </button>
        <button type="button" class="side-row" classList={{ on: p.here === "inbox" }} onClick={pick(p.onInbox)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z" />
          </svg>
          <span class="side-name">Inbox</span>
          <span class="side-count">{data()?.inbox || ""}</span>
        </button>
        <button type="button" class="side-row" classList={{ on: p.here === "tasks" }} onClick={pick(p.onTasks)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="4" y="4" width="16" height="16" rx="3" />
            <path d="M8 12l3 3 5-6" />
          </svg>
          <span class="side-name">Open tasks</span>
          <span class="side-count">{data()?.tasks || ""}</span>
        </button>
      </div>

      <div class="side-scroll">
        <Show when={copyTops().length}>
          <div class="side-head">To copy</div>
          <For each={copyTops()}>{(f) => row(f)}</For>
        </Show>
        <Show when={pageTops().length}>
          <div class="side-head">Pages</div>
          <For each={pageTops()}>{(f) => row(f)}</For>
        </Show>
        <Show
          when={making() === ""}
          fallback={
            <button type="button" class="side-row side-add" onClick={() => setMaking("")}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span class="side-name">New collection</span>
            </button>
          }
        >
          <div class="side-row editing">{nameInput("", (v) => void make("", v), () => setMaking(null), "New collection")}</div>
          <p class="side-hint">A collection is a folder. Enter makes it; pages or things to copy is in its ⋯ menu.</p>
        </Show>
      </div>

      <footer class="side-foot">
        <span class="side-root" title={p.root}>
          {/google drive|googledrive|my drive/i.test(p.root) ? "Google Drive" : p.root.split(/[\\/]/).filter(Boolean).pop() ?? ""}
        </span>
        <button type="button" class="icon-btn" title="Settings (Ctrl ,)" aria-label="Settings" onClick={p.onSettings}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </footer>

      <Show when={menu()}>
        {(m) => (
          <div class="side-menu menu" role="menu" aria-label={folderName(m().folder)} style={{ left: `${Math.min(m().x, innerWidth - 250)}px`, top: `${Math.min(m().y, innerHeight - 300)}px` }}>
            <button type="button" class="menu-item" role="menuitem" onClick={() => (setRenaming(m().folder), setMenu(null))}>
              <span>Rename</span>
              <span class="muted">F2</span>
            </button>
            <button type="button" class="menu-item" role="menuitem" onClick={() => (setFacing(m().folder.split("/")[0]), setMenu(null))}>
              <span>Colour and mark</span>
            </button>
            <Show when={!m().folder.includes("/")}>
              <div class="side-kind">
                <span class="muted small">Holds</span>
                <span class="seg">
                  <button type="button" classList={{ on: toCopy(m().folder, faces()) }} onClick={() => void setKind(m().folder, "yes")}>
                    To copy
                  </button>
                  <button type="button" classList={{ on: !toCopy(m().folder, faces()) }} onClick={() => void setKind(m().folder, "no")}>
                    Pages
                  </button>
                </span>
              </div>
            </Show>
            <Show when={!m().folder.includes("/")}>
              <button type="button" class="menu-item" role="menuitem" onClick={() => (setMaking(m().folder), setMenu(null))}>
                <span>New collection inside</span>
              </button>
            </Show>
            <button type="button" class="menu-item" role="menuitem" onClick={() => (void api().then((s) => s.revealFolder(m().folder)).catch((e) => say(errText(e), { error: true })), setMenu(null))}>
              <span>Show in the folder</span>
            </button>
            <div class="menu-sep" />
            <button type="button" class="menu-item bad" role="menuitem" onClick={() => (m().sure ? void trash(m().folder) : setMenu({ ...m(), sure: true }))}>
              <span>{m().sure ? `Yes, move ${count(m().folder)} notes to the trash` : "Move to the trash…"}</span>
            </button>
          </div>
        )}
      </Show>
      <Show when={facing()}>{(top) => <FacePicker top={top()} onClose={() => setFacing(null)} />}</Show>
    </nav>
  );
}
