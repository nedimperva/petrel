// A collection's mark: its icon (or a dot) in its colour. Every window reads the looks once and again when one
// changes, so the library, the capture window and the review all draw a collection the same way.

import { createSignal, Show } from "solid-js";
import { api, type TopicFace } from "../api";
import { colorOf, markOf } from "./faces";

const [faces, setFaces] = createSignal<Record<string, TopicFace>>({});
export { faces };

export async function loadFaces() {
  try {
    setFaces(await (await api()).topicFaces());
  } catch {
    // No folder yet: every collection has its default look.
  }
}

export async function saveFace(top: string, face: TopicFace) {
  const f = await (await api()).setTopicFace(top, face);
  setFaces({ ...faces(), [top]: f });
}

/** `hue-<colour>` for a folder, for the CSS that colours dots, borders and blanks. */
export const hueClass = (folder: string) => `hue-${colorOf(folder, faces())}`;

export default function Mark(p: { folder: string; size?: number; class?: string }) {
  const d = () => markOf(p.folder, faces());
  return (
    <span class={`mark ${hueClass(p.folder)} ${p.class ?? ""}`} aria-hidden="true">
      <Show when={d()} fallback={<span class="dot" />}>
        <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d={d()!} />
        </svg>
      </Show>
    </span>
  );
}
