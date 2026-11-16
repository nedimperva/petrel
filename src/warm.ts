// The capture window and the picker are kept warm (src-tauri/src/warm.rs): the page loads once, hidden, and waits
// until a hotkey asks for it. `whenOpened` runs `start` then, once. When the page is done it hides and reloads
// (`rest`), so the next open starts from a clean page that has already booted.
import { api } from "./api";

export async function whenOpened(start: () => void | Promise<void>) {
  const s = await api();
  let started = false;
  const go = () => {
    if (started) return;
    started = true;
    void start();
  };
  // Listen first, so an open sent between the two calls is not missed.
  await s.onOpenWindow(go);
  if (await s.windowReady()) go();
}

/** After the window has hidden: back to a clean, waiting page. */
export function rest() {
  setTimeout(() => location.reload(), 50);
}
