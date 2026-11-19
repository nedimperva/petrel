// Ctrl C on a prompt or snippet in the main window (a card in the library, or the note itself when nothing is
// selected): copied at once when there is nothing to fill, else filled in inside its text first, the same way as
// in the picker (InlineFill). One host in App draws the filling in over whatever screen asked.

import { createSignal, Show } from "solid-js";
import { api, type NoteSummary } from "../api";
import { blanks } from "../blanks";
import { keepVersion, lastVersions } from "./BlankFields";
import { copyFilled } from "./copyItem";
import InlineFill from "./InlineFill";
import { hasVersions, lastFirst, versionsOf, type Version } from "./versions";
import { folderName } from "../ui";

type Item = Pick<NoteSummary, "id" | "title" | "path" | "folder">;

const [pending, setPending] = createSignal<{ item: Item; body: string; versions: Version[]; done?: () => void } | null>(null);
const [vi, setVi] = createSignal(0);
/** Where the caret was (the note's text, a card), to go back to after. */
let before: HTMLElement | null = null;

export async function copyWithFill(item: Item, done?: () => void) {
  const body = (await (await api()).peekNote(item.id)).body.replace(/\n+$/, "");
  const versions = hasVersions(item.folder) ? lastFirst(versionsOf(body), (await lastVersions())[item.path]) : [];
  const text = versions[0]?.text ?? body;
  if (versions.length > 1 || blanks(text).length) {
    setVi(0);
    before = document.activeElement as HTMLElement | null;
    setPending({ item, body, versions, done });
  } else if (await copyFilled(item, text)) done?.();
}

export function FillHost() {
  const close = () => {
    setPending(null);
    before?.focus();
    before = null;
  };
  return (
    <Show when={pending()}>
      {(p) => {
        const version = () => p().versions[vi() % Math.max(1, p().versions.length)];
        return (
          <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
            <div class="ifill-dialog" role="dialog" aria-label={`Fill in ${p().item.title}`}>
              <InlineFill
                title={p().item.title}
                where={folderName(p().item.folder)}
                text={version()?.text ?? p().body}
                versions={p().versions}
                version={vi() % Math.max(1, p().versions.length)}
                onVersion={setVi}
                onClose={close}
                onCopy={async (text) => {
                  const { item, done } = p();
                  if (version()) void keepVersion(item.path, version()!.name);
                  if (await copyFilled(item, text)) {
                    close();
                    done?.();
                  }
                }}
              />
            </div>
          </div>
        );
      }}
    </Show>
  );
}
