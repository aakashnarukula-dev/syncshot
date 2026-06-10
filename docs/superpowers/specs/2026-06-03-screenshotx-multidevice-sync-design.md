# ScreenshotX Multi-Device Sync — Design Spec

**Date:** 2026-06-03
**Status:** Approved design, pre-implementation
**Author:** Aakash + Claude

## 1. Goal

One screenshot, on all your devices. Capture a screenshot on any of your 3 devices
(Mac mini, MacBook, Android phone) and it automatically appears on the other two —
saved locally and copied to the clipboard (within OS limits). Self-hosted: screenshots
only ever live on your own devices/hub. Works from any network.

This replaces the current accidental Mac↔Mac sync (which silently relies on iCloud
Desktop syncing the `~/Desktop/ScreenshotX` folder) with an explicit, account-based,
folder-location-independent sync the app actually owns.

## 2. Non-goals (v1)

- Cross-device **delete propagation** — deletes are local-only in v1 (avoids accidental
  data loss; revisit with tombstones later).
- Multi-user / multi-account — it's a single user (you) with N devices.
- History pruning / retention limits.
- iOS client.
- Editing sync (annotations stay local to where you edit).

## 3. Architecture — self-hosted hub-and-spoke

```
                         ┌──────────────────────── Mac mini (HUB, always-on) ────────────────────────┐
                         │  cloudflared (LaunchAgent)  screenshotx.gyftalala.com → 127.0.0.1:8787     │
                         │  hub server (FastAPI, LaunchAgent)                                          │
                         │    • SQLite catalog (hash, origin, filename, ts, size)                       │
                         │    • blob store (content-addressed by sha256)                                │
                         │    • REST: upload / catalog / image / thumb / pair                            │
                         │    • WebSocket /events (live push to Mac clients)                             │
                         │    • FCM trigger (wake-ping to Android)                                       │
                         │    • watches local ScreenshotX folder (ingest mini captures)                 │
                         │    • writes received shots INTO the folder → existing Tauri app shows +       │
                         │      auto-copies to clipboard (no Tauri change needed)                        │
                         └───────────────▲───────────────────────────────▲──────────────────────────────┘
                                         │ HTTPS (Cloudflare tunnel)      │
                    WebSocket + REST     │                                │  FCM wake-ping + REST pull
                                         │                                │
         ┌───────────── MacBook (CLIENT) ┴──────────┐      ┌─────────────┴──── Android (CLIENT) ──────────┐
         │  sync agent (sidecar)                     │      │  Kotlin/Compose app                          │
         │   • watches local ScreenshotX folder      │      │   • FG service + MediaStore observer → upload │
         │   • uploads new shots to hub              │      │   • WorkManager upload queue (offline-safe)   │
         │   • WebSocket → writes received shots into │      │   • FCM receive → pull from hub               │
         │     folder → existing Tauri app shows +    │      │   • notification "Copy" action (OS limit)     │
         │     clipboards                            │      │   • gallery (hub catalog, thumbs on-demand)   │
         └───────────────────────────────────────────┘      └───────────────────────────────────────────────┘
```

**Source of truth = the hub's SQLite catalog + content-addressed blob store**, NOT a
fixed folder path and NOT iCloud. Each device has a *configured* local screenshot folder
(read from settings). Moving it (e.g. to `~/Downloads`) just updates the setting; the
agent watches the new path. **Dedup by SHA-256** makes any double-delivery (e.g. iCloud
still on + hub) idempotent.

**Self-hosting boundary:** screenshots never leave your devices/hub. Firebase is used for
**exactly one thing**: the FCM contentless wake-ping to Android. The image itself is always
pulled from your hub over the tunnel.

## 4. Components

### 4.1 Hub (Mac mini) — Python / FastAPI sidecar + LaunchAgent

Mirrors the proven Splashbook bridge pattern (FastAPI + uvicorn, run via LaunchAgent,
exposed by cloudflared).

- **Storage**
  - `store/` — content-addressed blobs: `store/<sha256>.png`.
  - `screenshotx.db` (SQLite):
    - `screenshots(hash PK, filename, origin_device, mime, size, created_at)`
    - `devices(id PK, name, platform, token, fcm_token NULL, paired_at, last_seen)`
    - `pairings(code PK, expires_at, used)`
  - Display folder mirror: also writes a copy into the configured `ScreenshotX` folder so
    the existing Tauri app's poll surfaces it (column + clipboard).
