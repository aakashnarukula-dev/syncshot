import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ScreenRecordingPermission } from "./ScreenRecordingPermission";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it("keeps permission recovery visible when the OS consent dialog is absent", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  const onRetry = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn().mockResolvedValue(undefined);
  render(<ScreenRecordingPermission onRetry={onRetry} onClose={onClose} />);
  expect(screen.getByRole("heading", { name: "Allow screenshot access" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open Screen Recording settings" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_screen_recording_settings"));
  await waitFor(() => expect(screen.getByRole("button", { name: /try capture/ })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: /try capture/ }));
  await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled());
});

it("shows settings errors instead of hiding or dismissing recovery", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("open failed"));
  render(<ScreenRecordingPermission onRetry={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Open Screen Recording settings" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Please try again");
  expect(screen.getByRole("heading")).toBeVisible();
});
