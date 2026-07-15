import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  _testOnlyExtensionShared,
  normalizeManagedDirectoryName,
  parseExtensionManifest,
  validateExtensionDirectory,
} from "../../../src/cli/commands/extension/shared.js";

describe("normalizeManagedDirectoryName", () => {
  it("normalizes a manifest name into a safe directory slug", () => {
    expect(normalizeManagedDirectoryName("My Extension!")).toBe("my-extension");
    expect(normalizeManagedDirectoryName("  beads.todos  ")).toBe("beads.todos");
    expect(normalizeManagedDirectoryName(`${"-".repeat(10_000)}safe${"-".repeat(10_000)}`)).toBe("safe");
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

describe("extension shared validation helpers", () => {
  it("parses valid extension manifests and normalizes capabilities", () => {
    expect(
      parseExtensionManifest({
        name: "  sample-ext  ",
        version: " 1.0.0 ",
        entry: " index.js ",
        capabilities: ["Commands", "commands", " hooks "],
      }),
    ).toMatchObject({
      name: "sample-ext",
      version: "1.0.0",
      entry: "index.js",
      capabilities: ["commands", "hooks"],
    });
  });

  it("returns null for invalid manifest priority payloads", () => {
    expect(
      parseExtensionManifest({
        name: "sample-ext",
        version: "1.0.0",
        entry: "index.js",
        priority: "high",
      }),
    ).toBeNull();
  });

  it("formats manifest read errors for Error and non-Error throwables", () => {
    expect(_testOnlyExtensionShared.formatManifestReadError(new Error("boom"))).toBe("boom");
    expect(_testOnlyExtensionShared.formatManifestReadError("plain-failure")).toBe("plain-failure");
  });

  it("rejects extension entries that escape directory after symlink resolution", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-shared-symlink-"));
    try {
      const extensionRoot = path.join(tempRoot, "extension");
      await mkdir(extensionRoot, { recursive: true });
      const outsideFile = path.join(tempRoot, "outside.js");
      const symlinkEntry = path.join(extensionRoot, "index.js");
      await writeFile(
        path.join(extensionRoot, "manifest.json"),
        `${JSON.stringify({ name: "shared-helper-ext", version: "1.0.0", entry: "index.js" }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(outsideFile, "export default {};\n", "utf8");
      await symlink(outsideFile, symlinkEntry);

      await expect(validateExtensionDirectory(extensionRoot)).rejects.toThrow(
        "resolves outside extension directory after symlink resolution",
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

});
