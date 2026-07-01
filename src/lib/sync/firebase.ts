/**
 * Firebase app initialization + typed service handles.
 *
 * Single source of truth for the Firebase JS SDK instances used by the sync
 * engine. Firestore is created with IndexedDB-backed offline persistence so
 * the screenshot/clipboard lists render instantly on cold start and writes are
 * queued while offline.
 *
 * Identity = phone sign-in. Phone + reCAPTCHA + OTP can't run inside the Tauri
 * webview: its `tauri://localhost` origin fails Firebase phone-auth's
 * reCAPTCHA app-credential check (`auth/invalid-app-credential`). So that step
 * runs on a hosted https page in the user's default browser, which mints a
 * Firebase custom token handed back over a one-shot loopback listener (Rust
 * `browser_auth_listen`); the app finishes with `signInWithCustomToken`. Every
 * device signs in to the same account; data lives under users/{uid}. Per-device
 * identity is a locally-persisted deviceId, NOT the auth uid.
 */

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
  persistentLocalCache,
  persistentSingleTabManager,
  type Firestore,
} from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";
import { firebaseConfig } from "./firebaseConfig";

export const app: FirebaseApp = initializeApp(firebaseConfig);

export const auth: Auth = getAuth(app);

// IndexedDB offline persistence (zero-latency cold render + offline writes).
// persistentSingleTabManager: ONLY the main webview ever initializes Firestore
// (the editor window renders EditorOnlyApp and never imports the sync layer),
// so the multi-tab manager's periodic IndexedDB lease writes were pure
// overhead. If a second Firestore-holding webview ever appears, persistence
// activation fails soft (in-memory cache + console warning), not a crash.
export const db: Firestore = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentSingleTabManager(undefined),
  }),
});

export const storage: FirebaseStorage = getStorage(app);

/**
 * Sign in via the system browser.
 *
 * Opens the hosted phone-auth page in the default browser (Rust side) and
 * blocks until it redirects back a Firebase custom token over loopback, then
 * exchanges it for a session. A leftover anonymous session (pre-OTP builds) is
 * discarded first. `onAuthStateChanged` fires on success, which starts the
 * sync engine.
 */
/**
 * Run the sign-in round-trip and sign this device in with the minted custom
 * token. `embed` (default) presents the hosted phone-auth page in an app-owned
 * webview window that the app closes itself on completion; `embed = false`
 * shells it out to the system browser (fallback for when reCAPTCHA can't run in
 * the embedded webview). Resolves once the user is signed in.
 */
export async function startBrowserSignIn(embed = true): Promise<User> {
  const token = await invoke<string>("browser_auth_listen", { embed });
  if (auth.currentUser?.isAnonymous) await signOut(auth);
  const cred = await signInWithCustomToken(auth, token);
  return cred.user;
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
