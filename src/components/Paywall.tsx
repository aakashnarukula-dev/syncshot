import { useState } from "react";
import { Check, KeyRound, Loader2 } from "lucide-react";
import { activateLicense } from "@/lib/license";
import { toast } from "sonner";

interface PaywallProps {
  reason: "expired" | "manual";
  onActivated: (key: string) => void;
  onClose?: () => void;
}

export function Paywall({ reason, onActivated, onClose }: PaywallProps) {
  const [key, setKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleActivate = async () => {
    setSubmitting(true);
    setError(null);
    const result = await activateLicense(key);
    setSubmitting(false);
    if (result.ok) {
      toast.success("SyncShot activated");
      onActivated(result.key);
    } else {
      setError(result.error);
    }
  };

  return (
    <main className="min-h-dvh bg-black text-zinc-200 font-mono flex items-center justify-center px-8 selection:bg-white selection:text-black">
      <div className="w-full max-w-md space-y-8">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full border border-emerald-400/40 text-emerald-300 text-[10px] uppercase tracking-[0.2em]">
            {reason === "expired" ? "trial ended" : "activate"}
          </div>
          <h1 className="text-2xl text-white tracking-tight">
            {reason === "expired" ? "Your trial has ended." : "Activate SyncShot"}
          </h1>
          <p className="text-xs text-zinc-500 leading-relaxed">
            One-time purchase. Lifetime updates. Use on one Mac at a time.
          </p>
        </div>

        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-5 space-y-4">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl text-white tracking-tight">$9</span>
            <span className="text-[11px] text-zinc-500">/ ₹999 IN</span>
          </div>
          <ul className="space-y-1.5 text-[11px] text-zinc-400">
            {[
              "Lifetime use, lifetime updates",
              "All annotation tools + OCR",
              "Auto-copy to clipboard",
              "Drag & drop anywhere",
            ].map((f) => (
              <li key={f} className="flex items-center gap-2">
                <Check className="size-3 text-emerald-400" />
                {f}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => toast.info("Purchase will open in your browser (coming soon)")}
            className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-md bg-white text-black text-xs hover:bg-zinc-200 transition-colors"
          >
            Buy — $9
          </button>
        </div>

        <div className="space-y-2.5">
          <label className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 flex items-center gap-2">
            <KeyRound className="size-3" /> Already bought? Enter key
          </label>
          <input
            type="text"
            value={key}
            placeholder="SCRNX-XXXX-XXXX"
            onChange={(e) => {
              setError(null);
              setKey(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleActivate();
            }}
            className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-emerald-500/40 focus:bg-white/[0.05] transition-colors font-mono text-xs tracking-wider"
            autoFocus
          />
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          <button
            type="button"
            onClick={handleActivate}
            disabled={submitting || !key.trim()}
            className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-md bg-emerald-500/15 border border-emerald-400/40 text-emerald-300 hover:bg-emerald-500/20 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Activate
          </button>
        </div>

        {onClose && reason === "manual" && (
          <button
            onClick={onClose}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors block mx-auto"
          >
            Cancel
          </button>
        )}

        <p className="text-[10px] text-zinc-700 text-center">
          Activation key sent to your email after purchase.
        </p>
      </div>
    </main>
  );
}
