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
  clipboard: ClipboardDoc[];
  paused: boolean;
}

interface SyncActions {
  setAuth: (uid: string, email: string | null) => void;
  setSignedOut: () => void;
  setAuthError: (message: string) => void;
  setDeviceName: (name: string) => void;
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
  email: null,
  deviceName: "Mac",
  screenshots: [],
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
export const useAccountEmail = () => useSyncStore((s) => s.email);
export const useDeviceName = () => useSyncStore((s) => s.deviceName);
export const useScreenshots = () => useSyncStore((s) => s.screenshots);
export const useClipboardEntries = () => useSyncStore((s) => s.clipboard);
export const usePaused = () => useSyncStore((s) => s.paused);
export const useUid = () => useSyncStore((s) => s.uid);
