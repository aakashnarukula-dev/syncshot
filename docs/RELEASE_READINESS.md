# SyncShot readiness audit — 2026-09-28

This release hardens the Mac rail, replaces new phone logins with Google on Mac and Android, and adds a responsive charcoal product website. Checkout is deliberately a Razorpay preview. It never takes payment or grants paid access. This is not a claim that every hardware/OS combination has been verified.

## Fixed

- Upload completion could remove the local screenshot while a native drag still needed it. Drag preparation now creates an independent temporary hard link/copy; cloud fallback handles an upload racing preparation.
- Lost WebKit mouse-leave events could permanently stop the rail's collapse timer. The deadline now retries, checks native cursor geometry, invalidates stale asynchronous checks, and recovers a lost drag-end signal from the mouse-button state.
- A previous collapse animation could finish during a new screenshot reveal. New open signals cancel that collapse. Escape also dismisses text and empty rails.
- Monitor-following is restricted to the rail and rechecks capture/mode before resizing. Bounded paint waits prevent hidden-window animation frames from stalling transitions.
- Leaving the account-access screen restores the rail instead of leaving a blank window. Sign-in has a visible retry/error screen instead of silently swallowing failures.
- Browser sign-in now always uses the system browser. OAuth callbacks require a random state, reject duplicate parameters, tolerate unrelated invalid callbacks, and fail closed if randomness is unavailable.
- Existing phone accounts can connect Google from account settings without changing their UID or library. Already linked accounts cannot silently switch through that button. Credential collisions produce an error rather than merging libraries.
- Old phone/Truecaller login UI and Android client code are removed. The existing server outside this repository is not changed. Firebase phone provider remains enabled for legacy migration; real SMS delivery was not tested. Missing Android certificate registrations were found and fixed, but this alone does not establish whether SMS worked for real numbers.
- Demo license keys no longer unlock access. Trial/lifetime state belongs to the Firebase account and is written only by trusted backend code. Firestore and Storage enforce ownership and active access; uploads are bounded to supported image types and 25 MB.
- Legacy callable pairing APIs are retired. In particular, the old revoke-device endpoint accepted an arbitrary UID.
- Dependency security updates applied to the Mac frontend, website, and Firebase functions. Type checking is enforced in website builds. Desktop TypeScript no longer resolves `firebase/functions` to the local backend directory after a backend build.

## Access and rollout

`getAccess` creates a three-day trial once per authenticated non-anonymous UID. Reinstallation and changing the client clock do not reset that record. Demo checkout never changes it. Expired accounts cannot create, read, or update synced content; owners may still delete their data. Local cached/downloaded copies are not remotely erased.

Updated clients must call `getAccess` before starting sync. Older clients do not initialize entitlements and must be updated when the new rules are enabled. New accounts cannot buy lifetime access until real Razorpay order verification and signed webhook handling are added. Do not invite paying customers during this demo stage.

Phone users should connect Google while still signed into their existing account, before signing out. Independently signing into Google first can create a different account. There is no automatic account merge.

## Deployment

- Website: https://syncshot-seven.vercel.app
- Published preview: https://github.com/aakashnarukula-dev/syncshot/releases/tag/preview-2026.09.28 — Apple Silicon Mac ZIP, Android 2.0.11 APK, and SHA-256 checksums. Website links directly to both downloads. Uploaded checksums and unauthenticated download responses were verified. Intel binaries are not included.
- Browser login: https://syncshot-v2.web.app/auth.html (launch from the Mac app; requires callback state)
- Firebase project: `syncshot-v2`; callable functions: `us-central1`, Node.js 22.
- Vercel direct deployment works. Automatic GitHub linking was rejected by Vercel because its GitHub integration lacks repository access. Grant access through Vercel/GitHub before relying on push-triggered website deployment; set the project root to `syncshot-landing`.
- Cloud Functions runtime now has the Firestore role required by account-access transactions. Native smoke testing caught and resolved the missing IAM permission. Token signing remains scoped to the runtime service account itself.
- Website origin is added to Firebase authorized domains. Debug and release Android signing fingerprints are registered.

## Verification

