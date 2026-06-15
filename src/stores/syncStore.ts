/**
 * Sync store (zustand + immer) — the React-facing view of the Firebase sync
 * engine: auth/identity, the live screenshot/clipboard lists, and the
 * clipboard pause flag. The engine (lib/sync/engine.ts) writes here via the
 * setter actions; components read via the selector hooks.
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ClipboardDoc, ScreenshotDoc } from "@/lib/sync/types";

export type AuthState = "loading" | "signedOut" | "signedIn" | "error";

interface SyncState {
  authState: AuthState;
  authError: string | null;
  uid: string | null;
  email: string | null;
  deviceName: string;
  screenshots: ScreenshotDoc[];
  /** The live subscription window came back full — older shots can be paged in
   *  (drives the grid's load-more sentinel). */
  screenshotsHasMore: boolean;
  /**
   * Local CAPTURE path → its allocated Firestore doc id, recorded by the
   * publisher (see lib/sync/screenshots `publishScreenshot`/`shareScreenshotLink`).
   *
   * A RECEIVED shot is cached as `{docId}.png`, so its doc (and thus a cloud
   * thumb/full fallback URL) is recoverable straight from the filename. An
   * OWN-DEVICE capture is cached under a generated `shot_{ts}.png` name with no
   * embedded id, so without this map it had NO way to reach its cloud copy —
   * the moment its local file failed to load it fell straight to "Unavailable"
   * (and tap couldn't open it), while synced shots rendered fine. This map gives
   * own captures the SAME cloud fallback without writing a duplicate cache file.
   */
  localCaptureDocIds: Record<string, string>;
  clipboard: ClipboardDoc[];
  paused: boolean;
}

interface SyncActions {
  setAuth: (uid: string, email: string | null) => void;
  setSignedOut: () => void;
  setAuthError: (message: string) => void;
  setDeviceName: (name: string) => void;
  setScreenshots: (items: ScreenshotDoc[], hasMore: boolean) => void;
  /** Record the doc id a captured screenshot at `path` was published under, so
   *  the tile/open-handler can resolve a cloud fallback for own-device shots. */
  mapLocalCapture: (path: string, docId: string) => void;
  setClipboard: (items: ClipboardDoc[]) => void;
  setPaused: (paused: boolean) => void;
  reset: () => void;
}

export type SyncStore = SyncState & SyncActions;

const INITIAL_STATE: SyncState = {
  authState: "loading",
  authError: null,
  uid: null,
  email: null,
  deviceName: "Mac",
  screenshots: [],
  screenshotsHasMore: false,
  localCaptureDocIds: {},
  clipboard: [],
  paused: false,
};

export const useSyncStore = create<SyncStore>()(
  immer((set) => ({
    ...INITIAL_STATE,

    setAuth: (uid, email) =>
      set((state) => {
        state.uid = uid;
        state.email = email;
        state.authState = "signedIn";
        state.authError = null;
      }),

    setSignedOut: () =>
      set((state) => {
        state.uid = null;
        state.email = null;
        state.authState = "signedOut";
        state.screenshots = [];
        state.screenshotsHasMore = false;
        state.localCaptureDocIds = {};
        state.clipboard = [];
      }),

    setAuthError: (message) =>
      set((state) => {
        state.authState = "error";
        state.authError = message;
      }),

    setDeviceName: (name) =>
      set((state) => {
        state.deviceName = name;
      }),

    setScreenshots: (items, hasMore) =>
      set((state) => {
        state.screenshots = items;
        state.screenshotsHasMore = hasMore;
      }),

    mapLocalCapture: (path, docId) =>
      set((state) => {
        state.localCaptureDocIds[path] = docId;
      }),

    setClipboard: (items) =>
      set((state) => {
        state.clipboard = items;
      }),

    setPaused: (paused) =>
      set((state) => {
        state.paused = paused;
      }),

    reset: () =>
      set((state) => {
        Object.assign(state, INITIAL_STATE);
      }),
  })),
);

// The sync engine owns the live, GROWING Firestore subscription; it registers
// that subscription's page-grow callback here so the Library grid can pull in
// older screenshots (on near-bottom scroll) WITHOUT importing the engine or
// holding the subscription itself. Kept OUT of reactive state on purpose — a
// function-identity change must never trigger a re-render.
let loadMoreScreenshotsImpl: (() => void) | null = null;

/** Engine: register (or clear, on sign-out) the active subscription's grower. */
export function registerScreenshotLoadMore(fn: (() => void) | null): void {
  loadMoreScreenshotsImpl = fn;
}

/** Grid: request the next older page of screenshots. No-op until the engine has
 *  a live subscription, or once every shot is already loaded. */
export function loadMoreScreenshots(): void {
  loadMoreScreenshotsImpl?.();
}

// The publisher renames an own-capture cache file to carry its doc id
// (`shot_{ts}.png` -> `{docId}.png`) so the pill column's local file resolves
// its cloud doc by filename. The column's path list lives in App state, not the
// store, so App registers a swapper here and the publisher (lib/sync) calls it —
// keeping the column path in sync WITHOUT the save-dir poll mistaking the rename
// for a brand-new shot (which would re-surface the window + re-copy the
// clipboard). Kept OUT of reactive state: it's a one-shot side effect, not data.
let renameCapturePathImpl: ((from: string, to: string) => void) | null = null;

/** App: register (or clear, on unmount) the pill column's path swapper. */
export function registerRenameCapturePath(
  fn: ((from: string, to: string) => void) | null,
): void {
  renameCapturePathImpl = fn;
}

/** Publisher: swap a renamed capture's path in the live pill column. No-op until
 *  the column has registered its swapper. */
export function renameCapturePath(from: string, to: string): void {
  renameCapturePathImpl?.(from, to);
}

// Selector hooks (stable, minimal re-renders).
export const useAuthState = () => useSyncStore((s) => s.authState);
export const useAccountEmail = () => useSyncStore((s) => s.email);
export const useDeviceName = () => useSyncStore((s) => s.deviceName);
export const useScreenshots = () => useSyncStore((s) => s.screenshots);
export const useScreenshotsHasMore = () =>
  useSyncStore((s) => s.screenshotsHasMore);
export const useClipboardEntries = () => useSyncStore((s) => s.clipboard);
export const usePaused = () => useSyncStore((s) => s.paused);
export const useUid = () => useSyncStore((s) => s.uid);
