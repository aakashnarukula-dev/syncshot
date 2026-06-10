# ScreenshotX v2 + ClipboardX — Firebase Realtime Sync (Design Spec)

Date: 2026-06-11
Status: Approved (build ASAP)

## Goal

Blazing-fast, realtime, bidirectional sync between a macOS app (Tauri) and an Android app, backed entirely by Firebase (serverless — the self-hosted FastAPI hub is retired from the live path). Two features, one sync engine:

1. **ScreenshotX** — capture on any device → appears on all paired devices in <1s. Permanent cloud history.
2. **ClipboardX** — every copied text is captured, stored, and synced realtime; re-copy any past entry. Two-section nav (ScreenshotX / ClipboardX) on both apps.

This spec is the **contract**. The three build workers (Mac, Android, Firebase) implement to it in parallel without reading each other's code.

## Firebase project (fixed)

- Project ID: `screenshot-x` · number `905091147949` · account `aakashnarukula.dev@gmail.com` · **Blaze** plan.
- Android app: `com.app.screenshotx` (uses `android/app/google-services.json`, gitignored).
- Web app (for the Mac JS SDK): config lives in `src/lib/sync/firebaseConfig.ts` (client config, committable). If the web app isn't registered yet, register it (`firebase apps:create web` or console) and paste the config.
- Functions region: `us-central1`.

## Identity & pairing (QR / code, NOT Google Sign-In)

Firebase still needs to authenticate each device, so under the hood:

1. On first launch every device calls `signInAnonymously()` → a stable Firebase `uid` (the device identity). Persisted by the SDK.
2. Devices are grouped into a **library**. A device gains access by being a `member` of a library, enforced by a **custom auth claim** `libId` set on its uid by a Cloud Function. After pairing, the device **force-refreshes its ID token** to pick up the claim.
3. **Pairing protocol** (callable Cloud Functions, all require `context.auth`):
   - `createLibrary({ deviceName, platform }) → { libId }` — first-ever device. Creates `libraries/{libId}` (owner = caller uid), adds caller as member, sets caller's `libId` claim.
   - `createPairingCode({}) → { code, expiresAt }` — an existing member mints a 6-digit code. Writes `pairingCodes/{code} = { libId, createdBy, expiresAt: now+2min, used:false }`. The device also renders the code as a **QR** (payload = the 6-digit code string).
   - `redeemPairingCode({ code, deviceName, platform }) → { libId }` — a new device redeems. Validates exists/not-expired/not-used → adds caller to `libraries/{libId}/members/{uid}` → sets caller's `libId` claim → marks code `used`. Caller then force-refreshes token and starts listeners.
   - `revokeDevice({ uid })` (member-only) — removes a member doc + clears its claim. (Lower priority; stub OK.)
- **Joining UX:** any paired device can SHOW a code + QR. A new device joins by **entering the 6-digit code** (works everywhere) or **scanning the QR** (camera devices = Android). Mac joins by code entry; Mac shows QR for Android to scan.

## Data model (Firestore)

- `libraries/{libId}` = `{ owner: uid, name: string, createdAt: ts }`
- `libraries/{libId}/members/{uid}` = `{ deviceName, platform: 'mac'|'android', pairedAt: ts, lastSeenAt: ts }`
- `libraries/{libId}/screenshots/{id}` (id = auto) =
  `{ sha256, createdAt: serverTs, device:{uid,name,platform}, width, height, bytes, mime:'image/png', thumbPath, fullPath, status:'thumb'|'full' }`
- `libraries/{libId}/clipboard/{id}` (id = auto) =
  `{ text, hash, createdAt: serverTs, device:{uid,name,platform}, pinned:false, charCount }`
- `pairingCodes/{code}` = `{ libId, createdBy, expiresAt, used }` — **Cloud-Function writes only**, clients denied.

