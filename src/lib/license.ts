export type LicenseStatus =
  | { state: "trial"; expiresAt: number; daysLeft: number }
  | { state: "expired" }
  | { state: "unavailable" }
  | { state: "licensed"; key: string };

/** Access belongs to the signed-in account, never a local demo key or clock. */
export async function loadLicenseStatus(): Promise<LicenseStatus> {
  try {
    const [{ auth, app }, { getFunctions, httpsCallable }] = await Promise.all([
      import("./sync/firebase"), import("firebase/functions"),
    ]);
    await auth.authStateReady();
    const uid = auth.currentUser?.uid;
    if (!uid || auth.currentUser?.isAnonymous) return { state: "unavailable" };
    const { data } = await httpsCallable<void, { state: string; expiresAt?: number; daysLeft?: number }>(getFunctions(app, "us-central1"), "getAccess")();
    if (auth.currentUser?.uid !== uid) return { state: "unavailable" };
    if (data.state === "licensed") return { state: "licensed", key: uid };
    if (data.state === "trial" && Number.isFinite(data.expiresAt) && Number.isFinite(data.daysLeft)) {
      return { state: "trial", expiresAt: data.expiresAt!, daysLeft: data.daysLeft! };
    }
    return data.state === "expired" ? { state: "expired" } : { state: "unavailable" };
  } catch { return { state: "unavailable" }; }
}

export function formatTrialLabel(status: LicenseStatus): string | null {
  return status.state === "trial" ? `Trial: ${status.daysLeft}d left` : null;
}
