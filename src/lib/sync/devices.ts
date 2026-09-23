/**
 * Per-device presence and remote sign-out.
 *
 * Screenshots identify their source with an embedded DeviceRef, but the account
 * screen needs a durable `users/{uid}/devices/{deviceId}` document. Keeping it
 * here makes the desktop a first-class device alongside Android: it appears in
 * the profile list and can be revoked remotely.
 */

import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import type { DeviceRef } from "./types";

function deviceRef(device: DeviceRef) {
  return doc(db, "users", device.uid, "devices", device.deviceId);
}

/** Register or refresh this Mac without erasing an existing remote revocation.
 * The watcher must see a revocation written while the Mac was offline; resetting
 * it as part of a routine app launch would let a remotely removed device silently
 * rejoin before it can sign out. */
export async function registerDevice(device: DeviceRef): Promise<void> {
  await setDoc(
    deviceRef(device),
    {
      uid: device.uid,
      deviceId: device.deviceId,
      name: device.name,
      platform: device.platform,
      lastSeenAt: serverTimestamp(),
    },
    { merge: true },
  );
}

/** Refresh presence without touching display-name/platform fields. */
export async function touchDevice(device: DeviceRef): Promise<void> {
  await setDoc(
    deviceRef(device),
    { lastSeenAt: serverTimestamp() },
    { merge: true },
  );
}

/** Watch this device's profile document for a remote sign-out request. */
export function watchDeviceRevocation(
  device: DeviceRef,
  onRevoked: () => void,
  onError?: (error: Error) => void,
): () => void {
  return onSnapshot(
    deviceRef(device),
    (snap) => {
      if (snap.exists() && snap.data().revoked === true) onRevoked();
    },
    (error) => onError?.(error),
  );
}
