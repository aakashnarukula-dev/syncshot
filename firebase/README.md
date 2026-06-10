# ScreenshotX / ClipboardX — Firebase backend

Realtime backend for the multi-device screenshot + clipboard sync: **Firestore**
(library data + realtime listeners), **Cloud Storage** (blobs), and **Cloud
Functions** (library bootstrap + device pairing). All authorization hangs off a
single Auth custom claim, `libId`.

- **Project:** `screenshot-x-v1` (`#428592678377`, parent org `gyftalala.com`)
- **Plan:** Blaze (required for Cloud Functions egress + scheduler) — confirmed on the project
- **Region:** `us-central1`
- **Functions runtime:** Node.js 20 (TypeScript → `functions/lib`)

## Layout

```
firebase/
  .firebaserc              default project → screenshot-x-v1
  firebase.json            wires rules + indexes + storage + functions
  firestore.rules          libId-claim gate; pairingCodes locked to admin SDK
  firestore.indexes.json   (empty — see "Indexes" below)
  storage.rules            libId-claim gate on libraries/{libId}/**
  functions/               Node 20 + TS, firebase-admin + firebase-functions v2
    src/index.ts
```

## Data model (the cross-device contract)

```
libraries/{libId}                     { owner, name, createdAt }
libraries/{libId}/members/{uid}       { uid, deviceName, platform, role, joinedAt }
libraries/{libId}/screenshots/{id}    { ..., createdAt }   ← written by clients
libraries/{libId}/clipboard/{id}      { ..., createdAt }   ← written by clients
pairingCodes/{code}                   { libId, createdBy, expiresAt, used }  ← functions only
```

Storage blobs live under `libraries/{libId}/...` in the project's default bucket
(`screenshot-x-v1.firebasestorage.app` — confirm via `apps:sdkconfig`).

## Authorization

- Each device is a Firebase Auth user. Its custom claim `libId` names the one
  library it can touch. Firestore + Storage rules allow read/write iff
  `request.auth.token.libId == libId`.
- `pairingCodes/**` is `allow read, write: if false` — only the Cloud Functions
  (admin SDK, which bypasses rules) read/write it.
- After any function sets a claim, **the client must force-refresh its ID token**
  (`getIdToken(true)`) before the new `libId` is visible to rules.

## Cloud Functions (v2 callable, region `us-central1`)

| Function | Auth | Input | Effect | Returns |
|---|---|---|---|---|
| `createLibrary` | signed-in | `{deviceName, platform}` | creates `libraries/{libId}` (`owner=uid`), adds `members/{uid}` (role `owner`), sets claim `{libId}` | `{libId}` |
| `createPairingCode` | member (`libId` claim) | `{}` | writes `pairingCodes/{code}` `{libId, createdBy, expiresAt=now+120s, used:false}` | `{code, expiresAt}` (`expiresAt` = epoch ms) |
| `redeemPairingCode` | signed-in | `{code, deviceName, platform}` | validates exists/unused/unexpired (transaction), adds `members/{uid}` (role `member`), marks code `used`, sets claim `{libId}` | `{libId}` |
| `revokeDevice` | member (`libId` claim) | `{uid}` | deletes that member doc, clears the target's claim (`null`) | `{ok:true}` |
| `cleanupExpiredCodes` | scheduled (hourly) | — | deletes `pairingCodes` past `expiresAt` | — |

Error codes: `unauthenticated` (not signed in), `permission-denied` (no `libId`
claim), `invalid-argument` (missing field), `not-found` / `failed-precondition`
(bad/expired/used code), `resource-exhausted` (code allocation failed).

## Indexes

`firestore.indexes.json` is intentionally **empty**. The realtime queries the
clients use are per-library single-field orders, e.g.

```
libraries/{libId}/screenshots  orderBy(createdAt, desc)
libraries/{libId}/clipboard    orderBy(createdAt, desc)
```

