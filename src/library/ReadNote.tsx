// A note drawn for reading, not editing: headings, paragraphs, unordered and ordered lists, quotes, code (with Copy),
// tables, rules, inline images and tasks, with `[[links]]` that open. Built from Markdown line by line into elements;
// nothing is ever set as HTML. A task's box can be ticked here when `onTick` is given.

import { createEffect, createSignal, For, Match, Show, Switch, type JSX } from "solid-js";
import { api } from "../api";
import { say } from "../ui";
import { highlightParts } from "./preview";

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "li"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "task"; done: boolean; text: string; line: number }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "hr" }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "image"; caption: string; width: number | null; link: string };

const IMG_LINE = /^!\[([^\]\n]*)\]\((attachments\/[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp))\)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function splitAlt(alt: string): { caption: string; width: number | null } {
  const m = /^(.*?)\s*\|\s*(\d{2,4})\s*$/.exec(alt);
  return m ? { caption: m[1].trim(), width: Number(m[2]) } : { caption: alt.trim(), width: null };
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/** The blocks of a note's text. `line` is the line's index in the body, for ticking. */
export function blocksOf(body: string): Block[] {
  const lines = body.split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    const line = raw.trim();
    if (line.startsWith("```")) {
      flush();
      const lang = line.slice(3).trim().split(/\s+/)[0] ?? "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      out.push({ kind: "code", lang, text: code.join("\n") });
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      out.push({ kind: "hr" });
      continue;
    }
    const img = IMG_LINE.exec(line);
    if (img) {
      flush();
      out.push({ kind: "image", ...splitAlt(img[1]), link: img[2] });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      out.push({ kind: "table", head, rows });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const task = /^[-*] \[( |x|X)\]\s*(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (h) (flush(), out.push({ kind: "h", level: h[1].length, text: h[2] }));
    else if (task) (flush(), out.push({ kind: "task", done: task[1] !== " ", text: task[2], line: i }));
    else if (li) {
      flush();
      const last = out[out.length - 1];
      if (last?.kind === "li") last.items.push(li[1]);
      else out.push({ kind: "li", items: [li[1]] });
    } else if (ol) {
      flush();
      const last = out[out.length - 1];
      if (last?.kind === "ol") last.items.push(ol[1]);
      else out.push({ kind: "ol", items: [ol[1]] });
    } else if (line.startsWith(">")) {
      flush();
      const text = line.replace(/^>\s?/, "");
      const last = out[out.length - 1];
      if (last?.kind === "quote") last.text += `\n${text}`;
      else out.push({ kind: "quote", text });
    } else para.push(line);
  }
  flush();
  return out;
}

const imgUrls = new Map<string, Promise<string>>();

function mimeOf(link: string): string {
  const ext = link.split(".").pop()?.toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
}

function loadAttachmentUrl(folder: string, link: string): Promise<string> {
  const key = `${folder}\n${link}`;
  let u = imgUrls.get(key);
  if (!u) {
    u = api()
      .then((s) => s.attachment(folder, link))
      .then((bytes) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(link) })));
    u.catch(() => imgUrls.delete(key));
    imgUrls.set(key, u);
  }
  return u;
}

