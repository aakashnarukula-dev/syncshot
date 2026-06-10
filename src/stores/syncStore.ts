/**
 * Sync store (zustand + immer) — the React-facing view of the Firebase sync
 * engine: auth/identity, the active library, the live screenshot/clipboard
 * lists, and the clipboard pause flag. The engine (lib/sync/engine.ts) writes
 * here via the setter actions; components read via the selector hooks.
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ClipboardDoc, ScreenshotDoc } from "@/lib/sync/types";

export type AuthState = "loading" | "anon" | "error";

interface SyncState {
  authState: AuthState;
  authError: string | null;
  uid: string | null;
  deviceName: string;
  libId: string | null;
  screenshots: ScreenshotDoc[];
  clipboard: ClipboardDoc[];
  paused: boolean;
}

interface SyncActions {
  setAuth: (uid: string) => void;
  setAuthError: (message: string) => void;
  setDeviceName: (name: string) => void;
  setLibId: (libId: string | null) => void;
  setScreenshots: (items: ScreenshotDoc[]) => void;
  setClipboard: (items: ClipboardDoc[]) => void;
  setPaused: (paused: boolean) => void;
  reset: () => void;
}

export type SyncStore = SyncState & SyncActions;

const INITIAL_STATE: SyncState = {
  authState: "loading",
  authError: null,
  uid: null,
  deviceName: "Mac",
  libId: null,
  screenshots: [],
  clipboard: [],
  paused: false,
};

export const useSyncStore = create<SyncStore>()(
  immer((set) => ({
    ...INITIAL_STATE,

    setAuth: (uid) =>
      set((state) => {
        state.uid = uid;
        state.authState = "anon";
        state.authError = null;
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

    setLibId: (libId) =>
      set((state) => {
        state.libId = libId;
      }),

    setScreenshots: (items) =>
      set((state) => {
        state.screenshots = items;
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

// Selector hooks (stable, minimal re-renders).
export const useAuthState = () => useSyncStore((s) => s.authState);
export const useLibId = () => useSyncStore((s) => s.libId);
export const useDeviceName = () => useSyncStore((s) => s.deviceName);
export const useScreenshots = () => useSyncStore((s) => s.screenshots);
export const useClipboardEntries = () => useSyncStore((s) => s.clipboard);
export const usePaused = () => useSyncStore((s) => s.paused);
export const useUid = () => useSyncStore((s) => s.uid);
