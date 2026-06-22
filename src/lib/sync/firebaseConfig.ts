/**
 * Firebase Web App client configuration for the SyncShot Mac app.
 *
 * These are the PUBLIC web-app config values for the `syncshot-v2`
 * Firebase project (project number 424325660516, parent org gyftalala.com,
 * account mail@gyftalala.com). Safe to commit — access is gated by
 * Firestore/Storage security rules + the `libId` custom auth claim, NOT by
 * keeping these strings secret.
 *
 * Web app: SyncShot Web (1:424325660516:web:f839ae266e68a32ffec471).
 * VITE_FB_API_KEY / VITE_FB_APP_ID env vars still override apiKey/appId if set.
 */

const DEFAULT_API_KEY = "AIzaSyApIWE3umXq6BDvxiB7fCm6NHgsZZfB4nE";
const DEFAULT_APP_ID = "1:424325660516:web:f839ae266e68a32ffec471";

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY ?? DEFAULT_API_KEY,
  authDomain: "syncshot-v2.firebaseapp.com",
  projectId: "syncshot-v2",
  storageBucket: "syncshot-v2.firebasestorage.app",
  messagingSenderId: "424325660516",
  appId: import.meta.env.VITE_FB_APP_ID ?? DEFAULT_APP_ID,
} as const;

/** Cloud Functions region (callable pairing functions live here). */
export const FUNCTIONS_REGION = "us-central1";

/**
 * True once real web-app credentials are present (always true now that the
 * live syncshot-v2 values are the defaults). The UI uses this to decide
 * whether to show a "config missing" notice.
 */
export const hasRealFirebaseConfig =
  firebaseConfig.apiKey.length > 0 && firebaseConfig.appId.startsWith("1:");