Dedup: screenshots by `sha256`, clipboard by consecutive `hash` (drop if equal to most-recent). Clipboard `text` capped at **100 KB** (skip larger — rare for text; keeps doc < Firestore's 1 MB).

## Storage

- `libraries/{libId}/screenshots/{id}/thumb.webp` — 320px max edge, WebP q≈70 (~10–20 KB).
- `libraries/{libId}/screenshots/{id}/full.png` — original.
- Clipboard is text-only → stored inline in Firestore, no Storage object.

## Security rules (the key to locking it down without Google login)

Both Firestore and Storage gate on the custom claim:

- Firestore `libraries/{libId}/{document=**}`: `allow read, write: if request.auth.token.libId == libId;`
- Firestore `pairingCodes/**`: `allow read, write: if false;` (functions use admin SDK, bypass rules).
- Storage `libraries/{libId}/{allPaths=**}`: `allow read, write: if request.auth.token.libId == libId;`

The claim is set only by the pairing functions, so membership is authoritative and revocable, and Storage needs no Firestore lookup.

## ScreenshotX flow (both platforms)

**Publish (capturing device):** capture → `sha256` → query `screenshots where sha256 ==` (skip if exists) → generate 320px WebP thumb → upload thumb to Storage → `addDoc(status:'thumb', thumbPath)` → upload `full.png` → `updateDoc(status:'full', fullPath, bytes)`. Optimistically render own shot locally first.

**Receive (every device):** `onSnapshot(screenshots, orderBy createdAt desc, limit 100)`. Added doc → render thumb immediately; when `status==full`, download full in background.
- **Mac:** on full → auto-save to ScreenshotX folder + copy image to clipboard (existing Rust path).
- **Android:** notify-to-copy (OS clipboard-write limit); tap notification/grid → save + copy. FCM data message wakes the app/WorkManager so the listener fires when killed.

## ClipboardX flow

**Mac capture:** a Rust thread polls `NSPasteboard.changeCount` (~400 ms). On change, read the string → hash → if non-empty and ≠ last → emit Tauri event `clipboard-changed { text }`. The webview dedupes and `addDoc`s to `clipboard`. A **pause toggle** (syncStore flag) suppresses capture when on.

**Android capture:** an **AccessibilityService** (`ClipboardCaptureService`) detects copy events and reads `ClipboardManager` → hash → dedupe → write `clipboard` doc. (Android 10+ blocks background clipboard reads for normal apps; the accessibility service is the chosen workaround — **must be verified on the device**, see Test plan. Onboarding screen guides the user to enable the service.)

**Receive (both):** `onSnapshot(clipboard, orderBy createdAt desc, limit 200)` → render list. Tap entry → write to local clipboard (Mac: Rust `set_clipboard_text`; Android: `ClipboardManager.setPrimaryClip`, foreground only). Pin/delete supported.

## Mac app (Tauri) architecture

- **Firebase JS SDK in the React webview** = realtime brain.
  - `src/lib/sync/firebase.ts` (init + anon auth), `firebaseConfig.ts` (web config), `pairing.ts` (callable fns + QR generate/encode), `screenshots.ts` (listener + uploader), `clipboard.ts` (listener + writer).
  - `src/stores/syncStore.ts` (zustand+immer): auth state, libId, `screenshots[]`, `clipboard[]`, `paused`.
- **Rust (`src-tauri/`)** keeps OS duties over existing IPC:
  - `clipboard.rs`: add `changeCount` poller → emit `clipboard-changed`; commands `set_clipboard_text`, keep image clipboard.
  - `commands.rs`: `save_synced_image`. Capture flow emits new-screenshot to webview for upload.
- **UI:** left-column nav, two sections **ScreenshotX** (existing grid) / **ClipboardX** (`src/components/ClipboardX/` list). Pairing view (show QR + code / enter code). Follow `AGENTS.md` UI rules (Tailwind defaults, Radix, no gratuitous motion, `h-dvh`).

## Android app architecture

- SDKs: Firebase Auth(anon) + Firestore (offline persistence ON) + Storage + FCM; Coil, Paging 3, **Room**, WorkManager, CameraX + ML Kit barcode (QR scan).
- Replace `data/HubClient.kt` → `FirebaseRepo`; rewrite `sync/SyncService`, `UploadWorker` to Storage+Firestore; `FcmService` keeps wake-ping.
- `ui/PairScreen` → QR scan + code entry → `redeemPairingCode`.
- `ui/GalleryScreen` → `LazyVerticalGrid` + Paging 3 sourced from Firestore, **Room-backed** for instant cold-start render; Coil loads `thumbPath` (disk cache keyed by sha256).
- New: `ClipboardX` screen + `ClipboardCaptureService` (AccessibilityService) + onboarding to enable it.
- **Bottom nav:** ScreenshotX | ClipboardX. Keep `applicationId = com.app.screenshotx`.

## Cloud Functions / backend (new `firebase/` dir)

- `firebase/functions/` (Node + TS, admin SDK): `createLibrary`, `createPairingCode`, `redeemPairingCode`, `revokeDevice` (stub OK), optional `cleanupExpiredCodes` (scheduled). All set/clear custom claims as specified.
- `firebase/firestore.rules`, `firebase/storage.rules`, `firebase/firestore.indexes.json`, `firebase/firebase.json`.
- No server-side thumbnail function — clients make thumbs (thumbnail-first is the speed path).
- Document the web-app config values needed by the Mac (`firebaseConfig.ts`).

## Blazing-fast levers (recap)

Thumbnail-first upload · Firestore offline persistence + Room/local cache → zero-latency cold render · WebP 320px thumbs · parallel thumb‖full uploads · content-addressed dedup · Coil/disk cache by sha256 · optimistic local render on the capturing device · FCM wake for killed Android.

## Worker decomposition (no file overlap)

- **A — Mac/Tauri:** only `src/**` + `src-tauri/**`.
- **B — Android:** only `android/**`.
- **C — Firebase:** only `firebase/**` (rules, functions, indexes, config) + documents web config.

All three hardcode the contract values from THIS spec; they do not depend on each other's files at build time.

## Test plan (attached Galaxy S22 Ultra, Android 16)

1. Pair Mac + Android via QR/code; confirm both reach the same `libId`.
2. Android screenshot → appears on Mac <1s (thumb), full saves + clipboard.
3. Mac screenshot → appears on Android grid <1s, notify-to-copy works.
4. Copy text on Mac → shows in Android ClipboardX; tap → re-copies. And reverse (verify the AccessibilityService actually captures on-device).
5. Grid cold-start renders instantly from Room cache; new shots animate in.
6. Kill Android app → capture on Mac → FCM wakes → item still syncs.

## User / console tasks (cannot automate)

- Confirm **Blaze** active (screenshot still showed Spark — Storage/Functions require Blaze).
- Enable **Firestore** + **Storage** in the `screenshot-x` console.
- Enable **Anonymous** auth provider.
- Register a **Web app** → provide config for `firebaseConfig.ts` (or allow `firebase login` so the CLI can fetch it).
- Ensure `android/app/google-services.json` matches `com.app.screenshotx` (re-download if needed).
- `firebase deploy` of rules + functions (orchestrator can run if `firebase login` is done).
