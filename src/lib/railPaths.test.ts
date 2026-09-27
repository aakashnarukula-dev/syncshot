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
  it("replaces the cloud alias when an editor still names the original capture", () => {
    const identity = (path: string) => path === "local-original" || path.startsWith("cloud-original") ? "original-id" : path;
    expect(replaceRailPath(["newest", "cloud-original?v=1", "oldest"], "local-original", "crop", identity))
      .toEqual(["newest", "crop", "oldest"]);
  });

  it("keeps the original hidden when its upload acquires a cloud identity later", () => {
    const mapping: Record<string, string> = {};
    const identity = (path: string) => mapping[path] ?? path;
    const pending = new Set(["local-original"]);
    expect(omitPendingPaths(["local-original", "crop"], pending, identity)).toEqual(["crop"]);
    mapping["local-original"] = "original-id";
    mapping["cloud-original?v=1"] = "original-id";
    expect(omitPendingPaths(["cloud-original?v=1", "crop"], pending, identity)).toEqual(["crop"]);
  });

});
