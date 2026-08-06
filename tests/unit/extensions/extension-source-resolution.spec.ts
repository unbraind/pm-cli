import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findInstalledNpmPackageCandidate } from "../../../src/sdk/extension/install-sources.js";
import { resolveExtensionInstallSourceIdentity } from "../../../src/sdk/extension/source-resolution.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) =>
      rm(tempRoot, { recursive: true, force: true }),
    ),
  );
});

describe("extension install source identity", () => {
  it("reports nameless bundled packages and versionless npm competitors", async () => {
    const tempRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "pm-source-identity-")),
    );
    tempRoots.push(tempRoot);
    const previousPackageRoot = process.env[PM_PACKAGE_ROOT_ENV];
    const previousCwd = process.cwd();
    process.env[PM_PACKAGE_ROOT_ENV] = tempRoot;
    try {
      const packageRoot = path.join(tempRoot, "packages", "pm-nameless");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ version: "1.0.0", pm: { aliases: ["nameless"] } }),
        "utf8",
      );
      await expect(
        resolveExtensionInstallSourceIdentity("nameless", undefined, undefined),
      ).resolves.toMatchObject({
        bundledAliasName: "nameless",
        bundledPackageName: null,
        sourceResolution: {
          selected: { kind: "builtin", input: "nameless" },
          ambiguous: false,
        },
      });

      const npmCandidate = path.join(tempRoot, "node_modules", "nameless");
      await mkdir(npmCandidate, { recursive: true });
      await writeFile(
        path.join(npmCandidate, "package.json"),
        JSON.stringify({ name: "nameless" }),
        "utf8",
      );
      process.chdir(tempRoot);
      const resolution = await resolveExtensionInstallSourceIdentity(
        "nameless",
        undefined,
        undefined,
      );
      expect(resolution.sourceResolution.ambiguous).toBe(true);
      expect(resolution.sourceResolution.candidates[1]).toEqual({
        kind: "npm",
        input: "npm:nameless",
        package: "nameless",
        directory: npmCandidate,
        command: "pm install npm:nameless",
      });

      await expect(
        resolveExtensionInstallSourceIdentity(
          "owner/repository",
          "owner/repository",
          "main",
        ),
      ).resolves.toMatchObject({
        bundledAliasName: null,
        sourceResolution: {
          selected: { kind: "github" },
          ambiguous: false,
          candidates: [],
        },
      });
      await expect(findInstalledNpmPackageCandidate("", tempRoot)).resolves.toBeNull();
      await writeFile(
        path.join(npmCandidate, "package.json"),
        JSON.stringify({ name: "different-package" }),
        "utf8",
      );
      await expect(
        findInstalledNpmPackageCandidate("nameless", tempRoot),
      ).resolves.toBeNull();
    } finally {
      process.chdir(previousCwd);
      if (previousPackageRoot === undefined) {
        delete process.env[PM_PACKAGE_ROOT_ENV];
      } else {
        process.env[PM_PACKAGE_ROOT_ENV] = previousPackageRoot;
      }
    }
  });
});
