// Home: one field to search or ask, the inbox at a glance, the collections as chips, and the notes as cards.

import { createResource, For, Show } from "solid-js";
import { api, type NoteSummary } from "../api";
import { plainText } from "../copy";
import { ago, folderName, Kbd } from "../ui";

export interface HomeProps {
  rev: number;
  onSearch(): void;
  onNew(): void;
  onCapture(): void;
  onOpen(id: number): void;
  onInbox(): void;
  onFolder(folder: string): void;
}

export default function Home(p: HomeProps) {
  const [data] = createResource(
    () => p.rev,
    async () => {
      const s = await api();
      const [inbox, all, folders] = await Promise.all([
        s.listNotes({ folder: "inbox", limit: 200 }),
        s.listNotes({ limit: 400 }),
        s.noteFolders(),
      ]);
      const notes = all.filter((n) => n.folder === "" || (n.pinned && n.folder !== "inbox")).slice(0, 24);
      // A collection is a folder at the top of the Petrel folder; its sub-folders count with it.
      const top = new Map<string, number>();
      for (const f of folders) {
        const head = f.path.split("/")[0];
        if (!head || head === "inbox" || head.startsWith(".")) continue;
        top.set(head, (top.get(head) ?? 0) + f.count);
      }
      const rootCount = folders.find((f) => f.path === "")?.count ?? 0;
      return { inbox: inbox.sort((a, b) => b.modifiedAt - a.modifiedAt), notes, collections: [...top.entries()], rootCount };
    },
  );

  const greet = () => {
    const h = new Date().getHours();
    return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  };

  return (
    <div class="home">
      <div class="home-top">
        <p class="greet">{greet()}</p>
        <button class="ask-field" onClick={p.onSearch}>
          <span class="spark">✦</span>
          <span class="ask-placeholder">Search or ask your notes…</span>
          <Kbd keys="Ctrl K" />
        </button>
        <div class="home-actions">
          <button class="btn primary" onClick={p.onNew}>
            New note <kbd>Ctrl N</kbd>
          </button>
          <button class="btn" onClick={p.onCapture}>
            Quick capture
          </button>
        </div>
      </div>

      <Show when={data()}>
        {(d) => (
          <>
            <section class="home-sec">
              <div class="sec-head">
                <h2>
                  Inbox <span class="count">{d().inbox.length}</span>
                </h2>
                <span class="grow" />
                <Show when={d().inbox.length}>
                  <button class="link" onClick={p.onInbox}>
                    File them <kbd>Ctrl 2</kbd>
                  </button>
                </Show>
              </div>
              <Show when={d().inbox.length} fallback={<p class="muted">Nothing to file. Captures from <Kbd keys="Ctrl Alt Space" /> land here.</p>}>
                <div class="inbox-strip">
                  <For each={d().inbox.slice(0, 4)}>
                    {(n) => (
                      <button class="capture-card" onClick={p.onInbox}>
                        <span class="capture-card-text">{plainText(n.preview) || n.title}</span>
                        <span class="capture-card-when">{ago(n.modifiedAt)}</span>
                      </button>
                    )}
                  </For>
                  <Show when={d().inbox.length > 4}>
                    <button class="capture-card more" onClick={p.onInbox}>
                      +{d().inbox.length - 4} more
                    </button>
                  </Show>
                </div>
              </Show>
            </section>

            <section class="home-sec">
              <div class="chips">
                <button class="chip big on" onClick={() => p.onFolder("")}>
                  Notes <span class="count">{d().rootCount}</span>
                </button>
                <For each={d().collections}>
                  {([f, c]) => (
                    <button class="chip big" onClick={() => p.onFolder(f)}>
                      {folderName(f)} <span class="count">{c}</span>
                    </button>
                  )}
                </For>
              </div>
            </section>

            <section class="home-sec">
              <Show when={d().notes.length} fallback={<p class="muted">No notes yet. <button class="link" onClick={p.onNew}>Write the first one.</button></p>}>
                <div class="cards notes">
                  <For each={d().notes}>{(n) => <NoteCard n={n} onOpen={p.onOpen} />}</For>
                </div>
              </Show>
            </section>
          </>
        )}
      </Show>
    </div>
  );
}

export function NoteCard(p: { n: NoteSummary; onOpen(id: number): void }) {
  return (
    <button class="card note" onClick={() => p.onOpen(p.n.id)}>
      <h3>
        <Show when={p.n.pinned}>
          <span class="pin" title="Pinned">●</span>
        </Show>
        {p.n.title}
      </h3>
      <p class="card-text">{plainText(p.n.preview)}</p>
      <footer>
        <Show when={p.n.tags.length}>
          <span class="tags">{p.n.tags.slice(0, 3).map((t) => `#${t}`).join(" ")}</span>
        </Show>
        <span class="grow" />
        <Show when={p.n.folder}>
          <span>{folderName(p.n.folder)} ·</span>
        </Show>
        <span>{ago(p.n.modifiedAt)}</span>
      </footer>
    </button>
  );
}