function ReadImage(p: { folder?: string; link: string; caption: string; width: number | null }) {
  const [src, setSrc] = createSignal<string | null>(null);
  const [missing, setMissing] = createSignal(false);
  createEffect(() => {
    const f = p.folder;
    const l = p.link;
    setSrc(null);
    setMissing(false);
    if (f === undefined) {
      setMissing(true);
      return;
    }
    void loadAttachmentUrl(f, l).then(
      (u) => setSrc(u),
      () => setMissing(true),
    );
  });
  return (
    <figure class="read-figure">
      <Show
        when={src()}
        fallback={
          <span class="read-img-missing">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="8.5" cy="10" r="1.5" />
              <path d="m21 15-5-5-8 8" />
            </svg>
            <span>{p.caption || p.link.replace(/^attachments\//, "")}{missing() ? "" : "…"}</span>
          </span>
        }
      >
        {(u) => <img src={u()} alt={p.caption} style={p.width ? { width: `${p.width}px` } : undefined} />}
      </Show>
      <Show when={p.caption && src()}>
        <figcaption>{p.caption}</figcaption>
      </Show>
    </figure>
  );
}

function plainTextNodes(text: string, highlight?: string): JSX.Element[] {
  if (!highlight?.trim()) return [text];
  return highlightParts(text, highlight).map((seg) => (seg.hit ? <mark class="read-mark">{seg.text}</mark> : seg.text));
}

/** Inline marks: `[[links]]`, `[label](https://...)`, **bold**, *italic*, `code`; pictures as subtle badge. */
function inline(text: string, onLink?: (inner: string) => void, highlight?: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)|\*\*(.+?)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)|`([^`]+)`|!\[([^\]\n]*)\]\([^)]*\)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push(...plainTextNodes(text.slice(at, m.index), highlight));
    if (m[1]) {
      const inner = m[1].trim();
      const label = m[2] ?? m[1];
      out.push(
        onLink ? (
          <button type="button" class="read-link" onClick={() => onLink(inner)}>
            {plainTextNodes(label, highlight)}
          </button>
        ) : (
          <span class="read-link">{plainTextNodes(label, highlight)}</span>
        ),
      );
    } else if (m[3] && m[4]) {
      out.push(
        <a class="read-link" href={m[4]} target="_blank" rel="noreferrer noopener">
          {plainTextNodes(m[3], highlight)}
        </a>,
      );
    } else if (m[5]) out.push(<b>{plainTextNodes(m[5], highlight)}</b>);
    else if (m[6]) out.push(<em>{plainTextNodes(m[6], highlight)}</em>);
    else if (m[7]) out.push(<code>{plainTextNodes(m[7], highlight)}</code>);
    else out.push(<span class="read-img-inline">{m[8] ? `[${splitAlt(m[8]).caption || "photo"}]` : "[photo]"}</span>);
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(...plainTextNodes(text.slice(at), highlight));
  return out;
}

export default function ReadNote(p: {
  body: string;
  folder?: string;
  highlight?: string;
  compact?: boolean;
  onLink?: (inner: string) => void;
  onTick?: (line: number, done: boolean) => void;
}) {
  const blocks = () => blocksOf(p.body);
  const copyCode = (text: string) =>
    void api()
      .then((s) => s.copyText(text, false))
      .then(() => say("Copied code"));

  return (
    <div class="read" classList={{ compact: !!p.compact }}>
      <For each={blocks()}>
        {(b) => (
          <Switch>
            <Match when={b.kind === "h" && b}>
              {(h) => {
                const x = h() as Extract<Block, { kind: "h" }>;
                return x.level <= 1 ? (
                  <h2>{inline(x.text, p.onLink, p.highlight)}</h2>
                ) : x.level === 2 ? (
                  <h3>{inline(x.text, p.onLink, p.highlight)}</h3>
                ) : (
                  <h4>{inline(x.text, p.onLink, p.highlight)}</h4>
                );
              }}
            </Match>
            <Match when={b.kind === "p" && b}>{(x) => <p>{inline((x() as Extract<Block, { kind: "p" }>).text, p.onLink, p.highlight)}</p>}</Match>
            <Match when={b.kind === "li" && b}>
              {(x) => (
                <ul>
                  <For each={(x() as Extract<Block, { kind: "li" }>).items}>{(it) => <li>{inline(it, p.onLink, p.highlight)}</li>}</For>
                </ul>
              )}
            </Match>
            <Match when={b.kind === "ol" && b}>
              {(x) => (
                <ol>
                  <For each={(x() as Extract<Block, { kind: "ol" }>).items}>{(it) => <li>{inline(it, p.onLink, p.highlight)}</li>}</For>
                </ol>
              )}
            </Match>
            <Match when={b.kind === "task" && b}>
              {(x) => {
                const t = x() as Extract<Block, { kind: "task" }>;
                return (
                  <label class="read-task" classList={{ done: t.done, readonly: !p.onTick }}>
                    <input type="checkbox" checked={t.done} disabled={!p.onTick} onChange={(e) => p.onTick?.(t.line, e.currentTarget.checked)} />
                    <span>{inline(t.text, p.onLink, p.highlight)}</span>
                  </label>
                );
              }}
            </Match>
            <Match when={b.kind === "quote" && b}>{(x) => <blockquote>{inline((x() as Extract<Block, { kind: "quote" }>).text, p.onLink, p.highlight)}</blockquote>}</Match>
            <Match when={b.kind === "hr"}>
              <hr class="read-hr" />
            </Match>
            <Match when={b.kind === "image" && b}>
              {(x) => {
                const im = x() as Extract<Block, { kind: "image" }>;
                return <ReadImage folder={p.folder} link={im.link} caption={im.caption} width={im.width} />;
              }}
            </Match>
            <Match when={b.kind === "table" && b}>
              {(x) => {
                const t = x() as Extract<Block, { kind: "table" }>;
                return (
                  <div class="read-table-wrap">
                    <table class="read-table">
                      <thead>
                        <tr>
                          <For each={t.head}>{(c) => <th>{inline(c, p.onLink, p.highlight)}</th>}</For>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={t.rows}>
                          {(r) => (
                            <tr>
                              <For each={r}>{(c) => <td>{inline(c, p.onLink, p.highlight)}</td>}</For>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                );
              }}
            </Match>
            <Match when={b.kind === "code" && b}>
              {(x) => {
                const c = x() as Extract<Block, { kind: "code" }>;
                return (
                  <div class="read-code">
                    <div class="read-code-bar">
                      <span class="read-code-lang">{c.lang || "code"}</span>
                      <button type="button" class="read-code-copy" onClick={() => copyCode(c.text)}>
                        Copy
                      </button>
                    </div>
                    <pre>{c.text}</pre>
                  </div>
                );
              }}
            </Match>
          </Switch>
        )}
      </For>
    </div>
  );
}