- Native Mac smoke checks: existing library loads, the rail opens, Escape dismisses it, and it collapses after the pointer leaves. Screen Recording permission was granted and the final build restarted. Remote key events did not trigger global capture shortcuts, so fresh capture/immediate-drag verification is awaiting a physical keyboard test; it is not recorded as passing. Three displays are attached, but repeated cross-monitor capture testing remains pending.
- Desktop: 149 frontend regression tests; 49 Rust tests, including native drag-file survival and ambiguous OAuth callback rejection.
- Live browser-to-loopback custom-token handoff and server-owned trial creation passed with a real Google account.
- Backend: 4 access-state boundary tests; 4 Firestore/Storage emulator tests covering account isolation, expired access, self-granted licenses, and upload validation.
- Android: 6 debug unit tests and successful debug/release builds. Signed APK signature verification passed. Native Credential Manager login still needs an interactive Google-account test on the signed APK.
- Website: charcoal/ivory/brass design with responsive product illustrations; live Google sign-in succeeded with a real account; production build with TypeScript validation; desktop/mobile layout inspection; workflow tabs; INR/USD simulated checkout; real payment endpoint returns 503.
- Production dependency audits report zero known vulnerabilities for the three JavaScript projects at verification time. This does not cover every native dependency or guarantee future advisory status.

## Required hardware and launch checks

1. Install the new Mac build. On two monitors with different scaling, repeatedly capture, immediately drag into Finder/browser/chat, cancel capture, move the cursor across monitors, and leave the rail idle. Check screen permission denial/recovery and wake from sleep.
2. Install the signed Android build. Verify Google login with a real account, legacy phone-account linking, cancellation, sign-out, and a second account. Test Android screenshot permissions, foreground service restart, text sharing, and both sync directions on physical devices.
3. Verify Mac system-browser login returns to the native app and both devices use the same UID. Test interrupted network, retry, and trial expiry without losing local screenshots.
4. Activate real Razorpay only after domain approval. Verify server-owned amount/currency, authenticated order ownership, payment signatures, idempotent signed webhooks, refunds/revocations, and replay protection before granting lifetime access.
5. Finalize commercial policies, storage/retention limits, support contact, monitoring, and backups before broad paid launch. Current privacy/terms pages explicitly describe the preview.

## Local Android release signing

Release key is stored outside Git at `~/.config/syncshot-signing/release.jks`; its local Gradle properties are `android/keystore.properties` (ignored). Back up both securely. Do not regenerate the key for updates, publish it, or commit it. A prior debug-signed install cannot be updated using this new release certificate without migration/reinstallation; do not uninstall an existing app until its data and account are secured.

## Android duplicate/empty-preview repair — 2.0.11

Failed uploads previously wrote a fresh random optimistic Room ID on each retry. Those `local` rows were exempt from reconciliation forever. Deleting one duplicate removed the shared cached image but only one row, leaving empty gray tiles. Concurrent publish attempts also used a non-atomic query-before-create check; thumbnail-only documents incorrectly counted as finished uploads.

- Publish IDs now derive from image SHA-256, with one serialized publisher per account/image. Legacy partial documents resume under their existing ID; complete copies win. Retried cloud writes preserve creation time and cannot downgrade a completed document.
- Gallery deduplication happens in SQLite before pagination; complete originals win over orphan previews. A non-destructive Room migration adds a hash index.
- Deleting an image removes all matching cloud/local copies. Account-scoped deletion markers block deferred automatic uploads from resurrecting it. Explicit manual re-upload can restore it.
- Startup and pull-to-refresh discard only local preview rows with no remote paths and no remaining cached image. Cloud originals and phone gallery files are preserved.
- Upload workers bind to the originating account; cancellation does not schedule another upload. Observer registration is serialized.
- Verification: 13 Android unit tests and 9 SQLite regression tests passed; debug and signed release builds passed, and APK signature verification passed. Coverage includes four failed attempts/process restarts, four concurrent notifications, unfinished-upload recovery, deletion/retry ordering, gray-placeholder cleanup, gallery pagination, and deleting duplicate rows.
- The connected phone's installed APK has a different signing certificate from both local debug and release keys. Updating that installation without deleting app data requires its original signing key. The app has not been uninstalled.

