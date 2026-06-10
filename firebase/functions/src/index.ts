/**
 * ScreenshotX / ClipboardX realtime backend — Cloud Functions (v2, callable).
 *
 * Authorization model: every device is a Firebase Auth user whose custom claim
 * `libId` names the one library it belongs to. Firestore + Storage rules gate on
 * that claim. These functions are the *only* writers of `pairingCodes/**` and the
 * only minters of the `libId` claim.
 *
 * Data model (contract shared with the Mac + Android clients):
 *   libraries/{libId}                       { owner, name, createdAt }
 *   libraries/{libId}/members/{uid}         { uid, deviceName, platform, role, joinedAt }
 *   libraries/{libId}/screenshots/{id}      { ..., createdAt }   (written by clients)
 *   libraries/{libId}/clipboard/{id}        { ..., createdAt }   (written by clients)
 *   pairingCodes/{code}                     { libId, createdBy, expiresAt, used }
 */

import { randomInt } from "crypto";

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  DocumentData,
  FieldValue,
  getFirestore,
  Timestamp,
} from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import {
  CallableRequest,
  HttpsError,
  onCall,
} from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

initializeApp();
setGlobalOptions({ region: "us-central1" });

const db = getFirestore();
const auth = getAuth();

const PAIRING_TTL_MS = 120_000; // 2 minutes
const PAIRING_CODE_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function authedUid(request: CallableRequest): string {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  return request.auth.uid;
}

/** The caller's library, taken from the `libId` custom claim. */
function callerLibId(request: CallableRequest): string {
  const libId = request.auth?.token?.libId as string | undefined;
  if (!libId) {
    throw new HttpsError(
      "permission-denied",
      "Caller is not a member of any library."
    );
  }
  return libId;
}

function codeExpired(data: DocumentData): boolean {
  const expiresAt = data.expiresAt as Timestamp | undefined;
  return !expiresAt || expiresAt.toMillis() < Date.now();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpsError("invalid-argument", `\`${field}\` is required.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// createLibrary — bootstrap the first device into a brand-new library.
// ---------------------------------------------------------------------------

export const createLibrary = onCall(async (request) => {
  const uid = authedUid(request);
  const deviceName = requireString(request.data?.deviceName, "deviceName");
  const platform = requireString(request.data?.platform, "platform");

  const libRef = db.collection("libraries").doc();
  const libId = libRef.id;
  const now = FieldValue.serverTimestamp();

  const batch = db.batch();
  batch.set(libRef, {
    owner: uid,
    name: `${deviceName}'s Library`,
    createdAt: now,
  });
  batch.set(libRef.collection("members").doc(uid), {
    uid,
    deviceName,
    platform,
    role: "owner",
    joinedAt: now,
  });
  await batch.commit();

  await auth.setCustomUserClaims(uid, { libId });

  logger.info("createLibrary", { uid, libId });
  return { libId };
});

// ---------------------------------------------------------------------------
// createPairingCode — an existing member mints a short-lived 6-digit code.
// ---------------------------------------------------------------------------

export const createPairingCode = onCall(async (request) => {
  const uid = authedUid(request);
  const libId = callerLibId(request);

  const expiresAt = Timestamp.fromMillis(Date.now() + PAIRING_TTL_MS);

  let code = "";
  for (let attempt = 0; attempt < PAIRING_CODE_ATTEMPTS; attempt++) {
    const candidate = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const snap = await db.collection("pairingCodes").doc(candidate).get();
    const free =
      !snap.exists ||
      snap.get("used") === true ||
      codeExpired(snap.data() as DocumentData);
    if (free) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    throw new HttpsError(
      "resource-exhausted",
      "Could not allocate a free pairing code, please retry."
    );
  }

  await db.collection("pairingCodes").doc(code).set({
    libId,
    createdBy: uid,
    expiresAt,
    used: false,
    createdAt: FieldValue.serverTimestamp(),
  });

  logger.info("createPairingCode", { uid, libId, code });
  return { code, expiresAt: expiresAt.toMillis() };
});

// ---------------------------------------------------------------------------
// redeemPairingCode — a new device joins the code's library.
// ---------------------------------------------------------------------------

export const redeemPairingCode = onCall(async (request) => {
  const uid = authedUid(request);
  const code = requireString(request.data?.code, "code");
  const deviceName = requireString(request.data?.deviceName, "deviceName");
  const platform = requireString(request.data?.platform, "platform");

  const codeRef = db.collection("pairingCodes").doc(code);

  const libId = await db.runTransaction(async (tx) => {
    const snap = await tx.get(codeRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Pairing code not found.");
    }
    const data = snap.data() as DocumentData;
    if (data.used === true) {
      throw new HttpsError("failed-precondition", "Pairing code already used.");
    }
    if (codeExpired(data)) {
      throw new HttpsError("failed-precondition", "Pairing code expired.");
    }

    const targetLibId = data.libId as string;
    const memberRef = db
      .collection("libraries")
      .doc(targetLibId)
      .collection("members")
      .doc(uid);

    tx.set(memberRef, {
      uid,
      deviceName,
      platform,
      role: "member",
      joinedAt: FieldValue.serverTimestamp(),
    });
    tx.update(codeRef, {
      used: true,
      usedBy: uid,
      usedAt: FieldValue.serverTimestamp(),
    });

    return targetLibId;
  });

  await auth.setCustomUserClaims(uid, { libId });

  logger.info("redeemPairingCode", { uid, libId, code });
  return { libId };
});

// ---------------------------------------------------------------------------
// revokeDevice — a member removes another device from the library.
// ---------------------------------------------------------------------------

export const revokeDevice = onCall(async (request) => {
  authedUid(request);
  const libId = callerLibId(request);
  const targetUid = requireString(request.data?.uid, "uid");

  await db
    .collection("libraries")
    .doc(libId)
    .collection("members")
    .doc(targetUid)
    .delete();

  // Drop the device's library claim so its tokens no longer authorize access.
  await auth.setCustomUserClaims(targetUid, null);

  logger.info("revokeDevice", { libId, targetUid });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// cleanupExpiredCodes — scheduled GC of stale pairing codes.
// ---------------------------------------------------------------------------

export const cleanupExpiredCodes = onSchedule("every 60 minutes", async () => {
  const cutoff = Timestamp.fromMillis(Date.now());
  const expired = await db
    .collection("pairingCodes")
    .where("expiresAt", "<", cutoff)
    .limit(450)
    .get();

  if (expired.empty) {
    return;
  }

  const batch = db.batch();
  expired.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  logger.info("cleanupExpiredCodes", { removed: expired.size });
});
