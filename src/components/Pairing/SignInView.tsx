import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hasRealFirebaseConfig } from "@/lib/sync/firebaseConfig";
import { startBrowserSignIn } from "@/lib/sync/firebase";
import { useAuthState, useSyncStore } from "@/stores/syncStore";

// Google OAuth runs in the system browser. Auth state dismisses this view.
export function SignInView({ autoStart = false }: { autoStart?: boolean }) {
  const authState = useAuthState();
  const authError = useSyncStore((s) => s.authError);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoStartedRef = useRef(false);
  // Monotonic id so a superseded/unmounted attempt can't write state. Bumped on
  // each new attempt and when the view unmounts.
  const flowRef = useRef(0);

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const ready =
    hasRealFirebaseConfig && authState !== "loading" && authState !== "error";

  // `startBrowserSignIn` blocks for the whole sign-in round-trip, so `busy` is
  // true for the entire wait. On success App.tsx flips out of "pairing" when auth
  // turns signedIn; nothing to do here.
  const run = useCallback(async () => {
    const id = ++flowRef.current;
    setBusy(true);
    setError(null);
    try {
      await startBrowserSignIn();
    } catch (e) {
      if (flowRef.current === id) setError(errMsg(e));
    } finally {
      if (flowRef.current === id) setBusy(false);
    }
  }, []);

  // Tray "Sign in & Sync": start the browser flow immediately. Fire once per
  // mount, and only once config/auth have resolved (so we don't race the
  // not-ready card). Errors surface below; the user is never stuck on "Waiting…".
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || !ready) return;
    autoStartedRef.current = true;
    void run();
  }, [autoStart, ready, run]);

  useEffect(() => () => { flowRef.current++; }, []);

  if (!ready) {
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

  // Keep the waiting state until the callback arrives or times out.
  if (busy) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="max-w-sm text-pretty text-sm text-muted-foreground">
          Waiting for your browser — choose your Google account there and we'll bring you back here.
        </p>
      </div>
    );
  }

  // Idle: initial call-to-action, or a retry after an error.
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

      <div>
        <h2 className="text-base font-semibold">Sign in with Google</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {error
            ? "Something went wrong. Try again to reopen Google sign-in."
            : "Use the same Google account on your Mac and Android phone. Your browser will return you here."}
        </p>
      </div>

      <Button onClick={() => run()} className="w-full">
        <LogIn className="size-4" aria-hidden="true" />
        {error ? "Try again" : "Continue with Google"}
      </Button>

    </div>
  );
}