- **REST** (all require `Authorization: Bearer <device-token>` except pairing-claim):
  - `POST /api/upload` — multipart `{file, sha256, origin_device, created_at}` → store blob,
    insert catalog row (ignore if hash exists), mirror into folder, fan out.
  - `GET /api/catalog?since=<ts>` — JSON list `{hash, filename, origin, size, created_at}`.
  - `GET /api/image/{hash}` — full image (folder-jailed, validates hash).
  - `GET /api/thumb/{hash}?w=320` — Pillow thumbnail, cached on disk.
  - `GET /api/health`.
- **Pairing**
  - `POST /api/pair/new` (from an already-trusted device or local hub UI) → `{code, qr_png}`,
    short-lived (e.g. 5 min).
  - `POST /api/pair/claim {code, device_name, platform, fcm_token?}` → `{device_token}`.
- **WebSocket** `/events` — Mac clients connect (with token). On new screenshot the hub
  emits `{type: "new", hash}`. Client pulls if it doesn't have the hash.
- **FCM** — on new screenshot from another device, send a **data-only** FCM message
  `{type: "new", hash}` to each Android device's `fcm_token`. App pulls the image.
- **iCloud placeholders** — before serving/thumbnailing, if a `.icloud` stub is found,
  `brctl download` (or read to materialize) first.
- **Folder watch** — watchdog observer on the configured folder → ingest the mini's own
  new captures into the catalog + fan out. Loop-safe via hash (a shot the hub itself just
  wrote is already in the catalog → ignored).

### 4.2 Mac client (MacBook) — sync agent sidecar + LaunchAgent

A small Python (or Rust) agent, same shape as the hub minus the server role:
- Watches the configured `ScreenshotX` folder → hashes new shots → `POST /api/upload`.
- Maintains a WebSocket to the hub → on `new`, pulls `GET /api/image/{hash}` → writes into
  the local folder → the **existing Tauri app's 2.5s poll** detects it as "synced in" →
  shows in the column **and auto-copies to clipboard** (already implemented; no Tauri change).
- Pairing: paste the code shown by the hub, or "Approve" from the hub UI.

> The Mac mini also runs the existing Tauri app; its capture → folder → hub-watch path
> covers the mini's own screenshots symmetrically.

### 4.3 Android client — Kotlin + Jetpack Compose (super-minimal, lightweight)

**Hard requirements: minimal, lightweight, small APK, excellent UX.**

- **Size discipline**
  - R8 full-mode minification + resource shrinking; `isMinifyEnabled`, `isShrinkResources`.
  - Lean deps only: Compose (Material 3), **Coil** (small image loader), WorkManager,
    `firebase-messaging` (FCM), a **lightweight QR scanner** (ZXing-embedded or ML Kit
    barcode — pick the smaller; prefer a tiny ZXing wrapper to avoid pulling large ML Kit).
    No Retrofit bloat — use **Ktor client (CIO)** or `OkHttp` minimal. No Hilt (manual DI /
    a tiny service locator). Target APK comfortably small.
  - `minSdk` reasonable-modern (e.g. 26+), single-module, no unused Google libs.
- **Capture detection**: foreground `Service` + `ContentObserver`/`FileObserver` on the
  Screenshots dirs (`Pictures/Screenshots`, `DCIM/Screenshots`) → enqueue upload.
- **Upload**: WorkManager (constraints: connected; optional WiFi-only toggle), retry/backoff,
  survives offline → flushes when reachable. Sends `{file, sha256, origin_device}`.
- **Receive**: FCM data message → WorkManager pull `GET /api/image/{hash}` → save to
  app-private store (+ optional MediaStore "Save to phone") → post a **notification with a
  "Copy" action** (OS blocks background clipboard; tapping Copy brings a moment of foreground
  and sets the clipboard). Auto-copy-to-clipboard only when the app is in the foreground.
- **Gallery (UX-led)**: single primary screen — a unified grid of the **hub catalog** (all
  devices) with thumbnails streamed on-demand + Coil disk/memory cache; per-item source badge
  (mini / MacBook / phone). Pull-to-refresh. Tap → full view (pull full image from hub) with
  actions: Copy, Save to phone, Share. Clean empty/loading/error states. Material 3 dynamic
  color, dark mode, smooth transitions, minimal chrome.
- **Pairing**: scan QR shown by the hub → store `{baseUrl, device_token}` in
  EncryptedSharedPreferences. Register FCM token at claim time.
