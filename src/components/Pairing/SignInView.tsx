import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hasRealFirebaseConfig } from "@/lib/sync/firebaseConfig";
import { closeAuthWindow, startBrowserSignIn } from "@/lib/sync/firebase";
import { useAuthState, useSyncStore } from "@/stores/syncStore";

// Phone sign-in surface. Sign-in runs the hosted phone-auth page in an app-owned
// webview window (the app opens AND closes it itself — reliable, no stray browser
// tab). A "open in your browser" escape hatch falls back to the system browser if
// reCAPTCHA can't run in the embedded webview.
//
// `autoStart` (set when opened from the tray "Sign in & Sync" entry) kicks the
// flow off immediately on mount and shows a minimal waiting state — the user
// shouldn't have to click a button just to start signing in. Launch auto-present
// (App.tsx) leaves autoStart off and shows the call-to-action.
//
// Once signed in, App.tsx dismisses this window and lands on the screenshots
// column — the account identity + Log Out live at the bottom of Preferences.
export function SignInView({ autoStart = false }: { autoStart?: boolean }) {
  const authState = useAuthState();
  const authError = useSyncStore((s) => s.authError);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viaBrowser, setViaBrowser] = useState(false);
  const autoStartedRef = useRef(false);
  // Monotonic id so a superseded/unmounted attempt can't write state. Bumped on
  // each new attempt and when switching to the browser fallback.
  const flowRef = useRef(0);

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const ready =
    hasRealFirebaseConfig && authState !== "loading" && authState !== "error";

  // `startBrowserSignIn` blocks for the whole sign-in round-trip, so `busy` is
  // true for the entire wait. On success App.tsx flips out of "pairing" when auth
  // turns signedIn; nothing to do here.
  const run = useCallback(async (embed: boolean) => {
    const id = ++flowRef.current;
    setViaBrowser(!embed);
    setBusy(true);
    setError(null);
    try {
      await startBrowserSignIn(embed);
    } catch (e) {
      if (flowRef.current === id) setError(errMsg(e));
    } finally {
      if (flowRef.current === id) setBusy(false);
    }
  }, []);

  // Tray "Sign in & Sync": start the embedded flow immediately. Fire once per
  // mount, and only once config/auth have resolved (so we don't race the
  // not-ready card). Errors surface below; the user is never stuck on "Waiting…".
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || !ready) return;
    autoStartedRef.current = true;
    void run(true);
  }, [autoStart, ready, run]);

  // Escape hatch: abandon the embedded window and retry in the system browser.
  const openInBrowser = useCallback(async () => {
    flowRef.current++; // invalidate the in-flight embedded attempt
    await closeAuthWindow();
    void run(false);
  }, [run]);

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

  // In flight: minimal waiting state. The browser escape hatch shows only while
  // we're waiting on the embedded window (not when already in the browser).
  if (busy) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="max-w-sm text-pretty text-sm text-muted-foreground">
          {viaBrowser
            ? "Waiting for your browser — verify your number there and we'll bring you back here."
            : "Opening sign-in — verify your number to continue."}
        </p>
        {!viaBrowser && (
          <button
            type="button"
            onClick={openInBrowser}
            className="text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
          >
            Trouble signing in? Open in your browser instead
          </button>
        )}
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
        <h2 className="text-base font-semibold">Sign in with your phone</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {error
            ? "Something went wrong. Try again, or open the sign-in page in your browser."
            : "We'll open a secure sign-in window to verify your number, then bring you back here."}
        </p>
      </div>

      <Button onClick={() => run(true)} className="w-full">
        <Smartphone className="size-4" aria-hidden="true" />
        {error ? "Try again" : "Sign in with phone"}
      </Button>

      {error && (
        <button
          type="button"
          onClick={openInBrowser}
          className="text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
        >
          Open in your default browser instead
        </button>
      )}
    </div>
  );
}
