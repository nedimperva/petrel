// Settings › Claude apps: your notes in Claude Desktop and Claude Code, through the MCP server Petrel ships
// (`petrel mcp`, src-tauri/src/mcp.rs). Petrel never starts it or calls out: Claude starts it when you ask
// something there. This page gives the lines to paste, says which collections Claude sees, and whether it may
// add. The same program is the `petrel` command for a terminal.

import { createSignal, For, onMount, Show } from "solid-js";
import { api, errText, type AppInfo } from "../api";
import { say } from "../ui";

const SCOPE = "ui.outside.collections";
const WRITE = "ui.outside.write";

export default function ClaudeSection() {
  const [info, setInfo] = createSignal<AppInfo | null>(null);
  const [tops, setTops] = createSignal<string[]>([]);
  /** Empty is every collection. */
  const [shared, setShared] = createSignal<string[]>([]);
  const [write, setWrite] = createSignal(false);

  onMount(async () => {
    const s = await api();
    const [i, fs, set] = await Promise.all([s.appInfo(), s.noteFolders().catch(() => []), s.uiSettings().catch(() => ({}) as Record<string, string>)]);
    setInfo(i);
    setTops(fs.filter((f) => f.depth === 0 && f.path && !f.path.startsWith(".")).map((f) => f.path));
    try {
      setShared(JSON.parse(set[SCOPE] ?? "[]"));
    } catch {
      setShared([]);
    }
    setWrite(set[WRITE] === "yes");
  });

  const exe = () => info()?.exePath ?? "petrel";
  const desktopJson = () => JSON.stringify({ mcpServers: { petrel: { command: exe(), args: ["mcp"] } } }, null, 2);
  const codeLine = () => `claude mcp add --scope user petrel -- "${exe()}" mcp`;

  async function copy(text: string, what: string) {
    await (await api()).copyText(text, false).catch((e) => say(errText(e), { error: true }));
    say(`Copied ${what}.`);
  }

  async function save(list: string[], w: boolean) {
    const s = await api();
    setShared(list);
    setWrite(w);
    await s.setUiSetting(SCOPE, JSON.stringify(list)).catch((e) => say(errText(e), { error: true }));
    await s.setUiSetting(WRITE, w ? "yes" : "").catch((e) => say(errText(e), { error: true }));
  }

  const sees = (t: string) => !shared().length || shared().includes(t);
  function flip(t: string) {
    // From "all" the first untick lists every other collection; ticking the last one back is "all" again.
    const now = shared().length ? shared() : tops();
    const next = now.includes(t) ? now.filter((x) => x !== t) : [...now, t];
    void save(next.length === tops().length ? [] : next.length ? next : ["(none)"], write());
  }

  return (
    <>
      <h1>Claude apps</h1>
      <section class="set-card">
        <p class="set-note">
          Ask Claude Desktop or Claude Code about your notes: it can search them, read them and fill in a card, and add to them if you let it. Petrel itself still calls nothing; Claude starts Petrel's
          small server when you ask there.
        </p>
        <div class="claude-step">
          <span class="muted small">Claude Desktop: Settings › Developer › Edit Config, then add</span>
          <pre class="claude-code">{desktopJson()}</pre>
          <button type="button" class="btn small" onClick={() => void copy(desktopJson(), "the Claude Desktop lines")}>
            Copy
          </button>
        </div>
        <div class="claude-step">
          <span class="muted small">Claude Code: run once in a terminal</span>
          <pre class="claude-code">{codeLine()}</pre>
          <button type="button" class="btn small" onClick={() => void copy(codeLine(), "the Claude Code line")}>
            Copy
          </button>
        </div>
      </section>
      <section class="set-card">
        <div class="set-row">
          <div class="set-label">
            <span>What Claude sees</span>
            <span class="muted small">{shared().length ? "Only the ticked collections." : "Every collection, the inbox and your days."} Never the trash or your scratch pages.</span>
          </div>
        </div>
        <div class="claude-tops">
          <For each={tops()}>
            {(t) => (
              <label class="claude-top">
                <input type="checkbox" checked={sees(t)} onChange={() => flip(t)} />
                <span>{t}</span>
              </label>
            )}
          </For>
        </div>
        <label class="set-row set-toggle">
          <div class="set-label">
            <span>Let Claude add to your notes</span>
            <span class="muted small">To today's page, the inbox, a collection or the end of a note, only when you ask it to.</span>
          </div>
          <input type="checkbox" role="switch" checked={write()} onChange={(e) => void save(shared(), e.currentTarget.checked)} />
        </label>
      </section>
      <section class="set-card">
        <div class="set-row">
          <div class="set-label">
            <span>In a terminal</span>
            <span class="muted small">The same program. On Windows, add Petrel's folder to PATH to type just petrel.</span>
          </div>
        </div>
        <pre class="claude-code">{`petrel find "release checklist"
petrel add @today "Ask Amra for the icon by Thursday"
petrel copy "Meeting link" --blank day=Friday`}</pre>
      </section>
      <Show when={info()?.debug}>
        <p class="muted small set-note">This is a development build: it uses the development notes, not your real ones.</p>
      </Show>
    </>
  );
}