- **Permissions**: `READ_MEDIA_IMAGES` (33+), `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`(+
  `FOREGROUND_SERVICE_DATA_SYNC`), `CAMERA` (QR). Requested with clear rationale screens.
- **UX skill**: apply the `frontend-design` skill's principles (distinctive, production-grade,
  not generic) to the Compose gallery + pairing flow during implementation.

## 5. Pairing flow (no passwords)

1. Hub generates a short-lived **pairing code** (shown as QR + 6–8 char text) via local hub
   UI or an existing trusted device.
2. New device claims it:
   - **Phone** → scan QR (`baseUrl` + `code`).
   - **MacBook** → paste code (or click "Approve this device" in hub UI).
3. Hub issues a **per-device bearer token** (stored, revocable) and records the device
   (+ `fcm_token` for Android).
4. All subsequent requests use the device token. Revoke = delete the device row in hub UI.

Works for 2 or 3 devices; the phone is optional (Mac-only setup needs no camera).

## 6. Data flow (capture → everywhere)

1. Device A captures a screenshot (or observer detects one) → hash it.
2. A `POST /api/upload` to hub (or, on the mini, folder-watch ingest).
3. Hub: blob stored if new, catalog row inserted, mirrored into the configured folder.
4. Hub fans out: WebSocket `new` → Mac clients; FCM `new` → Android.
5. Each other device pulls the image by hash (skips if it already has the hash), writes it to
   its local folder/store.
6. Mac: existing Tauri poll shows it + auto-copies to clipboard. Android: notification with
   "Copy" action; gallery updates.

## 7. Security

- Tunnel is public → **every endpoint requires a per-device bearer token** (issued only via
  pairing; revocable). No token → 401.
- TLS terminates at Cloudflare edge → localhost. Server bound to `127.0.0.1`, folder-jailed,
  hash-validated paths (no traversal).
- Pairing codes are short-lived and single-use.
- FCM messages are **data-only and contentless** (`{type, hash}`) — no image bytes via Google.

## 8. Error handling / resilience

- Device offline / hub asleep → WorkManager (Android) and the Mac agent queue uploads, retry
  with backoff; nothing lost.
- Hub is always-on (Mac mini, prevent-sleep + wake-for-network); LaunchAgents auto-relaunch
  the hub server + cloudflared on crash/boot.
- Duplicate delivery (iCloud + hub) → idempotent via SHA-256.
- Android FG service killed → auto-restart (`START_STICKY` + WorkManager periodic safety net).

## 9. Testing

- **Hub**: pytest — upload (new vs dup hash), catalog `since`, image/thumb serving, auth 401,
  path-traversal rejection, pairing issue/claim/expiry, fan-out invoked.
- **Mac agent**: folder-watch → upload; WS receive → folder write; dedup.
- **Android**: unit (hash, upload queue, dedup, catalog merge); instrumented (observer →
  enqueue; FCM → pull → notify); manual E2E (screenshot on each device → appears + clipboard).

## 10. Prerequisites (user-side, one-time — cannot be automated)

1. **Cloudflare named tunnel** for `screenshotx.gyftalala.com` → `mini:8787`:
   `cloudflared tunnel login` (browser), `cloudflared tunnel create screenshotx`,
   DNS route, config + `cloudflared service install` (LaunchAgent). Runbook provided.
2. **Firebase project for FCM** (messaging only): create project, add Android app →
   `google-services.json`; download a **service-account key** for the hub to send pushes.
3. **Mac mini** designated as hub: Energy settings = prevent sleep + wake for network.
4. **Android toolchain** for building/installing the app (Android Studio / SDK + a device).

## 11. Phasing

1. **Phase 1 — Hub + tunnel + Mac client.** Mac↔Mac sync via the hub (independent of iCloud);
   clipboard via the existing poll. Deliverable: capture on mini ↔ MacBook syncs through the hub.
2. **Phase 2 — Android client.** Pairing, capture→upload, FCM receive, gallery, notify-to-copy.
3. **Phase 3 — Polish.** Delete propagation (tombstones), WiFi-only, retention, hub UI for
   device management.

## 12. Repos touched

- `screenshotx` (existing Tauri app) — **minimal/no change** in Phase 1–2 (clipboard + column
  already work via the folder poll). Hub UI for pairing may be added later (Phase 3).
- **new**: `screenshotx-hub` — hub server + Mac client agent (Python).
- **new**: `screenshotx-android` — Kotlin/Compose app.
