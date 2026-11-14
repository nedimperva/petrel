// Google Drive sync, as the screens see it: one status, kept fresh by the `petrel-sync` event, read by the
// sidebar's foot and Settings › Sync. The work happens in Rust (src-tauri/src/sync.rs).
import { createSignal } from "solid-js";
import { api, type SyncStatus } from "./api";
import { ago } from "./ui";

const [status, setStatus] = createSignal<SyncStatus | null>(null);
export { status as syncStatus, setStatus as setSyncStatus };

let watching = false;

export async function watchSync() {
  if (watching) return;
  watching = true;
  const s = await api();
  setStatus(await s.syncStatus().catch(() => null));
  await s.onSync(setStatus).catch(() => {});
}

/** One short line for the sidebar's foot, or null when sync is off. */
export function syncLine(s: SyncStatus | null): { text: string; tone: "ok" | "busy" | "warn" } | null {
  if (!s || !s.signedIn) return s?.state === "signin" ? { text: "Sign in to Drive again", tone: "warn" } : null;
  if (!s.on) return { text: "Sync paused", tone: "warn" };
  switch (s.state) {
    case "syncing":
      return { text: "Syncing…", tone: "busy" };
    case "offline":
      return { text: "Offline, changes wait", tone: "warn" };
    case "signin":
      return { text: "Sign in to Drive again", tone: "warn" };
    case "blocked":
      return { text: "Sync off: folder in Drive for desktop", tone: "warn" };
    case "error":
      return { text: "Some files did not sync", tone: "warn" };
    default:
      return { text: s.lastAt ? `Synced ${ago(s.lastAt)}` : "Synced", tone: "ok" };
  }
}
