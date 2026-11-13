// Where each card was copied last: the app in front (from the picker) or Petrel itself, and when. Kept as one
// `ui.used` setting, `{path: [app, at]}`, so the picker can say "Used in Slack · 2 hours ago".

import { api } from "../api";
import { addUse, parseUsed, type Used } from "./used";

export type { Used } from "./used";

const KEY = "ui.used";

export async function loadUsed(): Promise<Used> {
  const s = await api();
  return parseUsed((await s.uiSettings().catch(() => ({}) as Record<string, string>))[KEY]);
}

export async function noteUse(path: string, app: string | null) {
  const s = await api();
  const next = addUse(await loadUsed(), path, app?.trim() || "Petrel", Date.now());
  await s.setUiSetting(KEY, JSON.stringify(next)).catch(() => {});
}
