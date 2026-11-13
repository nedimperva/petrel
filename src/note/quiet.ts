// The page, quieter: while you type, the title bar, sidebar, margin and footer fade almost to nothing. They come
// back when the mouse moves (a real move, not a twitch) or the window loses focus. A class on <html>, so every
// piece of chrome only needs a CSS rule.

import { prefs } from "../settings/prefs";

const CLASS = "writing-quiet";
let x = -1;
let y = -1;

/** Typing in the page: the chrome steps back, if the owner wants it to. */
export function hush() {
  if (prefs().quiet) document.documentElement.classList.add(CLASS);
}

export function wake() {
  document.documentElement.classList.remove(CLASS);
}

/** Listens for the mouse and focus; returns the cleanup. */
export function watchQuiet(): () => void {
  const move = (e: MouseEvent) => {
    // A few pixels of drift on a touchpad while typing should not bring everything back.
    const far = x >= 0 && Math.abs(e.clientX - x) + Math.abs(e.clientY - y) >= 6;
    if (x < 0 || far) {
      x = e.clientX;
      y = e.clientY;
    }
    if (far && document.documentElement.classList.contains(CLASS)) wake();
  };
  const reset = () => {
    x = -1;
    wake();
  };
  addEventListener("mousemove", move, { passive: true });
  addEventListener("blur", reset);
  return () => {
    removeEventListener("mousemove", move);
    removeEventListener("blur", reset);
  };
}
