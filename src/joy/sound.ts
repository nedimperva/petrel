// A soft pencil sound as you type, off unless turned on in Settings. Made on the spot (a few milliseconds of
// filtered noise), so there is no sound file to ship. Quiet on purpose: it should be felt more than heard.

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let last = 0;

function setup(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
  } catch {
    ctx = null;
  }
  return ctx;
}

export function tick(big = false) {
  const now = performance.now();
  // Held keys repeat fast; one sound per 25 ms is plenty.
  if (now - last < 25) return;
  last = now;
  const c = setup();
  if (!c || !noise) return;
  if (c.state === "suspended") void c.resume();
  const src = c.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = (big ? 0.6 : 0.9) + Math.random() * 0.25;
  const band = c.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = big ? 1800 : 3200 + Math.random() * 900;
  band.Q.value = 0.9;
  const gain = c.createGain();
  gain.gain.value = big ? 0.05 : 0.035;
  src.connect(band).connect(gain).connect(c.destination);
  src.start();
}

/** Listens for typing in the editor while `on()` says so. Returns the way to stop. */
export function typingSound(on: () => boolean): () => void {
  const key = (e: KeyboardEvent) => {
    if (!on() || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (!t?.closest?.(".cm-editor")) return;
    if (e.key.length === 1) tick(false);
    else if (e.key === "Enter" || e.key === "Backspace") tick(true);
  };
  document.addEventListener("keydown", key, true);
  return () => document.removeEventListener("keydown", key, true);
}
