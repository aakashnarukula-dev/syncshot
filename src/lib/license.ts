import { invoke } from "@tauri-apps/api/core";

const TRIAL_DAYS = 3;
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

// Dummy keys for pre-launch testing. Replace with server-issued keys later.
const DUMMY_KEYS = new Set([
  "SCRNX-LIFETIME-DEV",
  "SCRNX-DEMO-0001",
  "SCRNX-DEMO-0002",
  "SCRNX-DEMO-0003",
]);

export type LicenseStatus =
  | { state: "trial"; expiresAt: number; daysLeft: number }
  | { state: "expired" }
  | { state: "licensed"; key: string };

const KC_TRIAL = "trial_started_at";
const KC_LICENSE = "license_key";

async function kcGet(key: string): Promise<string | null> {
  try {
    return (await invoke<string | null>("keychain_get", { key })) ?? null;
  } catch {
    return null;
  }
}

async function kcSet(key: string, value: string): Promise<void> {
  try {
    await invoke("keychain_set", { key, value });
  } catch (e) {
    console.error("keychain_set failed:", e);
  }
}

async function kcDelete(key: string): Promise<void> {
  try {
    await invoke("keychain_delete", { key });
  } catch {}
}

export async function loadLicenseStatus(): Promise<LicenseStatus> {
  const key = await kcGet(KC_LICENSE);
  if (key) return { state: "licensed", key };

  let startedAt = await kcGet(KC_TRIAL);
  if (!startedAt) {
    startedAt = new Date().toISOString();
    await kcSet(KC_TRIAL, startedAt);
  }
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) {
    const now = new Date().toISOString();
    await kcSet(KC_TRIAL, now);
    return { state: "trial", expiresAt: Date.now() + TRIAL_MS, daysLeft: TRIAL_DAYS };
  }
  const expiresAt = started + TRIAL_MS;
  if (Date.now() >= expiresAt) {
    return { state: "expired" };
  }
  const daysLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
  return { state: "trial", expiresAt, daysLeft };
}

export async function activateLicense(rawKey: string): Promise<
  { ok: true; key: string } | { ok: false; error: string }
> {
  const key = rawKey.trim().toUpperCase();
  if (!key) return { ok: false, error: "Please enter a license key" };
  // TODO: replace with real server call. For now, dummy-key list.
  if (!DUMMY_KEYS.has(key)) {
    return { ok: false, error: "Invalid license key" };
  }
  await kcSet(KC_LICENSE, key);
  return { ok: true, key };
}

export async function deactivateLicense(): Promise<void> {
  await kcDelete(KC_LICENSE);
}

export function formatTrialLabel(status: LicenseStatus): string | null {
  if (status.state !== "trial") return null;
  const ms = status.expiresAt - Date.now();
  if (ms <= 0) return "Trial expired";
  const totalHours = Math.ceil(ms / (60 * 60 * 1000));
  if (totalHours <= 24) return `Trial: ${totalHours}h left`;
  const days = Math.ceil(totalHours / 24);
  return `Trial: ${days}d left`;
}
