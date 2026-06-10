# ScreenshotX Android (Phase 2) Implementation Plan

> **For agentic workers:** built against the Phase-1 hub. Checkbox steps for tracking.

**Goal:** A super-minimal, lightweight Android app that auto-uploads new phone screenshots to the hub and shows a unified gallery of all devices' screenshots, with notify-to-copy on receive.

**Architecture:** Single-module Kotlin/Compose app. One foreground `SyncService` does both screenshot detection (ContentObserver) and live receive (OkHttp WebSocket to the hub `/events`). Uploads go through WorkManager (offline-safe). Pairing is manual (paste hub URL + 6-char code) to keep the APK tiny (no camera/QR lib in v1). **FCM is deferred** — the WebSocket receive works today with zero Firebase; FCM is layered on later for battery-friendly wake.

**Tech stack (minimal):** Kotlin 2.0, Jetpack Compose (Material 3), OkHttp (REST + WebSocket), Coil (images), WorkManager, org.json (zero-dep JSON), plain SharedPreferences. compileSdk 34, minSdk 26. R8 + resource shrinking on release.

**Repo:** `/Users/aakashnarukula/Developer/screenshotx-android`

---

## File map

```
settings.gradle.kts, build.gradle.kts, gradle.properties, gradle/libs.versions.toml
app/build.gradle.kts
app/src/main/AndroidManifest.xml
app/src/main/java/com/aakash/ssx/
  SsxApp.kt                # Application
  MainActivity.kt          # Compose host; routes Pair vs Gallery
  data/Hashing.kt          # sha256
  data/Prefs.kt            # baseUrl + device_token (SharedPreferences)
  data/Models.kt           # CatalogItem
  data/HubClient.kt        # OkHttp: claim, catalog, uploadFile, imageUrl, openEvents (WS)
  sync/SyncService.kt      # FG service: ContentObserver(screenshots) + WS receive
  sync/UploadWorker.kt     # WorkManager upload (retry/backoff, network constraint)
  sync/Notifications.kt    # channels + notify-to-copy + FG notification
  sync/CopyReceiver.kt     # BroadcastReceiver for the notification "Copy" action
  ui/PairScreen.kt         # url + code entry -> claim
  ui/GalleryScreen.kt      # Coil grid of hub catalog + actions
  ui/theme/Theme.kt
app/src/main/res/...       # strings, themes, launcher icon, xml/file_paths
app/src/test/java/com/aakash/ssx/HashingTest.kt, ModelsTest.kt
```

## Tasks

- [ ] **T1 Scaffold** Gradle project (wrapper 8.11.1, AGP 8.7.3, Kotlin 2.0.21, Compose BOM), `local.properties` sdk.dir, version catalog, `assembleDebug` smoke (empty app compiles).
- [ ] **T2 data/Hashing + Models + Prefs** + unit tests (sha256 vector; CatalogItem parse).
- [ ] **T3 HubClient** (OkHttp): `claim(url,code,name)→token`, `catalog(since)→List<CatalogItem>`, `uploadFile(file,hash,origin)`, `imageUrl(hash)`, `openEvents(onNew)` WebSocket. Bearer auth header.
- [ ] **T4 Notifications + CopyReceiver**: FG-service channel, "received" channel; `notifyReceived(hash)` posts a notification with a Copy action → `CopyReceiver` loads the bitmap into the clipboard (foreground moment) + saves.
- [ ] **T5 UploadWorker** (WorkManager): input = file uri/path → hash → `HubClient.uploadFile`; CONNECTED constraint, exponential backoff.
- [ ] **T6 SyncService** (foreground, `dataSync`): registers a ContentObserver on `MediaStore` Screenshots → enqueues UploadWorker for new images; opens the hub WebSocket → on `new`, downloads + `notifyReceived`. START_STICKY.
- [ ] **T7 UI PairScreen**: paste base URL + 6-char code → `HubClient.claim` → store in Prefs → start SyncService → go to Gallery. Clean Material 3, validation, loading/error states.
- [ ] **T8 UI GalleryScreen**: pulls `catalog()`, Coil grid of `thumbUrl`, source badge, pull-to-refresh, tap → full image (Copy / Save / Share). Empty + loading + error states. Permission rationale prompts (READ_MEDIA_IMAGES, POST_NOTIFICATIONS).
- [ ] **T9 Manifest + permissions + theme + icon**; wire MainActivity routing (paired? Gallery : Pair).
- [ ] **T10 Build** `assembleDebug` → APK; run unit tests; boot emulator (android-34) → install → screenshot Pair + Gallery to verify UX. Commit.

## Deferred (own follow-ups)
- FCM wake-ping (needs Firebase project: `google-services.json` + hub service-account key) — swaps in alongside the WS receiver for battery efficiency.
- QR-scan pairing (CameraX + ZXing) — convenience over manual code.
- Cross-device delete, WiFi-only toggle, retention.
