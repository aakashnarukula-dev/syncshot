import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, signInWithCustomToken, signOut, authStub } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  signInWithCustomToken: vi.fn(),
  signOut: vi.fn(),
  authStub: { currentUser: null as { isAnonymous: boolean } | null },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock("firebase/auth", () => ({
  getAuth: vi.fn(() => authStub),
  onAuthStateChanged: vi.fn(),
  signInWithCustomToken,
  signOut,
}));
vi.mock("firebase/firestore", () => ({
  initializeFirestore: vi.fn(() => ({})),
  persistentLocalCache: vi.fn(() => ({})),
  persistentMultipleTabManager: vi.fn(() => ({})),
}));
vi.mock("firebase/storage", () => ({ getStorage: vi.fn(() => ({})) }));

import { startBrowserSignIn } from "./firebase";

describe("startBrowserSignIn", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    signInWithCustomToken.mockReset();
    signOut.mockReset();
    authStub.currentUser = null;
  });

  it("opens the loopback listener and signs in with the returned token", async () => {
    invokeMock.mockResolvedValue("custom-token-123");
    signInWithCustomToken.mockResolvedValue({ user: { uid: "u1" } });

    const user = await startBrowserSignIn();

    expect(invokeMock).toHaveBeenCalledWith("browser_auth_listen");
    expect(signInWithCustomToken).toHaveBeenCalledWith(authStub, "custom-token-123");
    expect(user).toEqual({ uid: "u1" });
  });

  it("discards a leftover anonymous session before signing in", async () => {
    authStub.currentUser = { isAnonymous: true };
    invokeMock.mockResolvedValue("tok");
    signInWithCustomToken.mockResolvedValue({ user: { uid: "u2" } });

    await startBrowserSignIn();

    expect(signOut).toHaveBeenCalledWith(authStub);
    expect(signInWithCustomToken).toHaveBeenCalledWith(authStub, "tok");
  });

  it("surfaces a listener error and never reaches sign-in", async () => {
    invokeMock.mockRejectedValue(new Error("Sign-in timed out. Please try again."));

    await expect(startBrowserSignIn()).rejects.toThrow("timed out");
    expect(signInWithCustomToken).not.toHaveBeenCalled();
  });
});
