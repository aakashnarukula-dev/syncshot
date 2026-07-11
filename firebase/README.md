# SyncShot — Firebase backend

Backend for the SyncShot desktop app: **Auth** (phone sign-in → per-user data),
**Firestore** + **Cloud Storage** (per-user screenshot/clipboard data), **Cloud
Functions** (desktop sign-in token bridge + legacy pairing), and **Hosting** (the
hosted phone-auth page the desktop app opens).

- **Project:** `syncshot-v2` (`#424325660516`)
- **Owner / deploy account:** `mail@gyftalala.com` (verified via `firebase projects:list`;
  the older `aakashnarukula.dev@gmail.com` guess was wrong). Project is under the
  `gyftalala.com` org.
- **Plan:** Blaze (Cloud Functions are deployed, which requires it)
- **Region:** `us-central1`
- **Functions runtime:** Node.js 20 (TypeScript → `functions/lib`)
- **Hosting:** `https://syncshot-v2.web.app` (serves `public/auth.html`)

> ⚠️ **This project replaced the older `screenshot-x-v1`.** If you find
> `screenshot-x-v1`, `#428592678377`, apiKey `AIzaSyDM8WuSfhIkQg4NkDLXLoN_KCMKROUbnvM`,
> or app id `1:428592678377:...` anywhere, it is STALE — the live project is
> `syncshot-v2`. `.firebaserc` default is `syncshot-v2`.

## Layout

```
firebase/
  .firebaserc              default project → syncshot-v2
  firebase.json            wires hosting + rules + indexes + storage + functions
  public/auth.html         hosted phone-auth sign-in page (Hosting)
  firestore.rules          per-user gate: users/{uid}/** iff request.auth.uid == uid
  firestore.indexes.json   (empty — see "Indexes")
  storage.rules            per-user gate on users/{uid}/**
  functions/               Node 20 + TS, firebase-admin + firebase-functions v2
    src/index.ts
```

## Identity & data model (current)

- **Sign-in = phone (OTP).** Every device signs in to the **same account**; all
  data lives under `users/{uid}/**`. Per-device identity is a locally-persisted
  `deviceId`, not the auth uid (see `src/lib/sync/firebase.ts`).
- Firestore + Storage rules gate purely on `request.auth.uid == uid`:
  ```
  match /users/{uid}/{document=**}     // firestore.rules
  match /users/{uid}/{allPaths=**}     // storage.rules
  allow read, write: if request.auth != null && request.auth.uid == uid;
  ```
- Storage blobs live under `users/{uid}/...` in the default bucket
  `syncshot-v2.firebasestorage.app`.

> ⚠️ **Stale in-code comments:** `firestore.rules` and `storage.rules` headers say
> "email-link sign-in" — that's outdated. The real flow is **phone-auth**
> (`public/auth.html`). The `functions/src/index.ts` header still describes the
> old `libraries/{libId}` + `pairingCodes` model too (see below).

## The desktop phone-auth flow (why Hosting exists)

Firebase phone-auth's reCAPTCHA rejects the Tauri app webview origin
(`tauri://localhost` → `auth/invalid-app-credential`), so the phone + reCAPTCHA +
OTP step can't run in the app window. Instead:

1. The app opens `https://syncshot-v2.web.app/auth.html?cb_port=<port>&state=<nonce>`
   (in an app-owned webview, or the system browser as a fallback) — see
   `src-tauri/src/auth.rs`.
2. `auth.html` runs phone-auth (`signInWithPhoneNumber` + invisible
   `RecaptchaVerifier`), then calls the **`mintDesktopToken`** callable to get a
   Firebase custom token, and redirects to
   `http://127.0.0.1:<port>/?token=…&state=…`.
3. The app intercepts that callback, lifts the token, and finishes with
   `signInWithCustomToken`.

**Dev reCAPTCHA bypass (deployed 2026-07-12):** `auth.html` sets
`auth.settings.appVerificationDisabledForTesting` for an allow-listed set of
Firebase **test phone numbers** (or `?test=1`), so those sign in with the fixed
console code and **no captcha / no SMS**. Real numbers still get full reCAPTCHA +
SMS. The test numbers live under Console → Authentication → Sign-in method → Phone
→ "Phone numbers for testing" **and** in the `TEST_NUMBERS` set in `auth.html` —
this page is public, so remove them from both before a real launch.

## Cloud Functions (v2 callable, region `us-central1`)

| Function | Auth | Effect | Status |
|---|---|---|---|
| `mintDesktopToken` | signed-in | mints a custom token (`auth.createCustomToken`) for the desktop hand-off | **ACTIVE** — used by `auth.html` |
| `createLibrary` | signed-in | creates `libraries/{libId}`, adds `members/{uid}`, sets `libId` claim | legacy |
| `createPairingCode` | member (`libId` claim) | writes short-lived `pairingCodes/{code}` | legacy |
| `redeemPairingCode` | signed-in | joins the code's library, sets `libId` claim | legacy |
| `revokeDevice` | member (`libId` claim) | removes a member, clears its `libId` claim | legacy |
| `cleanupExpiredCodes` | scheduled (hourly) | GC stale `pairingCodes` | legacy |

