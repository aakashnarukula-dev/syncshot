/**
 * Firebase Web App client configuration for the ScreenshotX Mac app.
 *
 * The values below are the PUBLIC web-app config for the `screenshot-x`
 * Firebase project (project number 905091147949, account
 * aakashnarukula.dev@gmail.com). This config is safe to commit — access is
 * gated by Firestore/Storage security rules + the `libId` custom auth claim,
 * NOT by keeping these strings secret.
 *
 * Fixed, known values are hardcoded from the binding design spec
 * (docs/superpowers/specs/2026-06-11-screenshotx-clipboardx-firebase-realtime-design.md):
 *   - projectId          screenshot-x
 *   - authDomain         screenshot-x.firebaseapp.com
 *   - storageBucket      screenshot-x.appspot.com
 *   - messagingSenderId  905091147949
 *
 * `apiKey` and `appId` are device/web-app specific and are read from Vite env
 * vars at build time:
 *   - VITE_FB_API_KEY
 *   - VITE_FB_APP_ID
 * The orchestrator injects the real values at integration (e.g. via a .env
 * file or CI). Until then the clearly-marked PLACEHOLDER_* fallbacks let the
 * app compile and the UI render; live Firebase calls will fail (and the
 * Pairing view surfaces a setup notice) until the real values are present.
 */

const PLACEHOLDER_API_KEY = "PLACEHOLDER_VITE_FB_API_KEY";
const PLACEHOLDER_APP_ID = "PLACEHOLDER_VITE_FB_APP_ID";

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY ?? PLACEHOLDER_API_KEY,
  authDomain: "screenshot-x.firebaseapp.com",
  projectId: "screenshot-x",
  storageBucket: "screenshot-x.appspot.com",
  messagingSenderId: "905091147949",
  appId: import.meta.env.VITE_FB_APP_ID ?? PLACEHOLDER_APP_ID,
} as const;

/** Cloud Functions region (callable pairing functions live here). */
export const FUNCTIONS_REGION = "us-central1";

/**
 * True once the real web-app credentials have been injected. The engine still
 * initializes when false, but anonymous auth / Firestore calls will fail —
 * the UI uses this flag to show an actionable "config missing" notice instead
 * of opaque network errors.
 */
export const hasRealFirebaseConfig =
  firebaseConfig.apiKey !== PLACEHOLDER_API_KEY &&
  firebaseConfig.appId !== PLACEHOLDER_APP_ID;
