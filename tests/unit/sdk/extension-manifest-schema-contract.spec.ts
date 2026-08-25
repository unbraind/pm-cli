import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkExtensionManifestCompatibility,
  inspectExtensionManifestSchema,
  lintExtensionManifestSchema,
  type ExtensionManifestCompatibilityManifest,
} from "../../../src/sdk/compose.js";
import { formatExtensionManifestSchemaWarnings } from "../../../src/core/extensions/manifest-schema.js";
import { runHealth } from "../../../src/sdk/governance/health.js";
import { inspectExtensionAuthorManifest } from "../../../src/sdk/extension/author-manifest.js";
import { _testOnly as mcpServerTestOnly } from "../../../src/mcp/server.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

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
    expect(inspectExtensionManifestSchema(manifest)).toEqual({
      unknownKeys: ["compatibility"],
      missingVersionBounds: true,
    });
    expect(lintExtensionManifestSchema(manifest)).toMatchObject({
      ok: false,
      findings: [
        {
          code: "manifest_unknown_key",
          path: "compatibility",
          suggested_key: "pm_min_version",
        },
        {
          code: "no_version_bounds_declared",
          path: "$",
          suggested_key: "pm_min_version",
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
          ä_policy: true,
          å_policy: true,
          pm_min_version: "2026.8.1",
        },
      ),
    ).toEqual([
      "extension_manifest_unknown_key:global:bounded-extension:key=a_policy",
      "extension_manifest_unknown_key:global:bounded-extension:key=z_policy",
      "extension_manifest_unknown_key:global:bounded-extension:key=ä_policy",
      "extension_manifest_unknown_key:global:bounded-extension:key=å_policy",
    ]);

    const recognizedUnboundedManifest = {
      name: "unbounded-extension",
      version: "1.0.0",
      entry: "index.js",
      priority: 100,
      capabilities: [],
    };
    expect(
      checkExtensionManifestCompatibility(recognizedUnboundedManifest, {
        pmVersion: "2026.8.16",
      }).findings,
    ).toEqual([
      expect.objectContaining({
        code: "no_version_bounds_declared",
        path: "$",
      }),
    ]);
    expect(
      formatExtensionManifestSchemaWarnings(
        "project",
        recognizedUnboundedManifest,
        recognizedUnboundedManifest,
      ),
    ).toEqual([
      "extension_manifest_no_version_bounds:project:unbounded-extension:suggested=pm_min_version",
    ]);
  });
});

describe("extension author manifest diagnostics", () => {
  it("reports absent, malformed, and unreadable author manifests", async () => {
    await withTempPmPath(async (context) => {
      const absentRoot = path.join(context.tempRoot, "absent");
      expect(await inspectExtensionAuthorManifest(absentRoot)).toMatchObject({
        present: false,
        parse_status: "absent",
      });

      await writeFile(
        path.join(context.tempRoot, "manifest.json"),
        "{",
        "utf8",
      );
      expect(
        await inspectExtensionAuthorManifest(context.tempRoot),
      ).toMatchObject({
        present: true,
        parse_status: "invalid_json",
        warnings: ["extension_author_manifest_invalid_json:manifest.json"],
      });

      await writeFile(
        path.join(context.tempRoot, "manifest.json"),
        "[]",
        "utf8",
      );
      expect(
        await inspectExtensionAuthorManifest(context.tempRoot),
      ).toMatchObject({
        parse_status: "invalid_shape",
        warnings: ["extension_author_manifest_invalid_shape:manifest.json"],
      });

      await writeFile(
        path.join(context.tempRoot, "manifest.json"),
        "{}",
        "utf8",
      );
      expect(
        await inspectExtensionAuthorManifest(context.tempRoot),
      ).toMatchObject({
        parse_status: "valid",
        schema_findings: [{ code: "no_version_bounds_declared" }],
      });

      await writeFile(
        path.join(context.tempRoot, "manifest.json"),
        JSON.stringify({
          name: "arbitrary-key-workspace",
          pm_min_version: "2026.8.25",
          unexpected_policy: true,
        }),
        "utf8",
      );
      expect(
        await inspectExtensionAuthorManifest(context.tempRoot),
      ).toMatchObject({
        warnings: [
          "extension_manifest_unknown_key:author:arbitrary-key-workspace:key=unexpected_policy",
        ],
      });

      const unreadableRoot = path.join(context.tempRoot, "unreadable");
      await mkdir(path.join(unreadableRoot, "manifest.json"), {
        recursive: true,
      });
      await expect(
        inspectExtensionAuthorManifest(unreadableRoot),
      ).rejects.toMatchObject({ code: expect.any(String) });
    });
  });

  it("keeps SDK, CLI, MCP, package, and extension diagnostics in parity", async () => {
    await withTempPmPath(async (context) => {
      await writeFile(
        path.join(context.tempRoot, "manifest.json"),
        JSON.stringify({
          name: "author-workspace",
          version: "1.0.0",
          entry: "./index.ts",
          capabilities: [],
          compatibility: { pm: "2026.8.25" },
        }),
        "utf8",
      );

      const sdk = await runHealth({ path: context.pmPath });
      const sdkExtensions = sdk.checks.find(
        (check) => check.name === "extensions",
      );
      expect(sdkExtensions?.details.author_manifest).toMatchObject({
        present: true,
        path: path.join(context.tempRoot, "manifest.json"),
        package_metadata_location: "package.json#pm",
        schema_findings: [
          { code: "manifest_unknown_key", path: "compatibility" },
          { code: "no_version_bounds_declared", path: "$" },
        ],
      });

      const cli = context.runCli(
        ["health", "--full", "--strict-exit", "--json"],
        { expectJson: true },
      );
      expect(cli.code).toBe(1);
      const cliExtensions = (
        cli.json as {
          checks: Array<{ name: string; details: Record<string, unknown> }>;
        }
      ).checks.find((check) => check.name === "extensions");
      expect(cliExtensions?.details.author_manifest).toEqual(
        sdkExtensions?.details.author_manifest,
      );

      const mcp = (await mcpServerTestOnly.runAction({
        action: "health",
        path: context.pmPath,
        options: { full: true },
      })) as {
        checks: Array<{ name: string; details: Record<string, unknown> }>;
      };
      expect(
        mcp.checks.find((check) => check.name === "extensions")?.details
          .author_manifest,
      ).toEqual(sdkExtensions?.details.author_manifest);

      const packageDoctor = context.runCli(
        [
          "package",
          "doctor",
          "--project",
          "--detail",
          "summary",
          "--strict-exit",
          "--json",
        ],
        { expectJson: true },
      );
      const extensionDoctor = context.runCli(
        [
          "extension",
          "--doctor",
          "--project",
          "--detail",
          "summary",
          "--strict-exit",
          "--json",
        ],
        { expectJson: true },
      );
      expect(packageDoctor.code).toBe(1);
      expect(extensionDoctor.code).toBe(1);
      expect(
        (packageDoctor.json as { details: Record<string, unknown> }).details
          .author_manifest,
      ).toEqual(
        (extensionDoctor.json as { details: Record<string, unknown> }).details
          .author_manifest,
      );
      expect(
        (packageDoctor.json as { details: Record<string, unknown> }).details
          .author_manifest,
      ).toEqual(sdkExtensions?.details.author_manifest);
    });
  });
});
