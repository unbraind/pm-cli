import fs, { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findInstalledNpmPackageCandidate } from "../../../src/sdk/extension/install-sources.js";
import { resolveExtensionInstallSourceIdentity } from "../../../src/sdk/extension/source-resolution.js";
import type { ManagedExtensionRecord } from "../../../src/sdk/extension/managed-state.js";

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
  it("reuses recorded npm identity for a bare managed name while preserving explicit local sources", async () => {
    const entry: ManagedExtensionRecord = {
      name: "managed-reinstall-fixture", directory: "managed-reinstall-fixture", scope: "project",
      manifest_version: "1.0.0", manifest_entry: "index.mjs", capabilities: [], installed_at: "2026-10-04", updated_at: "2026-10-04",
      source: { kind: "npm", input: "npm:@scope/reinstall@1.0.0", location: "@scope/reinstall@1.0.0", package: "@scope/reinstall", version: "1.0.0" },
    };
    for (const input of [entry.name, entry.source.package!]) {
      expect(await resolveExtensionInstallSourceIdentity(input, undefined, undefined, [entry])).toMatchObject({
        installSource: { kind: "npm", input: "npm:@scope/reinstall", spec: "@scope/reinstall" },
        sourceResolution: { requested: input, selected: { kind: "npm", input: "npm:@scope/reinstall" } },
      });
    }
    const collision = "managed-identity-precedence-fixture";
    const byName: ManagedExtensionRecord = {
      ...entry, name: collision, directory: "stored-name-fixture",
      source: { ...entry.source, input: "npm:@scope/name@1.0.0", location: "@scope/name@1.0.0", package: "@scope/name" },
    };
    const byDirectory: ManagedExtensionRecord = {
      ...entry, name: "b-managed-directory-fixture", directory: collision,
      source: { ...entry.source, input: "npm:@scope/directory@1.0.0", location: "@scope/directory@1.0.0", package: "@scope/directory" },
    };
    const byPackage: ManagedExtensionRecord = {
      ...entry, name: "a-managed-package-fixture", directory: "stored-package-fixture",
      source: { ...entry.source, input: `npm:${collision}@1.0.0`, location: `${collision}@1.0.0`, package: collision },
    };
    const nonNpm: ManagedExtensionRecord = {
      ...entry, name: collision, directory: collision,
      source: { kind: "local", input: "local-fixture", location: "local-fixture" },
    };
    for (const { candidates, expectedPackage } of [
      { candidates: [byPackage, byDirectory, byName], expectedPackage: "@scope/name" },
      { candidates: [byName, byDirectory, byPackage], expectedPackage: "@scope/name" },
      { candidates: [byPackage, byDirectory], expectedPackage: "@scope/directory" },
      { candidates: [byDirectory, byPackage], expectedPackage: "@scope/directory" },
      { candidates: [nonNpm, byPackage], expectedPackage: collision },
    ]) {
      expect((await resolveExtensionInstallSourceIdentity(collision, undefined, undefined, candidates)).installSource).toMatchObject({
        kind: "npm", input: `npm:${expectedPackage}`, spec: expectedPackage,
      });
    }
    for (const input of ["./managed-reinstall-fixture", "unmanaged-missing-fixture", ".", "npm:other-fixture", "managed\\reinstall"]) {
      expect((await resolveExtensionInstallSourceIdentity(input, undefined, undefined, [entry])).installSource.input).toBe(input);
    }
    expect((await resolveExtensionInstallSourceIdentity(entry.name, undefined, undefined, [{ ...entry, source: { ...entry.source, package: undefined } }])).installSource.kind).toBe("local");
    for (const packageName of [
      "--registry=untrusted", "-option", "https://example.invalid/package.tgz",
      "file:../other", "owner/repository", "npm:other", "other@1.0.0",
      "other.tgz", "other.tar.gz", "other;echo fixture", "@scope/name&fixture",
      "other%26fixture", " other ", "other\n", "",
    ]) {
      const malformed = { ...byName, source: { ...byName.source, package: packageName } };
      expect((await resolveExtensionInstallSourceIdentity(collision, undefined, undefined, [byPackage, byDirectory, malformed])).installSource).toMatchObject({
        kind: "local", input: collision,
      });
    }
    for (const spec of ["file:../other", "https://example.invalid/package.tgz", "other@1.0.0"]) {
      expect((await resolveExtensionInstallSourceIdentity(`npm:${spec}`, undefined, undefined, [entry])).installSource).toMatchObject({
        kind: "npm", input: `npm:${spec}`, spec,
      });
    }
    for (const input of ["nested/missing", "/missing/managed", "@scope/missing/nested"]) {
      expect((await resolveExtensionInstallSourceIdentity(input, undefined, undefined, [{ ...entry, name: input }])).installSource.kind).toBe("local");
    }
    const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pm-managed-reinstall-local-")));
    tempRoots.push(tempRoot);
    const previousCwd = process.cwd();
    try {
      await mkdir(path.join(tempRoot, entry.name));
      process.chdir(tempRoot);
      expect((await resolveExtensionInstallSourceIdentity(entry.name, undefined, undefined, [entry])).installSource.kind).toBe("local");
      const danglingName = "dangling-managed-fixture";
      await symlink(path.join(tempRoot, "absent-target"), path.join(tempRoot, danglingName), "junction");
      expect((await resolveExtensionInstallSourceIdentity(danglingName, undefined, undefined, [{ ...entry, name: danglingName }])).installSource.kind).toBe("local");
      const accessFailure = Object.assign(new Error("Local entry cannot be inspected"), { code: "EACCES" });
      const probe = vi.spyOn(fs, "lstat").mockRejectedValueOnce(accessFailure);
      try {
        await expect(resolveExtensionInstallSourceIdentity("inaccessible-managed-fixture", undefined, undefined, [{ ...entry, name: "inaccessible-managed-fixture" }])).rejects.toBe(accessFailure);
      } finally {
        probe.mockRestore();
      }
    } finally {
      process.chdir(previousCwd);
    }
  });
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
