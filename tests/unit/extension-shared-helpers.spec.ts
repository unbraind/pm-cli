import { describe, expect, it } from "vitest";

import { normalizeManagedDirectoryName } from "../../src/cli/commands/extension/shared.js";

describe("normalizeManagedDirectoryName", () => {
  it("normalizes a manifest name into a safe directory slug", () => {
    expect(normalizeManagedDirectoryName("My Extension!")).toBe("my-extension");
    expect(normalizeManagedDirectoryName("  beads.todos  ")).toBe("beads.todos");
  });

  it("rejects names that resolve to traversal directory names", () => {
    // Manifest-controlled input must never resolve to the extensions root itself
    // or its parent.
    expect(() => normalizeManagedDirectoryName(".")).toThrowError(/"\."|"\.\."/);
    expect(() => normalizeManagedDirectoryName("..")).toThrowError(/"\."|"\.\."/);
  });

  it("rejects names that normalize to an empty slug", () => {
    expect(() => normalizeManagedDirectoryName("***")).toThrowError(/non-empty/);
  });
});
