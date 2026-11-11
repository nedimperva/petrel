// `[[links]]` in the editor: drawn as links, `Ctrl Click` or `Alt Enter` follows one, hovering shows what it points
// at, and typing `[[` lists notes and drafts. Used by the draft editor and the note editor alike. The parser
// mirrors crates/petrel-core/src/links.rs (which has the tests that count); this one only has to find links to
// draw and follow them.

import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { type Extension, RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { LinkTarget, Resolved } from "../api";

import { type ParsedLink, parseLinks } from "./parse";

export { type ParsedLink, parseInner, parseLinks } from "./parse";

export interface LinkOptions {
  /** Follow a link (the text inside the brackets). */
  open(inner: string): void;
  /** What a link points at; cached here per text. */
  resolve(inner: string): Promise<Resolved>;
  /** The hover card: title, where it lives, a few lines. Null when there is nothing to show. */
  preview(r: Resolved): Promise<{ title: string; where: string; text: string } | null>;
  /** The `[[` list. */
  targets(text: string): Promise<LinkTarget[]>;
  /** "Create note": makes the note, then the link is typed. */
  create?(title: string): Promise<void>;
}

const resolved = StateEffect.define<null>();
const linkMark = Decoration.mark({ class: "cm-wikilink" });
const missingMark = Decoration.mark({ class: "cm-wikilink cm-wikilink-missing" });

function linkAt(view: EditorView, pos: number): ParsedLink | undefined {
  const line = view.state.doc.lineAt(pos);
  return parseLinks(line.text, line.from).find((l) => l.from <= pos && pos <= l.to);
}

export function linkExtensions(o: LinkOptions): Extension {
  const cache = new Map<string, Resolved | "pending">();
  const lookup = (view: EditorView, inner: string): Resolved | undefined => {
    const hit = cache.get(inner);
    if (hit === "pending") return undefined;
    if (hit) return hit;
    cache.set(inner, "pending");
    o.resolve(inner)
      .then((r) => {
        cache.set(inner, r);
        if (view.dom.isConnected) view.dispatch({ effects: resolved.of(null) });
      })
      .catch(() => cache.delete(inner));
    return undefined;
  };

  const draw = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        // Links typed or renamed elsewhere resolve differently now and then: forget answers when the text changes.
        if (u.docChanged) cache.clear();
        if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(resolved)))) {
          this.decorations = this.build(u.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const b = new RangeSetBuilder<Decoration>();
        let fence = false;
        for (const r of view.visibleRanges) {
          for (let pos = r.from; pos <= r.to; ) {
            const line = view.state.doc.lineAt(pos);
            if (/^\s*(```|~~~)/.test(line.text)) fence = !fence;
            else if (!fence && line.text.includes("[[")) {
              for (const l of parseLinks(line.text, line.from)) {
                const r = lookup(view, l.inner);
                b.add(l.from, l.to, r?.kind === "missing" ? missingMark : linkMark);
              }
            }
            pos = line.to + 1;
          }
        }
        return b.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );

  const follow = (view: EditorView) => {
    const l = linkAt(view, view.state.selection.main.head);
    if (!l) return false;
    o.open(l.inner);
    return true;
  };

  const hover = hoverTooltip(
    async (view, pos) => {
      const l = linkAt(view, pos);
      if (!l) return null;
      let r: Resolved;
      try {
        r = await o.resolve(l.inner);
      } catch {
        return null;
      }
      const card = await o.preview(r).catch(() => null);
      return {
        pos: l.from,
        end: l.to,
        above: false,
        create() {
          const dom = document.createElement("div");
          dom.className = "link-card";
          if (r.kind === "missing") {
            const what = r.draft ? "No draft by that name." : `No note yet. Ctrl Click creates “${r.title}”.`;
            dom.append(span("link-card-text", what));
          } else if (card) {
            dom.append(span("link-card-where", card.where), span("link-card-title", card.title), span("link-card-text", card.text));
            dom.append(span("link-card-hint", "Ctrl Click or Alt Enter opens it."));
          }
          return { dom };
        },
      };
    },
    { hoverTime: 350 },
  );

  async function complete(ctx: CompletionContext): Promise<CompletionResult | null> {
    const before = ctx.matchBefore(/\[\[[^\]\n[]*$/);
    if (!before) return null;
    const text = before.text.slice(2);
    const from = before.from + 2;
    const targets = await o.targets(text).catch(() => [] as LinkTarget[]);
    if (ctx.aborted) return null;
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    const close = after === "]]" ? 2 : 0;
    const titles = new Map<string, number>();
    for (const t of targets) if (t.kind === "note") titles.set(t.title.toLowerCase(), (titles.get(t.title.toLowerCase()) ?? 0) + 1);
    const insert = (link: string) => (view: EditorView, _c: Completion, f: number, to: number) =>
      view.dispatch({ changes: { from: f, to: to + close, insert: `${link}]]` }, selection: { anchor: f + link.length + 2 } });
    const options: Completion[] = targets.map((t, i) => {
      const twice = t.kind === "note" && (titles.get(t.title.toLowerCase()) ?? 0) > 1 && t.folder;
      const link = t.kind === "draft" ? (titles.has(t.title.toLowerCase()) ? `d:${t.title}` : t.title) : twice ? `${t.folder}/${t.title}` : t.title;
      return {
        label: t.title,
        detail: t.kind === "note" ? t.folder || "notes" : `draft · ${t.folder}`,
        type: t.kind,
        // Notes first, as typed; the engine already ordered each group.
        boost: (t.kind === "note" ? 50 : 0) - i * 0.01,
        apply: insert(link),
      };
    });
    const q = text.trim();
    if (o.create && q && !targets.some((t) => t.kind === "note" && t.title.toLowerCase() === q.toLowerCase())) {
      options.push({
        label: `Create note “${q}”`,
        type: "create",
        boost: -99,
        apply: (view, _c, f, to) => {
          void o.create!(q).then(() => insert(q)(view, _c, f, to));
        },
      });
    }
    // Every row matches already: the engine filtered. CodeMirror's own filter would hide "Create note".
    return { from, options, filter: false };
  }

  return [
    draw,
    hover,
    autocompletion({ override: [complete], icons: false, activateOnTyping: true }),
    // The list's look lives here, not in styles.css: CodeMirror's base theme is scoped and would win.
    EditorView.theme({
      ".cm-tooltip.cm-tooltip-autocomplete": {
        border: "none",
        borderRadius: "var(--r-lg)",
        background: "var(--bg-0)",
        boxShadow: "var(--shadow), 0 0 0 1px var(--line)",
        padding: "var(--s-1)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-ui)", fontSize: "var(--t-md)", lineHeight: "1.4", maxHeight: "320px" },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "6px 10px", borderRadius: "var(--r-md)" },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--accent-soft)", color: "var(--ink)" },
      ".cm-completionDetail": { marginLeft: "var(--s-3)", fontStyle: "normal", color: "var(--faint)" },
    }),
    keymap.of([{ key: "Alt-Enter", run: follow }]),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return false;
        const l = linkAt(view, pos);
        if (!l) return false;
        e.preventDefault();
        o.open(l.inner);
        return true;
      },
    }),
  ];
}

function span(cls: string, text: string): HTMLElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}
