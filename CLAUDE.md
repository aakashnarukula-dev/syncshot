# CLAUDE.md — SyncShot

Open-source CleanShot X alternative for macOS. Capture → edit (backgrounds/effects/annotations) → export. Local + lightweight. Tauri 2 (Rust) + React 19.

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
