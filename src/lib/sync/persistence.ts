/**
 * Local persistence of sync prefs (device identity, device name, paused
 * flag) via the Tauri store. The Firebase SDK persists the
 * signed-in session itself; deviceId is the per-install identity used to tell
 * this device's docs apart now that every device shares one auth uid.
 */

import { Store } from "@tauri-apps/plugin-store";

const FILE = "settings.json";
const KEY_DEVICE_ID = "syncDeviceId";
const KEY_DEVICE_NAME = "syncDeviceName";
const KEY_PAUSED = "syncPaused";

async function store(): Promise<Store> {
  return Store.load(FILE, { defaults: {}, autoSave: true });
}

export interface SyncPrefs {
  deviceId: string | null;
  deviceName: string | null;
  paused: boolean;
}

export async function loadSyncPrefs(): Promise<SyncPrefs> {
  try {
    const s = await store();
    const deviceId = (await s.get<string>(KEY_DEVICE_ID)) ?? null;
    const deviceName = (await s.get<string>(KEY_DEVICE_NAME)) ?? null;
    const paused = (await s.get<boolean>(KEY_PAUSED)) ?? false;
    return { deviceId, deviceName, paused };
  } catch {
    return { deviceId: null, deviceName: null, paused: false };
  }
}

export async function saveDeviceId(deviceId: string): Promise<void> {
  try {
    const s = await store();
    await s.set(KEY_DEVICE_ID, deviceId);
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