A bare `orderBy` on one field is served by Firestore's automatic single-field
indexes — **no composite index required**. Add a composite index here only if a
client introduces a compound query (a `where(...)` on one field **plus**
`orderBy(createdAt, desc)` on another); Firestore's error message will hand you
the exact index JSON to paste in.

## Build / verify (no deploy)

```bash
cd firebase/functions
npm install
npm run build      # tsc → lib/  (must exit 0)
```

## Deploy (orchestrator / user — needs interactive login + Blaze)

```bash
# one-time
npm install -g firebase-tools
firebase login                       # interactive (browser)

cd firebase
firebase use screenshot-x-v1

# deploy everything this dir owns
firebase deploy --only firestore:rules,firestore:indexes,storage,functions
```

First-ever functions deploy on this project may prompt to enable the Cloud
Functions, Cloud Build, Artifact Registry, and Cloud Scheduler APIs — accept.

## Web app config the Mac client needs

The Mac (and Android) clients initialize the Firebase Web SDK with these values
(captured from the registered `screenshotx-web` app — these are public client
config, not secrets):

```js
const firebaseConfig = {
  apiKey:            "AIzaSyDM8WuSfhIkQg4NkDLXLoN_KCMKROUbnvM",
  authDomain:        "screenshot-x-v1.firebaseapp.com",
  projectId:         "screenshot-x-v1",
  storageBucket:     "screenshot-x-v1.firebasestorage.app",
  messagingSenderId: "428592678377",
  appId:             "1:428592678377:web:9e202fb9f86ecd9710b778",
};
```

The Mac app (`src/lib/sync/firebaseConfig.ts`, on the mac branch) reads these from
Vite env at integration time — set:

```
VITE_FB_API_KEY=AIzaSyDM8WuSfhIkQg4NkDLXLoN_KCMKROUbnvM
VITE_FB_APP_ID=1:428592678377:web:9e202fb9f86ecd9710b778
```

(authDomain/projectId/storageBucket/messagingSenderId are already hardcoded or
default in the client.)

### Apps registered on `screenshot-x-v1`

| Platform | App ID | Package / nickname |
|---|---|---|
| Web | `1:428592678377:web:9e202fb9f86ecd9710b778` | `screenshotx-web` |
| Android | `1:428592678377:android:eeae517abb21732410b778` | `com.aakash.ssx` |

`google-services.json` for the Android app has been written to
`android/app/google-services.json` (gitignored by `android/.gitignore`, so it is
**not** committed — regenerate with
`firebase apps:sdkconfig android <appId> --out android/app/google-services.json -P screenshot-x-v1`).

## Integration checklist (console / gcloud — not deployable from this dir)

These must be done on `screenshot-x-v1` for the clients to actually work (see the
Mac sync notes):

1. **Enable Anonymous auth** — Auth → Sign-in method → Anonymous → Enable. The Mac
   client signs in anonymously before calling the pairing callables.
2. **Authorized domains** — Auth → Settings → Authorized domains → add the Tauri
   webview origins `tauri://localhost` and `http://asset.localhost`, else anonymous
   auth / callables fail in the desktop app.
3. **Storage CORS** — the Tauri webview reads `thumb.webp` / `full.png` via
   `getBytes` (CORS XHR); the default bucket CORS blocks it. Apply a CORS config
   that allows the Tauri origins to the bucket
   `screenshot-x-v1.firebasestorage.app`:
   ```bash
   gcloud storage buckets update gs://screenshot-x-v1.firebasestorage.app \
     --cors-file=cors.json
   # cors.json: [{"origin":["tauri://localhost","http://asset.localhost"],
   #              "method":["GET"],"responseHeader":["Content-Type"],"maxAgeSeconds":3600}]
   ```
4. **Firestore + Storage provisioned** — created as part of the deploy below
   (Firestore default DB in `us-central1`; default Storage bucket already exists).

Auth: the clients sign in (e.g. Anonymous or Email) to get a `uid`, then call
`createLibrary` (first device) or `redeemPairingCode` (additional devices) to
acquire the `libId` claim.
