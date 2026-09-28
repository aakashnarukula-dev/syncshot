import { describe, expect, it } from "vitest";
import { createShortcutGate } from "./shortcutGate";

describe("capture shortcut gate", () => {
  it("recovers after a permission dialog swallows key release", () => {
    let time = 0;
    const gate = createShortcutGate(() => time);
    expect(gate.accept("capture", "Pressed")).toBe(true);
    time = 100;
    expect(gate.accept("capture", "Pressed")).toBe(false);
    time = 1500;
    expect(gate.accept("capture", "Pressed")).toBe(true);
  });
  it("accepts a new press immediately after release", () => {
    const gate = createShortcutGate(() => 0);
    expect(gate.accept("capture", "Pressed")).toBe(true);
    expect(gate.accept("capture", "Released")).toBe(false);
    expect(gate.accept("capture", "Pressed")).toBe(true);
  });
  it("tracks separate shortcuts and clears state on reconfiguration", () => {
    const gate = createShortcutGate(() => 0);
    expect(gate.accept("region", "Pressed")).toBe(true);
    expect(gate.accept("window", "Pressed")).toBe(true);
    gate.clear();
    expect(gate.accept("region", "Pressed")).toBe(true);
  });
});
