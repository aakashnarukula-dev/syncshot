import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { loadLicenseStatus, type LicenseStatus } from "@/lib/license";

interface PaywallProps { reason: "expired" | "manual"; onActivated: (status: LicenseStatus) => void; onClose?: () => void; }
export function Paywall({ reason, onActivated, onClose }: PaywallProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <main className="flex min-h-dvh items-center justify-center bg-black px-8 text-zinc-200">
    <div className="w-full max-w-md space-y-6">
      <h1 className="text-balance text-3xl font-semibold">{reason === "expired" ? "Your trial has ended" : "Your SyncShot access"}</h1>
      <p className="text-pretty text-zinc-400">One account for your Mac and Android phone. ₹999 in India or $9 internationally, paid once.</p>
      <p className="rounded-lg border border-white/20 p-4 text-sm">Checkout is currently a demo. No payment is collected and demo checkout does not activate lifetime access.</p>
      <button className="w-full rounded-md bg-white px-4 py-3 text-black" onClick={() => {
        void openUrl("https://syncshot-seven.vercel.app/#pricing").catch(() => setError("Could not open the website. Visit syncshot-seven.vercel.app in your browser."));
      }}>View purchase options</button>
      <button disabled={busy} className="w-full rounded-md border border-white/30 px-4 py-3 disabled:opacity-50" onClick={async () => {
        setBusy(true); setError(null);
        try {
          const access = await loadLicenseStatus();
          if (access.state === "licensed" || access.state === "trial") onActivated(access);
          else setError(access.state === "unavailable" ? "Could not verify access. Sign in and check your connection, then retry." : "No active access on this account. Demo checkout does not grant a license.");
        } finally { setBusy(false); }
      }}>{busy ? "Checking account…" : "Refresh account access"}</button>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {onClose && <button onClick={onClose} className="block rounded-md px-4 py-2 underline">Back to SyncShot</button>}
    </div>
  </main>;
}
