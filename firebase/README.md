# ScreenshotX / ClipboardX — Firebase backend

Realtime backend for the multi-device screenshot + clipboard sync: **Firestore**
(library data + realtime listeners), **Cloud Storage** (blobs), and **Cloud
Functions** (library bootstrap + device pairing). All authorization hangs off a
single Auth custom claim, `libId`.

- **Project:** `screenshot-x` (`#905091147949`)
- **Plan:** Blaze (required for Cloud Functions egress + scheduler)
- **Region:** `us-central1`
- **Functions runtime:** Node.js 20 (TypeScript → `functions/lib`)

## Layout

```
firebase/
  .firebaserc              default project → screenshot-x
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

Storage blobs live under `libraries/{libId}/...` in bucket
`screenshot-x.appspot.com`.

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
firebase use screenshot-x

# deploy everything this dir owns
firebase deploy --only firestore:rules,firestore:indexes,storage,functions
```

First-ever functions deploy on this project may prompt to enable the Cloud
Functions, Cloud Build, Artifact Registry, and Cloud Scheduler APIs — accept.

## Web app config the Mac client needs

The Mac (and Android) clients initialize the Firebase Web SDK with these values.
Known-from-project:

```js
const firebaseConfig = {
  apiKey:            "TODO — from Firebase console",   // ⬅ MISSING, see below
  authDomain:        "screenshot-x.firebaseapp.com",
  projectId:         "screenshot-x",
  storageBucket:     "screenshot-x.appspot.com",
  messagingSenderId: "905091147949",
  appId:             "TODO — from Firebase console",   // ⬅ MISSING, see below
};
```

`apiKey` and `appId` are per-registered-app and **cannot be derived here** — they
require a Web app registered in the project, which needs console/CLI login (not
done in this worktree). To obtain them:

```bash
# register a Web app (once), then print the config:
firebase apps:create web "screenshotx-web"     # if no web app exists yet
firebase apps:sdkconfig web                     # prints apiKey + appId + the rest
```

Paste the printed `apiKey` and `appId` into the clients' Firebase config.

> Note: newer Firebase projects sometimes report the bucket as
> `screenshot-x.firebasestorage.app` instead of `screenshot-x.appspot.com`.
> Confirm the actual value from `apps:sdkconfig` / the console and use that for
> Storage.

Auth: the clients sign in (e.g. Anonymous or Email) to get a `uid`, then call
`createLibrary` (first device) or `redeemPairingCode` (additional devices) to
acquire the `libId` claim.
