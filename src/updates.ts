// Updates: Petrel asks GitHub for a newer release (latest.json, signed with the key in tauri.conf.json) when it
// starts and every six hours, and shows a quiet notice when there is one. Nothing is downloaded or installed
// until the owner presses Install; then it restarts into the new version. Off in Settings › General (`ui.updates`),
// never in a debug build or in the browser.

import { createSignal } from "solid-js";
import { inTauri } from "./api";

export interface Found {
  version: string;
  notes: string;
}

export type UpdateState = { kind: "idle" } | { kind: "found"; found: Found } | { kind: "installing"; got: number; size: number } | { kind: "error"; text: string };

const [state, setState] = createSignal<UpdateState>({ kind: "idle" });
export { state as updateState };

const EVERY_MS = 6 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | undefined;
// The update object from the last check, kept to install from.
let pending: { downloadAndInstall(cb: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void): Promise<void> } | null = null;

/** Only an installed build updates itself. */
export const canUpdate = () => inTauri && import.meta.env.PROD;

/** Looks once. `quiet`: say nothing when there is nothing new (the checks on a timer). */
export async function checkForUpdate(quiet = true): Promise<"new" | "none" | "error"> {
  if (!canUpdate()) return "none";
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const u = await check();
    if (!u) {
      if (!quiet) setState({ kind: "idle" });
      return "none";
    }
    pending = u;
    setState({ kind: "found", found: { version: u.version, notes: u.body ?? "" } });
    return "new";
  } catch (e) {
    if (!quiet) setState({ kind: "error", text: String(e) });
    return "error";
  }
}

/** Starts the checks: now (after the window has settled) and every six hours. */
export function watchUpdates(on: () => boolean) {
  clearInterval(timer);
  if (!canUpdate()) return;
  setTimeout(() => on() && void checkForUpdate(), 8000);
  timer = setInterval(() => on() && void checkForUpdate(), EVERY_MS);
}

let beforeInstall: () => Promise<unknown> = async () => {};
/** What must happen before Petrel closes for the installer: the note being written is saved. */
export const setBeforeInstall = (f: () => Promise<unknown>) => (beforeInstall = f);

/** Downloads, installs and restarts. On Windows the installer closes Petrel itself. */
export async function installUpdate() {
  if (!pending) return;
  await beforeInstall().catch(() => {});
  let size = 0;
  let got = 0;
  setState({ kind: "installing", got: 0, size: 0 });
  try {
    await pending.downloadAndInstall((e) => {
      if (e.event === "Started") size = e.data?.contentLength ?? 0;
      else if (e.event === "Progress") got += e.data?.chunkLength ?? 0;
      setState({ kind: "installing", got, size });
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    setState({ kind: "error", text: String(e) });
  }
}

export const dismissUpdate = () => setState({ kind: "idle" });
