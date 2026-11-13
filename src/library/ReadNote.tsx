// A note drawn for reading, not editing: headings, paragraphs, lists, quotes, code and tasks, with `[[links]]`
// that open. Built from the Markdown line by line into elements; nothing is ever set as HTML. A task's box can be
// ticked here: the line changes in the file (saved with the note's hash, so an edit made elsewhere is kept).

import { For, Match, Switch, type JSX } from "solid-js";

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "li"; items: string[] }
  | { kind: "task"; done: boolean; text: string; line: number }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string };

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
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const task = /^[-*] \[( |x|X)\]\s*(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (h) (flush(), out.push({ kind: "h", level: h[1].length, text: h[2] }));
    else if (task) (flush(), out.push({ kind: "task", done: task[1] !== " ", text: task[2], line: i }));
    else if (li) {
      flush();
      const last = out[out.length - 1];
      if (last?.kind === "li") last.items.push(li[1]);
      else out.push({ kind: "li", items: [li[1]] });
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

/** Inline marks: `[[links]]`, **bold**, `code`; pictures are named, not shown. */
function inline(text: string, onLink: (inner: string) => void): JSX.Element[] {
  const out: JSX.Element[] = [];
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\*\*(.+?)\*\*|`([^`]+)`|!\[[^\]]*\]\([^)]*\)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    if (m[1]) {
      const inner = m[1].trim();
      out.push(
        <button type="button" class="read-link" onClick={() => onLink(inner)}>
          {m[2] ?? m[1]}
        </button>,
      );
    } else if (m[3]) out.push(<b>{m[3]}</b>);
    else if (m[4]) out.push(<code>{m[4]}</code>);
    else out.push(<span class="muted">[picture]</span>);
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export default function ReadNote(p: { body: string; onLink(inner: string): void; onTick(line: number, done: boolean): void }) {
  const blocks = () => blocksOf(p.body);
  return (
    <div class="read">
      <For each={blocks()}>
        {(b) => (
          <Switch>
            <Match when={b.kind === "h" && b}>
              {(h) => {
                const x = h() as Extract<Block, { kind: "h" }>;
                return x.level <= 1 ? <h2>{inline(x.text, p.onLink)}</h2> : x.level === 2 ? <h3>{inline(x.text, p.onLink)}</h3> : <h4>{inline(x.text, p.onLink)}</h4>;
              }}
            </Match>
            <Match when={b.kind === "p" && b}>{(x) => <p>{inline((x() as Extract<Block, { kind: "p" }>).text, p.onLink)}</p>}</Match>
            <Match when={b.kind === "li" && b}>
              {(x) => (
                <ul>
                  <For each={(x() as Extract<Block, { kind: "li" }>).items}>{(it) => <li>{inline(it, p.onLink)}</li>}</For>
                </ul>
              )}
            </Match>
            <Match when={b.kind === "task" && b}>
              {(x) => {
                const t = x() as Extract<Block, { kind: "task" }>;
                return (
                  <label class="read-task" classList={{ done: t.done }}>
                    <input type="checkbox" checked={t.done} onChange={(e) => p.onTick(t.line, e.currentTarget.checked)} />
                    <span>{inline(t.text, p.onLink)}</span>
                  </label>
                );
              }}
            </Match>
            <Match when={b.kind === "quote" && b}>{(x) => <blockquote>{inline((x() as Extract<Block, { kind: "quote" }>).text, p.onLink)}</blockquote>}</Match>
            <Match when={b.kind === "code" && b}>{(x) => <pre>{(x() as Extract<Block, { kind: "code" }>).text}</pre>}</Match>
          </Switch>
        )}
      </For>
    </div>
  );
}
