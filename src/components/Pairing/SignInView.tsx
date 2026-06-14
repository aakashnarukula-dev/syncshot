import { useState } from "react";
import { AlertTriangle, Check, Loader2, LogOut, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hasRealFirebaseConfig } from "@/lib/sync/firebaseConfig";
import { startBrowserSignIn } from "@/lib/sync/firebase";
import { signOutDevice } from "@/lib/sync/engine";
import { useAccountEmail, useAuthState, useSyncStore } from "@/stores/syncStore";

export function SignInView() {
  const authState = useAuthState();
  const authError = useSyncStore((s) => s.authError);
  const account = useAccountEmail();
  const uid = useSyncStore((s) => s.uid);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await startBrowserSignIn();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await signOutDevice();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (!hasRealFirebaseConfig || authState === "loading" || authState === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        {authState === "loading" && hasRealFirebaseConfig ? (
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <AlertTriangle className="size-6 text-muted-foreground" aria-hidden="true" />
        )}
        <p className="max-w-sm text-pretty text-sm text-muted-foreground">
          {!hasRealFirebaseConfig
            ? "Firebase isn't configured — set VITE_FB_API_KEY / VITE_FB_APP_ID and rebuild."
            : authState === "loading"
              ? "Connecting…"
              : (authError ?? "Couldn't reach Firebase — check your network and reopen.")}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col justify-center gap-4 p-6">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {authState === "signedIn" ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-accent/40 px-4 py-2 text-sm">
          <span className="flex items-center gap-2">
            <Check className="size-4 text-primary" aria-hidden="true" />
            <span className="font-medium">{account ?? `…${uid?.slice(-6) ?? ""}`}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={signOut}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <LogOut className="size-4" aria-hidden="true" />
            )}
            Sign out
          </Button>
        </div>
      ) : (
        <>
          <div>
            <h2 className="text-base font-semibold">Sign in with your phone</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              We'll open your browser to verify your number, then bring you back here.
            </p>
          </div>
          <Button onClick={signIn} disabled={busy} className="w-full">
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Smartphone className="size-4" aria-hidden="true" />
            )}
            {busy ? "Waiting for browser…" : "Sign in with phone"}
          </Button>
        </>
      )}
    </div>
  );
}
