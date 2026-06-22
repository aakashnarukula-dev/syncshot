# Desktop phone-auth re-architecture (system-browser + loopback)

Date: 2026-06-14
Status: approved (brainstormed with user)

## Problem

In-webview Firebase phone OTP fails with `auth/invalid-app-credential`. The
Tauri webview origin is `tauri://localhost`, not a real web domain. Firebase
phone-auth's reCAPTCHA flow validates the app credential against the
reCAPTCHA config's authorized domains / API-key referrers; the webview origin
is not recognized, so the backend rejects it. This is structural — it cannot
be fixed by tweaking the in-webview reCAPTCHA (same wall Electron apps hit).

## Decision

Move the phone + reCAPTCHA + OTP step to a **real https domain in the user's
default browser**, then hand the signed-in session back to the desktop app.

- **Hosted page domain:** Firebase Hosting `screenshot-x-v1.web.app` — already
  an auto-authorized Firebase Auth domain, so reCAPTCHA/phone work with zero
  domain config.
- **Session hand-back:** custom token. The page (signed in as the phone user)
  calls a new callable that mints `admin.auth().createCustomToken(uid)`; the
  app calls `signInWithCustomToken`. (The Firebase JS SDK has no supported way
  to inject an id/refresh token into a session, so a minted custom token is
  the clean bridge.)
- **Transport:** loopback HTTP listener (RFC 8252 native-app pattern). No new
  Tauri plugin, no custom URL-scheme / Info.plist registration.

## Flow

1. App "Sign in with phone" → Rust binds `127.0.0.1:0`, generates a `state`
   nonce, opens the default browser (tauri-plugin-opener) to
   `https://screenshot-x-v1.web.app/auth.html?cb_port=<port>&state=<nonce>`.
2. Page: phone input → invisible reCAPTCHA → `signInWithPhoneNumber` → OTP
   input → `confirm`. Now signed in on a real domain (no invalid-app-credential).
3. Page calls callable `mintDesktopToken` → gets a custom token.
4. Page redirects to `http://127.0.0.1:<port>/?token=<customToken>&state=<nonce>`.
5. Rust listener accepts one request, validates `state`, returns `{token}` to
   the awaiting JS, and serves a "return to SyncShot" page. Times out ~5 min.
6. App calls `signInWithCustomToken(auth, token)` → `onAuthStateChanged` fires
   → existing engine starts listeners. No engine logic change required.

## Components

1. **Hosted auth page** — `firebase/public/auth.html`, dependency-free (Firebase
   modular SDK from CDN, public firebaseConfig). Add `hosting` block to
   `firebase/firebase.json` (public: `public`).
2. **`mintDesktopToken` callable** — `firebase/functions/src/index.ts`. Requires
   an authenticated caller; returns `createCustomToken(uid)` (preserving the
   `libId` claim if present so pairing survives the hop).
3. **Rust loopback listener** — new command in `src-tauri` (e.g.
   `browser_auth_listen`): bind `127.0.0.1:0`, open browser, block on one
   request, validate `state`, parse `token`, return it; 5-min timeout; serve a
   small success page. Unit-tested query/state parsing.
4. **Frontend rewire** —
   - `src/lib/sync/firebase.ts`: replace `sendPhoneOtp`/`confirmPhoneOtp` with
     `startBrowserSignIn()` (invoke the Rust command, then
     `signInWithCustomToken`). Drop `RecaptchaVerifier`/`signInWithPhoneNumber`
     imports.
   - `src/components/Pairing/SignInView.tsx`: replace phone/OTP inputs with a
     single "Sign in with phone" button that calls `startBrowserSignIn`. Drop
     the `ssx-recaptcha` div.

## Security

- `state` nonce (generated Rust-side, echoed by the page) blocks token
  injection from another local process hitting the listener.
- Custom token is single-use-ish, 1h TTL, travels only over loopback
  (`127.0.0.1`, bound to localhost not `0.0.0.0`).
- `mintDesktopToken` requires a verified phone session, so only a legitimately
  authenticated user can obtain a token.

## Testing

- Rust unit test: callback URL parsing + `state` mismatch rejection.
- vitest: `startBrowserSignIn` plumbing — mocked Rust `invoke` returns a token,
  assert `signInWithCustomToken` is called with it; error paths surface.
- Manual end-to-end after deploy: real number → SMS → app signs in, no
  `auth/invalid-app-credential`.

## Deploy

End-to-end requires `firebase deploy` (hosting + the new function) to the live
`screenshot-x-v1` project — an outward-facing action. Code lands first; deploy
is confirmed with the user before running.

## Out of scope

- Google / email-link providers (phone stays the product's identity).
- Deep-link custom-scheme transport (loopback chosen instead).