## Production upload outage and recovery — September 28, 2026

The phone's installed 2.0.10 build reported Firebase Storage HTTP 403 before screenshots reached the cloud, so the Mac had nothing new to receive. Storage rules now consult Firestore entitlements, but the Storage service agent lacked `roles/firebaserules.firestoreServiceAgent`. Firebase CLI 15.23.0 skips this IAM setup in non-interactive deployment, and emulators do not detect the missing production role.

The missing role was granted only to `service-424325660516@gcp-sa-firebasestorage.iam.gserviceaccount.com` in `syncshot-v2`, preserving existing IAM bindings. Ownership, subscription/trial checks, and upload limits were not relaxed. Both existing account entitlements were still active.

Before future Storage-rule rollouts, authenticate gcloud and run `node firebase/scripts/check-storage-access.mjs syncshot-v2`. It is read-only and fails if the cross-service permission is missing; its regression tests run in CI. Also verify a real authenticated image upload after deployment; emulator success alone is insufficient.

The current verified Mac bundle was installed at `/Applications/SyncShot.app` and launched. The previous bundle is retained under `src-tauri/target/release/previous-installation/SyncShot.app`; app data was preserved. Updating the phone remains blocked by the older APK's signing certificate, not by this cloud permission repair.

After the IAM repair and Mac installation, the user took a new Android screenshot and confirmed that it appeared in the Mac column. The live IAM preflight and eight backend/deployment-guard tests passed.

## Screen Recording permission recovery — Mac 0.2.22

The capture gate cached successful permission in a process-wide `GRANTED` flag. Removing SyncShot from System Settings while it was running therefore skipped both the permission check and request until the process restarted.

Every region, window, and full-screen capture now checks macOS permission afresh and requests access when missing. Capture failures also recheck permission, covering removal while the selection picker is open; permission errors are no longer silently classified as cancellation. Full-screen capture now preserves stderr for the same recovery path. No throwaway screenshot, permission database mutation, or forced restart is used. Help text only asks for a restart if macOS requests it.

Verification: 149 frontend tests and 54 Rust tests passed, including five permission recovery cases (grant/revoke/regrant in one process, new grant, removal during capture, stale preflight with authorization error, and cancellation without a permission prompt). Physical shortcut testing after removing permission from a running updated app remains required; unit tests do not establish whether macOS will display a new consent dialog in every permission state.

Mac 0.2.22 release build and ad-hoc signature validation passed. Installed and launched `/Applications/SyncShot.app`; installed executable matches the build. Prior app retained under `src-tauri/target/release/previous-installation-0.2.22/20260928-160950/SyncShot.app`. System Settings currently has no SyncShot entry. Remote key injection did not activate the global shortcut; user has been asked to perform the grant/capture/remove/retry sequence on the physical keyboard.

## Screen Recording follow-up — Mac 0.2.23

The user reported that 0.2.22 still did not show a consent pop-up. Removing the cached grant alone did not verify or fix the whole shortcut-to-permission flow.

- Request permission on the native main thread after activating SyncShot, before hiding its window or waiting for cloud account checks.
- If macOS returns false without a system dialog, show a full-size access recovery window, with Screen Recording settings, retry, cancel, and an explicit restart action. Explain how to add SyncShot when it is missing from the list. Do not claim an app can force macOS to repeat consent in every state.
- Acquire the capture guard before asynchronous checks. Bound shortcut key-down suppression so a missing release cannot disable capture for the process lifetime. Serialize shortcut registration and cleanup to prevent preferences loading from racing the default registrations.
- Keep permission failures out of the collapsed pill, where the toast was not usable. No permission database resets, automatic grants, or automatic app restarts.
- Add a bounded, private local capture-stage log in the app cache. It records native press/release and permission outcomes, without key values, account details, file paths, or image content.

Verification: 154 frontend tests and 54 Rust tests passed, plus the release build and ad-hoc signature check. Installed and launched 0.2.23; installed executable matches the build. Prior app retained under `src-tauri/target/release/previous-installation-0.2.23/20260928-161542/SyncShot.app`. Remote key injection produced no native shortcut events, so the user was asked for one physical Command-Shift-2 press to inspect the live path.
