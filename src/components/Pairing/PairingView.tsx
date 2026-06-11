import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, Check, Loader2, QrCode, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { hasRealFirebaseConfig } from "@/lib/sync/firebaseConfig";
import {
  codeToQrDataUrl,
  createLibrary,
  createPairingCode,
  redeemPairingCode,
} from "@/lib/sync/pairing";
import { adoptLibrary, updateDeviceName } from "@/lib/sync/engine";
import { useAuthState, useDeviceName, useLibId, useSyncStore } from "@/stores/syncStore";

interface PairCode {
  code: string;
  qr: string;
  expiresAt: number;
}

export function PairingView({ onClose }: { onClose?: () => void }) {
  const authState = useAuthState();
  const authError = useSyncStore((s) => s.authError);
  const libId = useLibId();
  const deviceName = useDeviceName();

  const [name, setName] = useState(deviceName);
  const [joinCode, setJoinCode] = useState("");
  const [pairCode, setPairCode] = useState<PairCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => setName(deviceName), [deviceName]);

  // Drive the expiry countdown only while a code is showing.
  useEffect(() => {
    if (!pairCode) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pairCode]);

  const commitName = () => {
    if (name.trim() && name.trim() !== deviceName) void updateDeviceName(name);
  };

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const mintCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const { code, expiresAt } = await createPairingCode();
      const qr = await codeToQrDataUrl(code);
      setPairCode({ code, qr, expiresAt });
      setNow(Date.now());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const startNewLibrary = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateDeviceName(name);
      const newLibId = await createLibrary(name.trim() || "Mac");
      await adoptLibrary(newLibId);
      await mintCode();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  const join = async () => {
    const code = joinCode.trim();
    if (code.length !== 6) {
      setError("Enter the 6-digit code shown on the other device.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateDeviceName(name);
      const joinedLibId = await redeemPairingCode(code, name.trim() || "Mac");
      await adoptLibrary(joinedLibId);
      setJoinCode("");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (!hasRealFirebaseConfig) {
    return (
      <Notice
        onClose={onClose}
        icon={<AlertTriangle className="size-6" aria-hidden="true" />}
        title="Firebase isn't configured yet"
        body="Set VITE_FB_API_KEY and VITE_FB_APP_ID for the screenshot-x web app, then rebuild. Pairing and sync are disabled until then."
      />
    );
  }

  if (authState === "loading") {
    return (
      <Notice
        onClose={onClose}
        icon={<Loader2 className="size-6 animate-spin" aria-hidden="true" />}
        title="Connecting…"
        body="Signing this Mac in to Firebase."
      />
    );
  }

  if (authState === "error") {
    return (
      <Notice
        onClose={onClose}
        icon={<AlertTriangle className="size-6" aria-hidden="true" />}
        title="Couldn't reach Firebase"
        body={authError ?? "Check your network and that anonymous auth is enabled, then reopen this window."}
      />
    );
  }

  const secondsLeft = pairCode
    ? Math.max(0, Math.round((pairCode.expiresAt - now) / 1000))
    : 0;

  return (
    <div className="mx-auto h-full w-full max-w-xl overflow-y-auto p-6">
      {onClose && (
        <div className="mb-4 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ArrowLeft className="size-4" aria-hidden="true" /> Done
          </Button>
        </div>
      )}
      <div className="mb-6">
        <label htmlFor="device-name" className="mb-1.5 block text-sm font-medium">
          This device's name
        </label>
        <Input
          id="device-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          placeholder="Mac"
          maxLength={40}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {libId ? (
        <section className="space-y-4">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-accent/40 px-4 py-3 text-sm">
            <Check className="size-4 text-primary" aria-hidden="true" />
            <span>
              Paired · library <span className="font-mono text-xs">{libId.slice(0, 10)}…</span>
            </span>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-balance text-base font-semibold">Add another device</h2>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">
              Generate a code, then scan the QR (or type the 6 digits) on your Android device.
            </p>

            {pairCode ? (
              <div className="mt-4 flex flex-col items-center gap-3">
                <img
                  src={pairCode.qr}
                  alt="Pairing QR code"
                  className="size-44 rounded-lg border border-border bg-white p-2"
                />
                <p className="font-mono text-3xl font-semibold tracking-[0.3em] tabular-nums">
                  {pairCode.code}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {secondsLeft > 0 ? `Expires in ${secondsLeft}s` : "Expired — generate a new code"}
                </p>
                <Button variant="outline" size="sm" onClick={mintCode} disabled={busy}>
                  <RefreshCw className="size-4" aria-hidden="true" /> New code
                </Button>
              </div>
            ) : (
              <Button className="mt-4" onClick={mintCode} disabled={busy}>
                {busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <QrCode className="size-4" aria-hidden="true" />
                )}
                Show pairing code
              </Button>
            )}
          </div>
        </section>
      ) : (
        <section className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-balance text-base font-semibold">Join an existing library</h2>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">
              Enter the 6-digit code shown on a device that's already paired.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                placeholder="123456"
                aria-label="6-digit pairing code"
                className="font-mono tracking-[0.3em] tabular-nums"
              />
              <Button onClick={join} disabled={busy || joinCode.length !== 6}>
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : "Join"}
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-balance text-base font-semibold">Start a new library</h2>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">
              No devices paired yet? Create a library on this Mac, then add your Android device with the code it generates.
            </p>
            <Button className="mt-3" variant="outline" onClick={startNewLibrary} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : "Create library"}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

interface NoticeProps {
  icon: ReactNode;
  title: string;
  body: string;
  onClose?: () => void;
}

function Notice({ icon, title, body, onClose }: NoticeProps) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {onClose && (
        <div className="absolute left-4 top-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ArrowLeft className="size-4" aria-hidden="true" /> Done
          </Button>
        </div>
      )}
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </div>
      <h2 className="text-balance text-lg font-semibold">{title}</h2>
      <p className="max-w-sm text-pretty text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
