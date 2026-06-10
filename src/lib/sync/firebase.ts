/**
 * Firebase app initialization + typed service handles.
 *
 * Single source of truth for the Firebase JS SDK instances used by the sync
 * engine. Firestore is created with IndexedDB-backed offline persistence so
 * the screenshot/clipboard lists render instantly on cold start and writes are
 * queued while offline.
 */

import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  type Auth,
  type User,
} from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";
import { getFunctions, type Functions } from "firebase/functions";
import { firebaseConfig, FUNCTIONS_REGION } from "./firebaseConfig";

export const app: FirebaseApp = initializeApp(firebaseConfig);

export const auth: Auth = getAuth(app);

// IndexedDB offline persistence (zero-latency cold render + offline writes).
// persistentMultipleTabManager keeps multiple webviews (main + any future
// windows) coherent without throwing the single-tab "failed-precondition".
export const db: Firestore = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

export const storage: FirebaseStorage = getStorage(app);

export const functions: Functions = getFunctions(app, FUNCTIONS_REGION);

let anonReady: Promise<User> | null = null;

/**
 * Ensure the device has a stable anonymous Firebase identity. Idempotent —
 * resolves with the persisted `User` on subsequent calls. The returned uid is
 * the device identity used throughout the sync engine.
 */
export function ensureAnonAuth(): Promise<User> {
  if (anonReady) return anonReady;
  anonReady = new Promise<User>((resolve, reject) => {
    const unsub = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          unsub();
          resolve(user);
        }
      },
      (err) => {
        unsub();
        reject(err);
      },
    );
    // If no persisted session, kick off anonymous sign-in. onAuthStateChanged
    // above fires once it completes.
    if (!auth.currentUser) {
      signInAnonymously(auth).catch((err) => {
        unsub();
        reject(err);
      });
    }
  });
  return anonReady;
}

/**
 * Force an ID-token refresh so a freshly-set `libId` custom claim is picked up
 * by the client (claims only load into the SDK on token refresh).
 */
export async function refreshIdToken(): Promise<void> {
  if (auth.currentUser) {
    await auth.currentUser.getIdToken(true);
  }
}
