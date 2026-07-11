# CLAUDE.md — SyncShot

Open-source CleanShot X alternative for macOS. Capture → edit (backgrounds/effects/annotations) → export. Local + lightweight. Tauri 2 (Rust) + React 19.

## Installing on a fresh Mac — "clone and install the app" (READ FIRST)

When the user says **"clone this repo and install the app"**, they mean: produce a
**double-clickable `SyncShot.app` in `/Applications`** — NOT just `pnpm install`.
`pnpm install` / `pnpm dev` only run the browser frontend; they do NOT create an app in
`/Applications`. This is a Tauri desktop app, so it needs a native Rust build to bundle.

### Environment gotchas (verified 2026-07)
- **Clone with `gh`** — private repo; `git clone https://…` fails (no stored creds / no SSH
  keys). Use `gh repo clone aakashnarukula-dev/syncshot`.
- **Node 22 LTS for ALL pnpm/build work.** The system `node` may be too new (v26+) and
  break the toolchain. Prepend `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`
  (`brew install node@22`).
- **pnpm via corepack** — not on PATH by default: `corepack prepare pnpm@10.28.0 --activate`.
- **pnpm blocks build scripts** (esbuild, @firebase/util, protobufjs, tesseract.js).
  Approve them — esbuild's native binary is load-bearing (`pnpm approve-builds`, or accept
  when prompted).
- **Rust is REQUIRED for the desktop build** and is often missing on a fresh Mac. Install:
  `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y` then
  `source "$HOME/.cargo/env"`. `pnpm dev` (browser-only) works without Rust; the `.app` does NOT.

### Full install (copy-paste)
```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd ~/developer
gh repo clone aakashnarukula-dev/syncshot
cd syncshot
corepack prepare pnpm@10.28.0 --activate
corepack pnpm install
command -v cargo >/dev/null || { curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y; }
source "$HOME/.cargo/env"

# --- build the /Applications app (native release build, ~2 min) ---
corepack pnpm tauri build --bundles app   # → src-tauri/target/release/bundle/macos/SyncShot.app (Tauri ad-hoc signs it)
cp -R "src-tauri/target/release/bundle/macos/SyncShot.app" /Applications/

# --- make the icon render + register the app ---
touch "/Applications/SyncShot.app"
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "/Applications/SyncShot.app"
killall Finder Dock 2>/dev/null || true
```
`--bundles app` skips the slower `.dmg` and just builds the `.app`. Tauri already ad-hoc
signs it (`signingIdentity "-"`). First launch: right-click → **Open** (Gatekeeper, once).
No secrets needed — Firebase uses committed public web-app defaults in
`src/lib/sync/firebaseConfig.ts`. If the `/Applications` icon is blank, it's a Finder icon
cache — the `lsregister` + `killall Finder Dock` above fixes it.

## Repo layout (monorepo, multiple projects)

| Path | What | Stack |
|------|------|-------|
| `src/` | Desktop app frontend | React 19, Vite 7, TS, Tailwind v4, Zustand, Radix, motion, tesseract.js (OCR) |
| `src-tauri/` | Desktop app backend | Rust, Tauri 2 (macOS-focused) |
| `syncshot-landing/` | Marketing site | Next.js (separate pnpm workspace, own lockfile) |
| `hub/` | Multi-device sync hub (FastAPI) | **empty placeholder in this checkout** — see note below |
| `android/` | Android sync client (Kotlin/Compose) | **empty placeholder in this checkout** |
| `docs/superpowers/` | Specs + plans (specs/, plans/) | markdown |
| `scripts/` | release-notes helpers | bash |

App identity: `com.aakashnarukula.syncshot`, productName `SyncShot`. Version lives in `package.json` AND `src-tauri/Cargo.toml` + `tauri.conf.json` — keep in sync.

## Commands (pnpm, root)

- `pnpm dev` — Vite frontend only (browser, no native shell)
- `pnpm tauri dev` — full desktop app (runs `pnpm dev` as beforeDevCommand)
- `pnpm build` — `tsc && vite build` (frontend → `dist/`)
- `pnpm tauri build` — package the macOS app
- `pnpm test` — vitest run (frontend unit tests)
- `pnpm test:watch` / `pnpm test:coverage`
- `pnpm test:rust` — `cd src-tauri && cargo test`
- `pnpm lint:ci` — `tsc --noEmit` (typecheck, the CI gate)

Landing site (`cd syncshot-landing`): `pnpm dev` / `pnpm build` / `pnpm lint` (eslint). Its own workspace — install/run from inside that dir.

Package manager is **pnpm** (10.28). Root `pnpm-lock.yaml`; landing has its own.

## Verify a change before shipping

1. `pnpm lint:ci` (typecheck) — must pass.
2. `pnpm test` — frontend tests (vitest, jsdom). Store logic tested e.g. `src/stores/editorStore.test.ts`.
3. If Rust touched: `pnpm test:rust`.
4. Landing touched: `cd syncshot-landing && pnpm build`.
No special cache-bust step.

## Frontend conventions

- State: **Zustand** stores in `src/stores/` (with `immer`). `editorStore.ts` is the core.
- UI: Radix primitives + Tailwind v4 (no config file — `@tailwindcss/vite`). `cn` util (clsx + tailwind-merge) in `src/lib/utils.ts`.
- Components: `src/components/` (`editor/`, `preferences/`, `ui/`). OCR in `src/lib/ocr.ts` (tesseract.js). Canvas/annotation helpers in `src/lib/`.
- Tauri IPC: frontend calls Rust commands via `@tauri-apps/api`. Rust commands in `src-tauri/src/commands.rs`; modules: `screenshot.rs`, `clipboard.rs`, `image.rs`, `license.rs`.
- `AGENTS.md` = UI Skills constraints (Tailwind defaults first, `motion/react`, accessible primitives, no gratuitous animation/gradients, `h-dvh` not `h-screen`). Follow it for any UI work.

## Multi-device sync (hub/ + android/)

These dirs are **empty placeholders in this fleet checkout** — the actual FastAPI hub + Kotlin/Compose Android client live in the canonical repo at `/Users/aakashnarukula/Developer/screenshotx` (Phase 1 + 2 built & verified end-to-end). Architecture: hub-and-spoke, Mac mini hub (FastAPI + SQLite + content-addressed blobs + WebSocket fan-out) exposed via Cloudflare named tunnel; MacBook + Android clients pair via code/QR (revocable per-device tokens), dedup by SHA-256; Android push = FCM wake-ping only (Firebase project `screenshot-x`). If a goal targets sync work, confirm whether code should land here or in the canonical repo before spawning workers.

## Hard rules

- macOS-first: Rust has `cfg(target_os = "macos")` paths (objc2) and single-instance guard for desktop. Don't break the platform cfgs.
- Keep version strings in sync across `package.json` / `Cargo.toml` / `tauri.conf.json`.
- Tailwind v4: utilities only, no `tailwind.config.js`.
- Release flow: `.github/workflows/release.yml` + `scripts/*-release-notes.sh`; `CHANGELOG.md` is maintained.
