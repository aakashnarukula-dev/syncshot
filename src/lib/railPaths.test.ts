import { describe, expect, it } from "vitest";
import { omitPendingPaths, replaceRailPath } from "./railPaths";

describe("screenshot rail paths", () => {
  it("replaces an edited screenshot in place", () => {
    expect(replaceRailPath(["newest", "original", "oldest"], "original", "crop"))
      .toEqual(["newest", "crop", "oldest"]);
  });

  it("deduplicates a replacement already present", () => {
    expect(replaceRailPath(["crop", "original", "oldest"], "original", "crop"))
      .toEqual(["crop", "oldest"]);
  });

  it("prepends a replacement if the prior path paged out", () => {
    expect(replaceRailPath(["newest", "oldest"], "original", "crop"))
      .toEqual(["crop", "newest", "oldest"]);
  });

  it("omits a file while deletion is pending", () => {
    expect(omitPendingPaths(["keep", "deleting"], new Set(["deleting"])))
      .toEqual(["keep"]);
  });
});
