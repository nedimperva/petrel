// The reading view (Ctrl E): the note set like a page in a book, larger, without its marks, links as words. A song
// keeps its lines with each chord over its syllable, in two columns when the window is wide enough. Read-only;
// Esc goes back to writing where you were.

import { For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import ReadNote from "../library/ReadNote";
import { folderName } from "../ui";
import { isSong, songLines } from "./reading";

export default function Reading(p: { title: string; folder: string; body: string; onClose(): void; onLink(inner: string): void; onTick(line: number, done: boolean): void }) {
  let box!: HTMLDivElement;
  const song = () => isSong(p.body, p.folder);
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e")) {
      e.preventDefault();
      e.stopPropagation();
      p.onClose();
    }
  };
  onMount(() => {
    addEventListener("keydown", key, true);
    box.focus();
  });
  onCleanup(() => removeEventListener("keydown", key, true));
  return (
    <div class="reading" ref={box} tabIndex={-1} role="document" aria-label={`Reading ${p.title}`}>
      <article class="reading-page" classList={{ song: song() }}>
        <p class="reading-meta">{folderName(p.folder)}</p>
        <h1 class="reading-title">{p.title}</h1>
        <Show when={song()} fallback={<ReadNote body={p.body} onLink={p.onLink} onTick={p.onTick} />}>
          <div class="song">
            <For each={songLines(p.body)}>
              {(l) => (
                <Switch>
                  <Match when={l.kind === "blank"}>
                    <div class="song-gap" />
                  </Match>
                  <Match when={l.kind === "label" && l}>{(x) => <div class="song-label">{(x() as { text: string }).text}</div>}</Match>
                  <Match when={l.kind === "line" && l}>
                    {(x) => (
                      <div class="song-line">
                        <For each={(x() as { parts: { chord: string; text: string }[] }).parts}>
                          {(part) => (
                            <span class="song-part" classList={{ chorded: !!part.chord }}>
                              <span class="song-chord">{part.chord}</span>
                              <span class="song-words">{part.text || " "}</span>
                            </span>
                          )}
                        </For>
                      </div>
                    )}
                  </Match>
                </Switch>
              )}
            </For>
          </div>
        </Show>
      </article>
      <p class="reading-foot">
        <kbd>Esc</kbd> back to writing
      </p>
    </div>
  );
}
