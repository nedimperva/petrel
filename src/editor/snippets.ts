// `;sig` in a note or the capture window: the snippets from the Snippets collection, as a list under the
// cursor. Enter puts one in; its blanks are fields filled in place (Tab to the next, Esc leaves them). Only
// inside Petrel: no keyboard hook anywhere else.

import { snippet, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { api } from "../api";
import { fill } from "../blanks";
import { matchSnippets, snippetOf, template, type Snippet } from "../collection/snippetText";

let cache: { at: number; list: Snippet[] } | null = null;

/** The notes in the top collection called Snippets (any case) and the ones inside it. Kept half a minute. */
async function load(): Promise<Snippet[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.list;
  const s = await api();
  const { folders } = await s.sidebarCounts();
  const top = folders.find((f) => f.depth === 0 && f.path.toLowerCase() === "snippets");
  let list: Snippet[] = [];
  if (top) {
    const inside = folders.filter((f) => f.path === top.path || f.path.startsWith(`${top.path}/`));
    const sums = (await Promise.all(inside.map((f) => s.listNotes({ folder: f.path, limit: 200 })))).flat();
    const notes = sums.length ? await s.peekNotes(sums.map((n) => n.id)) : [];
    list = notes.map((n) => snippetOf(n.title, n.body)).filter((x) => x.trigger && x.body);
  }
  cache = { at: Date.now(), list };
  return list;
}

/** Forget the list, so a snippet just written is there at the next `;`. */
export function forgetSnippets(): void {
  cache = null;
}

export async function snippetCompletions(ctx: CompletionContext): Promise<CompletionResult | null> {
  // A `;` at the start of a line or after a space, so "a;b" and "&nbsp;" are left alone.
  const m = ctx.matchBefore(/(?:^|[\s(]);[\p{L}\p{N}_-]*$/u);
  if (!m) return null;
  const from = m.from + m.text.indexOf(";");
  const typed = ctx.state.sliceDoc(from + 1, ctx.pos);
  if (!typed && !ctx.explicit) return null;
  const list = await load().catch(() => [] as Snippet[]);
  if (ctx.aborted || !list.length) return null;
  const options: Completion[] = matchSnippets(list, typed)
    .slice(0, 12)
    .map((s, i) => ({
      label: `;${s.trigger}`,
      detail: s.title,
      info: s.body.length > 160 ? `${s.body.slice(0, 160)}…` : s.body,
      boost: 99 - i,
      apply: (view, c, f, to) => {
        const t = template(s.body);
        if (t) snippet(t)(view, c, f, to);
        else view.dispatch({ changes: { from: f, to, insert: fill(s.body, {}) }, selection: { anchor: f + fill(s.body, {}).length }, userEvent: "input.complete" });
      },
    }));
  return options.length ? { from, options, filter: false } : null;
}
