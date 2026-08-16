import { describe, expect, it } from "vitest";
import {
  checkExtensionManifestCompatibility,
  type ExtensionManifestCompatibilityManifest,
} from "../../../src/sdk/compose.js";
import { formatExtensionManifestSchemaWarnings } from "../../../src/core/extensions/manifest-schema.js";

describe("extension manifest schema compatibility", () => {
  it("reports ignored compatibility spellings and missing canonical bounds", () => {
    const manifest = {
      name: "context-extension",
      version: "1.0.0",
      entry: "index.js",
      priority: 100,
      capabilities: [],
      compatibility: { pm: "2026.8.15" },
    } as ExtensionManifestCompatibilityManifest;

    expect(
      checkExtensionManifestCompatibility(manifest, {
        pmVersion: "2026.8.16",
      }),
    ).toMatchObject({
      compatible: true,
      findings: [
        {
          code: "manifest_unknown_key",
          severity: "warning",
          path: "compatibility",
          suggested_key: "pm_min_version",
        },
        {
          code: "no_version_bounds_declared",
          severity: "warning",
          path: "$",
        },
      ],
    });
    expect(
      formatExtensionManifestSchemaWarnings(
        "project",
        {
          name: "context-extension",
          version: "1.0.0",
          entry: "index.js",
          priority: 100,
          capabilities: [],
        },
        manifest,
      ),
    ).toEqual([
      "extension_manifest_unknown_key:project:context-extension:key=compatibility:suggested=pm_min_version",
      "extension_manifest_no_version_bounds:project:context-extension:suggested=pm_min_version",
    ]);

    const arbitrary = checkExtensionManifestCompatibility(
      { unexpected_policy: true } as ExtensionManifestCompatibilityManifest,
      { pmVersion: "2026.8.16" },
    ).findings;
    expect(arbitrary).toEqual([
      expect.objectContaining({
        code: "manifest_unknown_key",
        path: "unexpected_policy",
      }),
      expect.objectContaining({ code: "no_version_bounds_declared" }),
    ]);
    expect(arbitrary[0]).not.toHaveProperty("suggested_key");
    expect(
      formatExtensionManifestSchemaWarnings(
        "global",
        {
          name: "bounded-extension",
          version: "1.0.0",
          entry: "index.js",
          priority: 100,
          capabilities: [],
        },
        {
          z_policy: true,
          a_policy: true,
          pm_min_version: "2026.8.1",
        },
      ),
    ).toEqual([
      "extension_manifest_unknown_key:global:bounded-extension:key=a_policy",
      "extension_manifest_unknown_key:global:bounded-extension:key=z_policy",
    ]);
  });
});
