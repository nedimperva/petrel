// Pictures in a note: paste or drop one and it is saved next to the note (`<folder>/attachments/`) and linked as
// `![](attachments/<name>)`; a link like that shows the picture under its line, at the width after `|` and with
// the rest of the alt text as its caption. Big photos are made smaller
// first (2000 px wide at most) unless Shift was held, as in Ctrl Shift V. The text stays plain Markdown.

import { type Extension, type Range, StateField, type EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { api, errText } from "../api";
import { say } from "../ui";

const WIDEST = 2000;
const KINDS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** A picture link: `![caption|320](attachments/x.png)`. The number after `|` is the width it is drawn at (as
 * Obsidian writes it); the rest is shown under the picture as its caption. */
export interface PictureLink {
  link: string;
  caption: string;
  width: number | null;
  /** Where the whole `![…](…)` starts and ends, and where the line ends (the picture is drawn there). */
  from: number;
  to: number;
  at: number;
}

const LINK = /!\[([^\]\n]*)\]\((attachments\/[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp))\)/gi;

export function splitAlt(alt: string): { caption: string; width: number | null } {
  const m = /^(.*?)\s*\|\s*(\d{2,4})\s*$/.exec(alt);
  return m ? { caption: m[1].trim(), width: Number(m[2]) } : { caption: alt.trim(), width: null };
}

/** Picture links in a text. */
export function pictureLinks(text: string): PictureLink[] {
  const out: PictureLink[] = [];
  const re = new RegExp(LINK.source, LINK.flags);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = text.indexOf("\n", m.index);
    out.push({ link: m[2], ...splitAlt(m[1]), from: m.index, to: m.index + m[0].length, at: end < 0 ? text.length : end });
  }
  return out;
}

/** The link written with a new width. */
export function withWidth(p: Pick<PictureLink, "link" | "caption">, width: number | null): string {
  const alt = width ? (p.caption ? `${p.caption}|${width}` : `|${width}`) : p.caption;
  return `![${alt}](${p.link})`;
}

const urls = new Map<string, Promise<string>>();

function urlOf(folder: string, link: string): Promise<string> {
  const key = `${folder}\n${link}`;
  let u = urls.get(key);
  if (!u) {
    u = api()
      .then((s) => s.attachment(folder, link))
      .then((bytes) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(link) })));
    u.catch(() => urls.delete(key));
    urls.set(key, u);
  }
  return u;
}

const mimeOf = (link: string) => {
  const ext = link.split(".").pop()?.toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
};

class Picture extends WidgetType {
  constructor(
    readonly folder: string,
    readonly p: PictureLink,
  ) {
    super();
  }
  eq(o: Picture) {
    return o.folder === this.folder && o.p.link === this.p.link && o.p.caption === this.p.caption && o.p.width === this.p.width;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "cm-picture";
    const frame = document.createElement("span");
    frame.className = "cm-picture-frame";
    if (this.p.width) frame.style.width = `${this.p.width}px`;
    const img = document.createElement("img");
    img.alt = this.p.caption;
    img.draggable = false;
    urlOf(this.folder, this.p.link).then(
      (u) => (img.src = u),
      () => {
        box.classList.add("missing");
        box.textContent = `${this.p.link.slice("attachments/".length)} is not in the folder`;
      },
    );
    // The handle on the right edge: drag to make the picture narrower or wider; the width goes into the link.
    const grip = document.createElement("span");
    grip.className = "cm-picture-grip";
    grip.title = "Drag to resize. Double-click for full width.";
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const start = e.clientX;
      const w0 = frame.getBoundingClientRect().width;
      const most = box.getBoundingClientRect().width;
      const move = (m: PointerEvent) => (frame.style.width = `${Math.round(Math.max(80, Math.min(most, w0 + m.clientX - start)))}px`);
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        const w = Math.round(frame.getBoundingClientRect().width);
        this.write(view, box, w >= most - 4 ? null : w);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    grip.addEventListener("dblclick", (e) => (e.preventDefault(), this.write(view, box, null)));
    frame.append(img, grip);
    box.appendChild(frame);
    if (this.p.caption) {
      const cap = document.createElement("span");
      cap.className = "cm-picture-caption";
      cap.textContent = this.p.caption;
      box.appendChild(cap);
    }
    return box;
  }
  /** Finds this picture's link on its line again (the text may have moved) and writes the width into it. */
  write(view: EditorView, box: HTMLElement, width: number | null) {
    const pos = view.posAtDOM(box);
    const line = view.state.doc.lineAt(Math.max(0, Math.min(pos, view.state.doc.length)));
    const hit = pictureLinks(line.text).find((l) => l.link === this.p.link);
    if (!hit || hit.width === width) return;
    view.dispatch({ changes: { from: line.from + hit.from, to: line.from + hit.to, insert: withWidth(hit, width) }, userEvent: "input.picture" });
  }
  ignoreEvent() {
    return false;
  }
}

