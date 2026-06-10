/**
 * Firebase Web App client configuration for the ScreenshotX Mac app.
 *
 * These are the PUBLIC web-app config values for the `screenshot-x-v1`
 * Firebase project (project number 428592678377, parent org gyftalala.com,
 * account mail@gyftalala.com). Safe to commit — access is gated by
 * Firestore/Storage security rules + the `libId` custom auth claim, NOT by
 * keeping these strings secret.
 *
 * Web app: screenshotx-web (1:428592678377:web:9e202fb9f86ecd9710b778).
 * VITE_FB_API_KEY / VITE_FB_APP_ID env vars still override apiKey/appId if set.
 */

const DEFAULT_API_KEY = "AIzaSyDM8WuSfhIkQg4NkDLXLoN_KCMKROUbnvM";
const DEFAULT_APP_ID = "1:428592678377:web:9e202fb9f86ecd9710b778";

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY ?? DEFAULT_API_KEY,
  authDomain: "screenshot-x-v1.firebaseapp.com",
  projectId: "screenshot-x-v1",
  storageBucket: "screenshot-x-v1.firebasestorage.app",
  messagingSenderId: "428592678377",
  appId: import.meta.env.VITE_FB_APP_ID ?? DEFAULT_APP_ID,
} as const;

/** Cloud Functions region (callable pairing functions live here). */
export const FUNCTIONS_REGION = "us-central1";

/**
 * True once real web-app credentials are present (always true now that the
 * live screenshot-x-v1 values are the defaults). The UI uses this to decide
 * whether to show a "config missing" notice.
 */
export const hasRealFirebaseConfig =
  firebaseConfig.apiKey.length > 0 && firebaseConfig.appId.startsWith("1:");