> ⚠️ **Legacy vs current:** the `libraries/{libId}` + `pairingCodes` + `libId`-claim
> functions are from the older multi-library/pairing design. The **current**
> Firestore/Storage rules only expose `users/{uid}/**` — they don't grant clients
> access to `libraries/**` or `pairingCodes/**` (those functions use the admin SDK,
> which bypasses rules). Treat everything except `mintDesktopToken` as legacy until
> confirmed still wired to a client. Don't document them as the live contract.

**`mintDesktopToken` gotcha:** `createCustomToken` with no embedded private key
signs via the IAM `signBlob` API, so the **runtime service account needs
`roles/iam.serviceAccountTokenCreator`**. If minting fails with an INTERNAL / IAM
error, grant that role to the functions runtime SA.

## Registered apps on `syncshot-v2`

| Platform | App ID |
|---|---|
| Web | `1:424325660516:web:f839ae266e68a32ffec471` |
| Android | `1:424325660516:android:402841aebec1c1fbfec471` |

Web app config the Mac client uses (public client config, not secrets — mirrors
`src/lib/sync/firebaseConfig.ts` and `public/auth.html`):

```js
const firebaseConfig = {
  apiKey:            "AIzaSyApIWE3umXq6BDvxiB7fCm6NHgsZZfB4nE",
  authDomain:        "syncshot-v2.firebaseapp.com",
  projectId:         "syncshot-v2",
  storageBucket:     "syncshot-v2.firebasestorage.app",
  messagingSenderId: "424325660516",
  appId:             "1:424325660516:web:f839ae266e68a32ffec471",
};
```
`VITE_FB_API_KEY` / `VITE_FB_APP_ID` env vars override `apiKey`/`appId` at build
time; the rest are hardcoded defaults in the client.

## Indexes

`firestore.indexes.json` is intentionally **empty** — the per-user queries are
single-field `orderBy(createdAt, desc)`, served by Firestore's automatic
single-field indexes. Add a composite index only if a client introduces a
`where(...)` + `orderBy(...)` compound query; the runtime error will hand you the
exact index JSON.

## Build / verify (no deploy)

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # Node 22 LTS; default node may be too new
cd firebase/functions
npm install
npm run build      # tsc → lib/  (must exit 0)
```

## Deploy

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm install -g firebase-tools

# Auth: `firebase login` needs an INTERACTIVE terminal + browser. It will NOT run
# from a non-TTY (e.g. an automated/agent shell errors "Cannot run login in
# non-interactive mode"). Options:
#   • run it in a real Terminal.app, OR
#   • use a service-account key non-interactively:
#       GOOGLE_APPLICATION_CREDENTIALS=<sa.json> firebase deploy … --project syncshot-v2
firebase login

cd firebase
# Hosting only (the phone-auth page):
firebase deploy --only hosting --project syncshot-v2
# Everything this dir owns:
firebase deploy --only hosting,firestore:rules,firestore:indexes,storage,functions --project syncshot-v2
```

## Deployment status

- ✅ **Hosting** — `public/auth.html` deployed to `syncshot-v2` on **2026-07-12**
  (this pass); live at `https://syncshot-v2.web.app/auth.html`, verified serving
  the test-number reCAPTCHA bypass.
- ❔ **Functions / Firestore rules / Storage rules / indexes** — present in this
  dir and target `syncshot-v2`, but their deployed state on `syncshot-v2` was
  **not verified in this pass**. Check the console or re-deploy if unsure.

> ⚠️ **Org-policy gotchas (carried over from `screenshot-x-v1`, same `gyftalala.com`
> org — may apply here too, verify before assuming):**
> 1. **Build/runtime SA roles:** the org policy strips the automatic Editor grant
>    from default SAs, so 2nd-gen functions deploys can fail with *"missing
>    permission on the build service account"*. Fix: grant the Compute Engine
>    default SA (`424325660516-compute@developer.gserviceaccount.com`)
>    `roles/cloudbuild.builds.builder` + `roles/editor`. (For `mintDesktopToken`
>    also grant `roles/iam.serviceAccountTokenCreator`, per above.)
> 2. **Domain Restricted Sharing:** `constraints/iam.allowedPolicyMemberDomains`
>    can block the `allUsers` `roles/run.invoker` binding callables need (Firebase
>    verifies the ID token in-code), yielding a GFE **403**. Fix: a project-level
>    org-policy override (`allowAll: true`) + grant `allUsers` `roles/run.invoker`
>    on the callable Cloud Run services.
