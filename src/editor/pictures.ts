// Pictures in a note: paste or drop one and it is saved next to the note (`<folder>/attachments/`) and linked as
// `![](attachments/<name>)`; a link like that shows the picture under its line. Big photos are made smaller
// first (2000 px wide at most) unless Shift was held, as in Ctrl Shift V. The text stays plain Markdown.

import { type Extension, type Range, StateField, type EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { api, errText } from "../api";
import { say } from "../ui";

const WIDEST = 2000;
const KINDS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Picture links in a text, with where each line ends (the picture is drawn there). */
export function pictureLinks(text: string): { link: string; at: number }[] {
  const out: { link: string; at: number }[] = [];
  const re = /!\[[^\]\n]*\]\((attachments\/[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp))\)/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = text.indexOf("\n", m.index);
    out.push({ link: m[1], at: end < 0 ? text.length : end });
  }
  return out;
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
    readonly link: string,
  ) {
    super();
  }
  eq(o: Picture) {
    return o.folder === this.folder && o.link === this.link;
  }
  toDOM() {
    const box = document.createElement("span");
    box.className = "cm-picture";
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    urlOf(this.folder, this.link).then(
      (u) => (img.src = u),
      () => {
        box.classList.add("missing");
        box.textContent = `${this.link.slice("attachments/".length)} is not in the folder`;
      },
    );
    box.appendChild(img);
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

function build(state: EditorState, folder: string): DecorationSet {
  const ds: Range<Decoration>[] = pictureLinks(state.doc.toString()).map((p) =>
    Decoration.widget({ widget: new Picture(folder, p.link), side: 1 }).range(p.at),
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
