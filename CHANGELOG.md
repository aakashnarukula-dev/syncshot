# Changelog

All notable changes to SyncShot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Release workflow**: `release.yml` now builds what the previews shipped by hand: an Apple Silicon Mac ZIP, a release-signed Android APK, and `SHA256SUMS.txt`. `v*` tags publish a release and `preview-*` tags publish a prerelease. Intel Mac and DMG builds are no longer produced. Android signing reads the release key from repository secrets and fails rather than publishing an unsigned APK.

## [0.2.27] - 2026-09-28

Preview release: Mac 0.2.27 (Apple Silicon) and Android 2.0.13. Payments are a demo and never charge or grant paid access. See `docs/RELEASE_READINESS.md` for the full audit and the remaining hardware checks.

### Added

- **Google sign-in** on Mac and Android. The Mac signs in through the system browser. Existing phone accounts can link Google from account settings and keep their library.
- **Server-owned account access**: a three-day trial is created once per account by Firebase functions. Firestore and Storage rules enforce ownership and active access, and uploads are limited to supported image types up to 25 MB.
- **Shared white crop icon** across the Mac app, menu bar, Android launcher, and website (`assets/brand`, `scripts/generate-brand-icons.mjs`).
- **Storage permission preflight**: `firebase/scripts/check-storage-access.mjs` catches the missing Storage-to-Firestore IAM role that blocked uploads in production. It runs in CI.
- **Verify workflow** covering the desktop, website, Firebase backend and rules, and Android builds and tests.

### Changed

- The Mac app runs as a menu-bar-only accessory app with a state-aware tray menu that stays resident on Quit.
- The cloud screenshot rail loads faster, and Android sync delivers screenshots in real time.
- Android no longer asks for notification permission at launch.
- The editor preview window opens sized to the screenshot, with no letterboxing.

### Fixed

- Screen Recording permission is rechecked on every capture, so revoking and re-granting it works without restarting. Repeated blocked captures open the Screen Recording settings.
- Dragged screenshots survive upload completion, and the rail's collapse and monitor-follow timing no longer gets stuck.
- Android retries no longer create duplicate screenshots, and deleting one no longer leaves empty gray tiles.
- Android zoom, pan, double-tap reset, and gallery loading are more responsive.
- Window captures no longer gain black padding or rounded corners after trimming.

### Removed

- Phone (Truecaller) login UI and client code on Android and Mac. The `syncshot-server` backend is no longer used by the app.
- Demo license keys no longer unlock access, and the legacy callable pairing APIs are retired.

### Security

- OAuth callbacks require a random state value and reject duplicate or ambiguous parameters.
- Dependency security updates applied to the Mac frontend, website, and Firebase functions.

## [Earlier]

### Fixed

- **Background Border at 0px**: Fixed issue where background was still visible when Background Border was set to 0px. Now 0px means no background border at all - the screenshot edges touch the canvas edges directly.

### Added

- **Background Border slider**: New control in the Background Effects panel to adjust the padding around captured screenshots
  - Slider range: 0px (no border) to 200px (maximum border)
  - Smart default: Automatically calculates 5% of the average image dimension, capped at 200px
  - Real-time preview updates during slider drag
  - Full undo/redo support
  - Tooltip explaining the control's purpose
- **Frontend test framework**: Set up Vitest with React Testing Library
  - 19 tests for editor store padding functionality
  - Test coverage for transient/commit actions, undo/redo, and smart defaults
- **Rust unit tests**: Added tests for image processing utilities
  - 8 tests for CropRegion bounds clamping and validation
  - 5 tests for filename generation and directory utilities

### Changed

- Padding is now a configurable setting stored in EditorSettings (previously hardcoded to 100px)
