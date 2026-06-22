# SyncShot / ClipboardX — Firebase backend

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
(captured from the registered `syncshot-web` app — these are public client
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
| Web | `1:428592678377:web:9e202fb9f86ecd9710b778` | `syncshot-web` |
| Android | `1:428592678377:android:eeae517abb21732410b778` | `com.aakash.ssx` |

`google-services.json` for the Android app has been written to
`android/app/google-services.json` (gitignored by `android/.gitignore`, so it is
**not** committed — regenerate with
`firebase apps:sdkconfig android <appId> --out android/app/google-services.json -P screenshot-x-v1`).

## Deployment status — LIVE on `screenshot-x-v1` ✅

All deployed/configured on 2026-06-11:

- ✅ **Firestore** — default DB created, `firestore.rules` + `firestore.indexes.json` released.
- ✅ **Storage** — default bucket `screenshot-x-v1.firebasestorage.app` (US-CENTRAL1) created + `storage.rules` released.
- ✅ **Functions** — all 5 deployed, Node 20 (2nd gen), us-central1:
  `createLibrary`, `createPairingCode`, `redeemPairingCode`, `revokeDevice` (callable) + `cleanupExpiredCodes` (scheduled hourly).
- ✅ **Storage CORS** — `tauri://localhost` + `http://asset.localhost` (GET/HEAD) allowed on the bucket.
- ✅ **Auth** — Anonymous sign-in enabled; authorized domains include `localhost`, `asset.localhost` (the Tauri webview hostnames).
- ✅ **Public invoker** — `allUsers` `roles/run.invoker` granted on the 4 callables (auth is enforced in-code). Verified: an unauthenticated call returns the function's own `{"status":"UNAUTHENTICATED"}`.

Redeploy any time with:
```bash
cd firebase && firebase use screenshot-x-v1
firebase deploy --only firestore:rules,firestore:indexes,storage,functions --force
```

> ⚠️ **Org-policy gotcha (gyftalala.com):** the first functions deploy failed with
> *"missing permission on the build service account"*. This project is under an org
> whose policy strips the automatic Editor grant from default service accounts, so
> the Compute Engine default SA (`428592678377-compute@developer.gserviceaccount.com`,
> the build+runtime SA for 2nd-gen functions) had **no** roles. Fixed by granting it
> `roles/cloudbuild.builds.builder` (build) + `roles/editor` (runtime: Firestore +
> Auth-admin for `setCustomUserClaims`). If functions deploys start failing again
> after a project/SA reset, re-grant those two roles to that SA.

> ⚠️ **Org-policy gotcha #2 — Domain Restricted Sharing:** Firebase **callable**
> functions must be invokable by `allUsers` (the Firebase ID token is verified
> inside the function, not at IAM). The `gyftalala.com` org enforces
> `constraints/iam.allowedPolicyMemberDomains`, which blocked the `allUsers`
> binding (`"users... do not belong to a permitted customer"`) — so the deployed
> callables returned a GFE **403** before reaching the code. Fixed by adding a
> **project-level org-policy override** on `screenshot-x-v1`
> (`iam.allowedPolicyMemberDomains` → `allowAll: true`, scoped to this project),
> then granting `allUsers` `roles/run.invoker` on the 4 callable Cloud Run
> services. Org-policy propagation took ~1 min. If callables start returning 403
> again, re-check this override and the invoker bindings.

Client flow: sign in anonymously → `uid` → call `createLibrary` (first device) or
`redeemPairingCode` (additional devices) → force-refresh the ID token
(`getIdToken(true)`) so the new `libId` claim is live → read/write under
`libraries/{libId}/**`.
