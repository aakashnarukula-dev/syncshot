/**
 * Local persistence of sync prefs (libId, device name, paused flag) via the
 * Tauri store. The Firebase SDK already persists the anonymous uid + claims;
 * we only need the libId to rebuild collection paths on cold start.
 */

import { Store } from "@tauri-apps/plugin-store";

const FILE = "settings.json";
const KEY_LIB_ID = "syncLibId";
const KEY_DEVICE_NAME = "syncDeviceName";
const KEY_PAUSED = "syncPaused";

async function store(): Promise<Store> {
  return Store.load(FILE, { defaults: {}, autoSave: true });
}

export interface SyncPrefs {
  libId: string | null;
  deviceName: string | null;
  paused: boolean;
}

export async function loadSyncPrefs(): Promise<SyncPrefs> {
  try {
    const s = await store();
    const libId = (await s.get<string>(KEY_LIB_ID)) ?? null;
    const deviceName = (await s.get<string>(KEY_DEVICE_NAME)) ?? null;
    const paused = (await s.get<boolean>(KEY_PAUSED)) ?? false;
    return { libId, deviceName, paused };
  } catch {
    return { libId: null, deviceName: null, paused: false };
  }
}

export async function saveLibId(libId: string): Promise<void> {
  try {
    const s = await store();
    await s.set(KEY_LIB_ID, libId);
    await s.save();
  } catch {
    /* best-effort */
  }
}

export async function saveDeviceName(name: string): Promise<void> {
  try {
    const s = await store();
    await s.set(KEY_DEVICE_NAME, name);
    await s.save();
  } catch {
    /* best-effort */
  }
}

export async function savePaused(paused: boolean): Promise<void> {
  try {
    const s = await store();
    await s.set(KEY_PAUSED, paused);
    await s.save();
  } catch {
    /* best-effort */
  }
}
