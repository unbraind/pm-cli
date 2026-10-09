import { describe, expect, it } from "vitest";
import { assertWorkspaceCompatibilityItem, selectWorkspaceCompatibilityVersions } from "../../../../scripts/release/workspace-compatibility.mjs";

describe("workspace compatibility contract", () => {
  const policy = { schema_version: 1, previous_stable_releases: 2, item_format_version: 1 };
  it("selects the preceding numeric stable releases and refuses incomplete or weakened windows", () => {
    expect(selectWorkspaceCompatibilityVersions(["2025.12.31", "2026.9.9", "2026.10.7", "2026.10.8", "2026.10.8", "2026.10.9", "2026.10.8-1"], "2026.10.9", policy)).toEqual(["2026.10.7", "2026.10.8"]);
    expect(() => selectWorkspaceCompatibilityVersions([], "malformed", policy)).toThrow("stable calendar version");
    expect(() => selectWorkspaceCompatibilityVersions([], "2026.10.9", { ...policy, schema_version: 2 })).toThrow("Unknown compatibility policy");
    expect(() => selectWorkspaceCompatibilityVersions(["2026.10.8"], "2026.10.9", policy)).toThrow("Two published prior releases");
    expect(() => selectWorkspaceCompatibilityVersions([], "2026.10.9", { ...policy, previous_stable_releases: 1 })).toThrow("two prior stable releases");
    expect(() => selectWorkspaceCompatibilityVersions([], "2026.10.9", { ...policy, item_format_version: 2 })).toThrow("storage baseline");
  });
  it("detects nested metadata loss despite successful process exits", () => {
    const expected = { extension_payload: { nested: [false, null, { x: "y,z" }] }, extension_count: 0 };
    expect(() => assertWorkspaceCompatibilityItem({ ...expected, title: "Changed" }, expected)).not.toThrow();
    expect(() => assertWorkspaceCompatibilityItem({ extension_payload: {}, extension_count: 0 }, expected)).toThrow("Compatibility lost extension_payload");
    expect(() => assertWorkspaceCompatibilityItem({ extension_payload: expected.extension_payload }, expected)).toThrow("Compatibility lost extension_count");
  });
});
