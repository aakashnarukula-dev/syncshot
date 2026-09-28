import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { accessState } from "./access";

initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });
const db = getFirestore();

/** Server-owned entitlement. Demo checkout can never write this collection. */
export const getAccess = onCall(async request => {
  if (!request.auth || request.auth.token.firebase?.sign_in_provider === "anonymous") {
    throw new HttpsError("unauthenticated", "Sign in to check your access.");
  }
  const ref = db.doc(`entitlements/${request.auth.uid}`);
  const data = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) return snap.data()!;
    const firstTrial = { lifetime: false, trialExpiresAt: Timestamp.fromMillis(Date.now() + 3 * 86_400_000) };
    tx.create(ref, firstTrial);
    return firstTrial;
  });
  return accessState(data.lifetime === true, data.trialExpiresAt?.toMillis?.() ?? 0, Date.now());
});

/** System-browser OAuth handoff, or authenticated linking of a legacy account. */
export const mintDesktopToken = onCall(async request => {
  if (!request.auth || request.auth.token.firebase?.sign_in_provider === "anonymous") {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  try { return { token: await getAuth().createCustomToken(request.auth.uid) }; }
  catch (error) {
    logger.error("mintDesktopToken failed", { uid: request.auth.uid, error: String(error) });
    throw new HttpsError("internal", "Could not complete sign-in. Please try again.");
  }
});

// Retire the old library-claim API explicitly. All supported clients use UID
// namespaces. In particular, revokeDevice previously accepted any target UID.
const retired = () => { throw new HttpsError("failed-precondition", "Update SyncShot and sign in with Google."); };
export const createLibrary = onCall(retired);
export const createPairingCode = onCall(retired);
export const redeemPairingCode = onCall(retired);
export const revokeDevice = onCall(retired);