function build(state: EditorState, folder: string): DecorationSet {
  const ds: Range<Decoration>[] = pictureLinks(state.doc.toString()).map((p) =>
    Decoration.widget({ widget: new Picture(folder, p), side: 1 }).range(p.at),
  );
  return Decoration.set(ds, true);
}

/** Makes a big photo smaller, keeping its kind. GIFs stay as they are (they may move). */
async function shrink(file: Blob): Promise<Blob> {
  if (file.type === "image/gif") return file;
  try {
    const bmp = await createImageBitmap(file);
    if (bmp.width <= WIDEST) return file;
    const h = Math.round((bmp.height * WIDEST) / bmp.width);
    const c = document.createElement("canvas");
    c.width = WIDEST;
    c.height = h;
    c.getContext("2d")!.drawImage(bmp, 0, 0, WIDEST, h);
    const out = await new Promise<Blob | null>((r) => c.toBlob(r, file.type, 0.86));
    return out && out.size < file.size ? out : file;
  } catch {
    return file;
  }
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Saves the pictures and types their links at the cursor. */
async function take(view: EditorView, folder: string, files: File[], keep: boolean) {
  const s = await api();
  for (const f of files) {
    const ext = KINDS[f.type];
    if (!ext) continue;
    try {
      const blob = keep ? f : await shrink(f);
      const base = f.name && !/^image\.\w+$/i.test(f.name) ? f.name.replace(/\.\w+$/, "") : `paste-${stamp()}`;
      const link = await s.saveAttachment(folder, `${base}.${ext}`, new Uint8Array(await blob.arrayBuffer()));
      const at = view.state.selection.main;
      const line = view.state.doc.lineAt(at.from);
      const before = at.from > line.from ? "\n\n" : "";
      const text = `${before}![](${link})\n`;
      view.dispatch({ changes: { from: at.from, to: at.to, insert: text }, selection: { anchor: at.from + text.length }, scrollIntoView: true });
    } catch (e) {
      say(errText(e), { error: true });
    }
  }
}

export function pictureExtensions(folder: () => string): Extension {
  let shift = false;
  let shiftAt = 0;
  const field = StateField.define<DecorationSet>({
    create: (s) => build(s, folder()),
    update: (d, tr) => (tr.docChanged || tr.reconfigured ? build(tr.state, folder()) : d.map(tr.changes)),
    provide: (f) => EditorView.decorations.from(f),
  });
  const files = (list: DataTransferItemList | FileList | null | undefined): File[] => {
    if (!list) return [];
    const out: File[] = [];
    for (const it of Array.from(list as ArrayLike<DataTransferItem | File>)) {
      const f = it instanceof File ? it : it.kind === "file" ? it.getAsFile() : null;
      if (f && KINDS[f.type]) out.push(f);
    }
    return out;
  };
  return [
    field,
    EditorView.domEventHandlers({
      keydown(e) {
        shift = e.shiftKey;
        shiftAt = Date.now();
        return false;
      },
      paste(e, view) {
        const fs = files(e.clipboardData?.items);
        if (!fs.length) return false;
        e.preventDefault();
        void take(view, folder(), fs, shift && Date.now() - shiftAt < 1500);
        return true;
      },
      drop(e, view) {
        const fs = files(e.dataTransfer?.files);
        if (!fs.length) return false;
        e.preventDefault();
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos != null) view.dispatch({ selection: { anchor: pos } });
        void take(view, folder(), fs, e.shiftKey);
        return true;
      },
    }),
  ];
}
