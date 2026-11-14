// Settings › Sync: Google Drive, built in. Three steps the first time (a Google Cloud client of your own, sign in,
// on), then one card: the account, on or paused, when it last synced, and Sync now. The work is in Rust
// (src-tauri/src/sync.rs); this page only sets it up and shows the status.
import { createSignal, Show } from "solid-js";
import { api, errText } from "../api";
import { setSyncStatus, syncLine, syncStatus } from "../sync";
import { ago, say } from "../ui";

export default function SyncSection() {
  const [id, setId] = createSignal("");
  const [secret, setSecret] = createSignal("");
  const [busy, setBusy] = createSignal<null | "save" | "signin">(null);
  const st = () => syncStatus();

  async function run(kind: "save" | "signin" | null, f: () => Promise<import("../api").SyncStatus>, done?: string) {
    setBusy(kind);
    try {
      setSyncStatus(await f());
      if (done) say(done);
    } catch (e) {
      say(errText(e), { error: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h1>Sync</h1>
      <section class="set-card">
        <p class="set-note">
          Petrel keeps your folder and a <b>Petrel</b> folder in your Google Drive the same, on every computer where
          you sign in. Notes stay plain Markdown files you can open in Drive. A note changed in two places keeps both
          versions, and a note's history goes along too. No other service is involved.
        </p>
      </section>

      <Show when={!st()?.configured}>
        <section class="set-card">
          <h2 class="set-step">1. A Google client of your own</h2>
          <p class="set-note">Once, about ten minutes, at console.cloud.google.com:</p>
          <ol class="set-steps">
            <li>Make a project (any name, say Petrel) and turn on the <b>Google Drive API</b>.</li>
            <li>
              Under <b>Google Auth Platform</b>, set up the consent screen (External, your own address), add the scope{" "}
              <code>…/auth/drive.file</code>, then press <b>Publish app</b>. A testing app is signed out every 7 days.
            </li>
            <li>
              Under <b>Clients</b>, make a client of type <b>Desktop app</b>, and paste its ID and secret here.
            </li>
          </ol>
          <form
            class="set-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run("save", async () => (await api()).syncSetup(id().trim(), secret().trim()), "Saved. Now connect Google Drive.");
            }}
          >
            <input id="sync-client-id" placeholder="Client ID: …apps.googleusercontent.com" aria-label="Client ID" value={id()} onInput={(e) => setId(e.currentTarget.value)} autocomplete="off" />
            <input id="sync-client-secret" type="password" placeholder="Client secret" aria-label="Client secret" value={secret()} onInput={(e) => setSecret(e.currentTarget.value)} autocomplete="off" />
            <button class="btn primary" type="submit" disabled={!id().trim() || !secret().trim() || busy() !== null}>
              Save
            </button>
          </form>
          <p class="muted small set-note">The secret is kept in the system keyring. Each computer needs the same ID and secret.</p>
        </section>
      </Show>

      <Show when={st()?.configured && !st()?.signedIn}>
        <section class="set-card">
          <h2 class="set-step">2. Connect Google Drive</h2>
          <p class="set-note">
            Your browser opens Google's sign-in. Petrel asks only for the files it makes itself; it cannot see the rest
            of your Drive.
          </p>
          <Show when={st()?.state === "signin"}>
            <p class="bad small set-note">Google signed Petrel out. Connect again; nothing is lost.</p>
          </Show>
          <div class="set-row">
            <button class="btn primary" disabled={busy() !== null} onClick={() => void run("signin", async () => (await api()).syncSignIn(), "Connected. The first sync starts now.")}>
              {busy() === "signin" ? "Waiting for the browser…" : "Connect Google Drive"}
            </button>
            <button class="link small" onClick={() => setSyncStatus({ ...st()!, configured: false })}>
              Change the client
            </button>
          </div>
        </section>
      </Show>

      <Show when={st()?.signedIn}>
        <section class="set-card">
          <label class="set-row set-toggle">
            <div class="set-label">
              <span>Google Drive</span>
              <span class="muted small">{st()!.account || "Signed in"} · My Drive/Petrel</span>
            </div>
            <input type="checkbox" role="switch" checked={st()!.on} onChange={(e) => void run(null, async () => (await api()).syncSetOn(e.currentTarget.checked))} />
          </label>
          <div class="set-row">
            <div class="set-label">
              <span>{syncLine(st())?.text ?? "Off"}</span>
              <span class="muted small">{st()!.last ? `Last change: ${st()!.last}${st()!.lastAt ? `, ${ago(st()!.lastAt!)}` : ""}` : "Every 30 seconds while Petrel is open, and a moment after each save."}</span>
            </div>
            <button class="btn" disabled={!st()!.on} onClick={() => void api().then((s) => s.syncNow()).then(() => say("Syncing now"))}>
              Sync now
            </button>
          </div>
          <Show when={st()!.message}>
            <p class="small set-note" classList={{ bad: st()!.state === "error" || st()!.state === "blocked" }}>
              {st()!.message}
            </p>
          </Show>
          <div class="set-row">
            <span class="muted small grow">A note changed on both computers keeps both; the library shows a card to settle it.</span>
            <button class="link small" onClick={() => void run(null, async () => (await api()).syncSignOut(), "Signed out. Your notes stay here and in Drive.")}>
              Sign out
            </button>
          </div>
        </section>
      </Show>
    </>
  );
}
