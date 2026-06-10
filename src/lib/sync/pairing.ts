/**
 * Pairing — thin typed wrappers over the callable Cloud Functions plus QR
 * generation. After `createLibrary` / `redeemPairingCode` we FORCE an ID-token
 * refresh so the new `libId` custom claim loads before listeners start.
 */

import { httpsCallable } from "firebase/functions";
import * as QRCode from "qrcode";
import { auth, functions, refreshIdToken } from "./firebase";

interface CreateLibraryResult {
  libId: string;
}
interface CreatePairingCodeResult {
  code: string;
  expiresAt: number;
}
interface RedeemResult {
  libId: string;
}

const createLibraryFn = httpsCallable<
  { deviceName: string; platform: "mac" },
  CreateLibraryResult
>(functions, "createLibrary");

const createPairingCodeFn = httpsCallable<
  Record<string, never>,
  CreatePairingCodeResult
>(functions, "createPairingCode");

const redeemPairingCodeFn = httpsCallable<
  { code: string; deviceName: string; platform: "mac" },
  RedeemResult
>(functions, "redeemPairingCode");

/**
 * First-ever device: create the library, become owner+member, get the `libId`
 * claim, then refresh the token so the claim is live for listeners.
 */
export async function createLibrary(deviceName: string): Promise<string> {
  const res = await createLibraryFn({ deviceName, platform: "mac" });
  await refreshIdToken();
  return res.data.libId;
}

/** Existing member mints a 6-digit code (valid ~2 min) for a new device. */
export async function createPairingCode(): Promise<CreatePairingCodeResult> {
  const res = await createPairingCodeFn({});
  return res.data;
}

/**
 * New device joins by redeeming a 6-digit code. On success the caller gains
 * the `libId` claim; we refresh the token so listeners can read the library.
 */
export async function redeemPairingCode(
  code: string,
  deviceName: string,
): Promise<string> {
  const res = await redeemPairingCodeFn({
    code: code.trim(),
    deviceName,
    platform: "mac",
  });
  await refreshIdToken();
  return res.data.libId;
}

/** Whether the current device has an authenticated identity yet. */
export function hasIdentity(): boolean {
  return auth.currentUser != null;
}

/**
 * Render a 6-digit pairing code as a QR data-URL (payload = the code string,
 * so an Android camera can scan it). Returns a `data:image/png;base64,...` URL.
 */
export async function codeToQrDataUrl(code: string): Promise<string> {
  return QRCode.toDataURL(code, {
    margin: 1,
    width: 220,
    errorCorrectionLevel: "M",
  });
}
