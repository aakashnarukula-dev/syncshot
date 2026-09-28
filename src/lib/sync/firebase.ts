/** Firebase identity and realtime services. Google sign-in uses the system
 * browser; account linking preserves legacy phone-account UIDs. */

import { invoke } from "@tauri-apps/api/core";
import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithCustomToken,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import {
  initializeFirestore,
  memoryLocalCache,
  type Firestore,
} from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";
import { firebaseConfig } from "./firebaseConfig";

export const app: FirebaseApp = initializeApp(firebaseConfig);

export const auth: Auth = getAuth(app);

export const db: Firestore = initializeFirestore(app, {
  localCache: memoryLocalCache(),
});

export const storage: FirebaseStorage = getStorage(app);

// Google rejects embedded user agents. Always use the system browser. Reuse a
// pending attempt so repeated tray clicks cannot open competing listeners.
let pendingSignIn: Promise<User> | null = null;
export function startBrowserSignIn(_embed = false): Promise<User> {
  if (pendingSignIn) return pendingSignIn;
  pendingSignIn = (async () => {
    const current = auth.currentUser;
    if (current?.providerData.some(p => p.providerId === "google.com")) return current;
    let linkToken: string | undefined;
    if (current && !current.isAnonymous && !current.providerData.some(p => p.providerId === "google.com")) {
      const { getFunctions, httpsCallable } = await import("firebase/functions");
      const result = await httpsCallable<void, { token: string }>(getFunctions(app, "us-central1"), "mintDesktopToken")();
      linkToken = result.data.token;
    }
    const token = await invoke<string>("browser_auth_listen", { embed: false, ...(linkToken ? { linkToken } : {}) });
    if (auth.currentUser?.isAnonymous) await signOut(auth);
    return (await signInWithCustomToken(auth, token)).user;
  })().finally(() => { pendingSignIn = null; });
  return pendingSignIn;
}

/** Dismiss the embedded sign-in window (used when switching to the browser fallback). */
export async function closeAuthWindow(): Promise<void> {
  try {
    await invoke("close_auth_window");
  } catch {
    /* best-effort */
  }
}

/** Sign this device out. */
export async function logout(): Promise<void> {
  await signOut(auth);
}

/**
 * Subscribe to auth state. Fires with the signed-in (non-anonymous) user or
 * null. A persisted anonymous session from pre-OTP builds is purged.
 */
export function watchAuth(
  onUser: (user: User | null) => void,
  onError?: (err: Error) => void,
): () => void {
  return onAuthStateChanged(
    auth,
    (user) => {
      if (user?.isAnonymous) {
        void signOut(auth); // fires this watcher again with null
        return;
      }
      onUser(user);
    },
    (err) => onError?.(err as Error),
  );
}
