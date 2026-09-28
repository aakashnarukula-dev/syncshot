import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function ScreenRecordingPermission({ onRetry, onClose }: {
  onRetry: () => Promise<void>;
  onClose: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); }
    catch { setError("Could not complete that action. Please try again."); }
    finally { setBusy(false); }
  };
  return <main className="flex min-h-dvh items-center justify-center bg-zinc-950 px-8 text-zinc-100">
    <section className="w-full max-w-md space-y-5" aria-labelledby="screen-permission-title">
      <h1 id="screen-permission-title" className="text-2xl font-semibold">Allow screenshot access</h1>
      <p className="text-sm text-zinc-300">SyncShot needs Screen Recording access to capture your screen. macOS may not repeat its permission pop-up after access is removed.</p>
      <p className="text-sm text-zinc-400">Open System Settings and enable SyncShot. If it is missing, use the + button to add SyncShot from Applications.</p>
      <button disabled={busy} className="w-full rounded-lg bg-white px-4 py-3 text-black disabled:opacity-50"
        onClick={() => void run(() => invoke("open_screen_recording_settings"))}>Open Screen Recording settings</button>
      <button disabled={busy} className="w-full rounded-lg border border-white/30 px-4 py-3 disabled:opacity-50"
        onClick={() => void run(onRetry)}>I enabled access — try capture</button>
      <p className="text-xs text-zinc-400">If macOS still requires a restart, save any open edits, then restart SyncShot and press your capture shortcut again.</p>
      <div className="flex justify-between gap-3">
        <button disabled={busy} className="rounded px-2 py-2 underline" onClick={() => void run(() => invoke("restart_for_capture_permission"))}>Restart SyncShot</button>
        <button disabled={busy} className="rounded px-2 py-2 underline" onClick={() => void run(onClose)}>Not now</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </section>
  </main>;
}
