import { beforeEach, describe, expect, it, vi } from "vitest";
const { auth, check } = vi.hoisted(() => ({ auth: { currentUser: { uid: "owner", isAnonymous: false } as { uid: string; isAnonymous: boolean } | null, authStateReady: vi.fn().mockResolvedValue(undefined) }, check: vi.fn() }));
vi.mock("./sync/firebase", () => ({ auth, app: {} }));
vi.mock("firebase/functions", () => ({ getFunctions: vi.fn(), httpsCallable: vi.fn(() => check) }));
import { loadLicenseStatus } from "./license";
beforeEach(() => { auth.currentUser = { uid: "owner", isAnonymous: false }; check.mockReset(); });
describe("server account access", () => {
 it("never grants access on network failure", async () => { check.mockRejectedValue(Error("offline")); expect(await loadLicenseStatus()).toEqual({ state: "unavailable" }); });
 it("never trusts malformed server trial data", async () => { check.mockResolvedValue({ data: { state: "trial", expiresAt: "tomorrow" } }); expect(await loadLicenseStatus()).toEqual({ state: "unavailable" }); });
 it("uses the verified current account as the license identity", async () => { check.mockResolvedValue({ data: { state: "licensed" } }); expect(await loadLicenseStatus()).toEqual({ state: "licensed", key: "owner" }); });
 it("rejects a response if the account changed during the request", async () => { check.mockImplementation(async () => { auth.currentUser = { uid: "other", isAnonymous: false }; return { data: { state: "licensed" } }; }); expect(await loadLicenseStatus()).toEqual({ state: "unavailable" }); });
 it("does not query access for signed-out users", async () => { auth.currentUser = null; expect(await loadLicenseStatus()).toEqual({ state: "unavailable" }); expect(check).not.toHaveBeenCalled(); });
});
