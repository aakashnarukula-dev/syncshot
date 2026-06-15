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
  clipboard: ClipboardDoc[];
  paused: boolean;
}

interface SyncActions {
  setAuth: (uid: string, email: string | null) => void;
  setSignedOut: () => void;
  setAuthError: (message: string) => void;
  setDeviceName: (name: string) => void;
  setScreenshots: (items: ScreenshotDoc[], hasMore: boolean) => void;
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
