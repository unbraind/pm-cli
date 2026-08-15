import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoadedExtension } from "../../../src/core/extensions/loader.js";
import { scanExtensionHostVersions } from "../../../src/sdk/governance/extension-host-version.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writePmPackage(root: string, version: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "@unbrained/pm-cli", version })}\n`,
    "utf8",
  );
}

async function extension(
  workspace: string,
  name: string,
): Promise<LoadedExtension> {
  const directory = path.join(workspace, "extensions", name);
  const entryPath = path.join(directory, "entry.mjs");
  await mkdir(directory, { recursive: true });
  await writeFile(entryPath, "export const activate = () => ({});\n", "utf8");
  return {
    layer: "project",
    directory,
    manifest_path: path.join(directory, "pm-extension.json"),
    name,
    version: "1.0.0",
    entry: "entry.mjs",
    priority: 0,
    entry_path: entryPath,
    module: {},
  };
}

describe("extension host pm-cli version census", () => {
  it("makes an npm-style nested mismatch gate-visible", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-version-npm-"),
    );
    tempRoots.push(workspace);
    const host = path.join(workspace, "host");
    await writePmPackage(host, "2026.8.15");
    const loaded = await extension(workspace, "npm-skew");
    await writePmPackage(
      path.join(
        path.dirname(loaded.entry_path),
        "node_modules",
        "@unbrained",
        "pm-cli",
      ),
      "2026.8.14",
    );

    const census = await scanExtensionHostVersions([loaded], workspace, host);
    expect(census.host_version).toBe("2026.8.15");
    expect(census.mismatches).toEqual([
      expect.objectContaining({
        version: "2026.8.14",
        layout: "npm",
        consumers: ["npm-skew"],
      }),
    ]);
    expect(census.warnings).toEqual([
      "extension_host_pm_cli_version_skew:2026.8.15:2026.8.14:npm-skew",
    ]);
  });

  it("recognizes pnpm layout skew through a workspace symlink", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-version-pnpm-"),
    );
    tempRoots.push(workspace);
    const host = path.join(workspace, "host");
    await writePmPackage(host, "2026.8.15");
    const loaded = await extension(workspace, "pnpm-skew");
    const pnpmPackage = path.join(
      workspace,
      "node_modules",
      ".pnpm",
      "@unbrained+pm-cli@2026.8.13",
      "node_modules",
      "@unbrained",
      "pm-cli",
    );
    await writePmPackage(pnpmPackage, "2026.8.13");
    const packageLink = path.join(
      workspace,
      "node_modules",
      "@unbrained",
      "pm-cli",
    );
    await mkdir(path.dirname(packageLink), { recursive: true });
    await symlink(pnpmPackage, packageLink, "dir");

    const census = await scanExtensionHostVersions([loaded], workspace, host);
    expect(census.mismatches[0]).toMatchObject({
      version: "2026.8.13",
      layout: "pnpm",
      consumers: ["pnpm-skew"],
    });
  });

  it("keeps matching workspace copies green and deduplicates consumers", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-version-clean-"),
    );
    tempRoots.push(workspace);
    const host = path.join(workspace, "host");
    await writePmPackage(host, "2026.8.15");
    await writePmPackage(
      path.join(workspace, "node_modules", "@unbrained", "pm-cli"),
      "2026.8.15",
    );
    const first = await extension(workspace, "first");
    const second = await extension(workspace, "second");

    const census = await scanExtensionHostVersions(
      [first, first, second],
      workspace,
      host,
    );
    expect(census.mismatches).toEqual([]);
    expect(census.warnings).toEqual([]);
    expect(census.copies).toContainEqual(
      expect.objectContaining({ consumers: ["first", "second"] }),
    );
  });

  it("fails soft for an unavailable host and an invalid extension package", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-version-invalid-"),
    );
    tempRoots.push(workspace);
    const loaded = await extension(workspace, "invalid-package");
    const invalidPackage = path.join(
      path.dirname(loaded.entry_path),
      "node_modules",
      "@unbrained",
      "pm-cli",
    );
    await mkdir(invalidPackage, { recursive: true });
    await writeFile(
      path.join(invalidPackage, "package.json"),
      `${JSON.stringify({ name: "@unbrained/pm-cli", version: "" })}\n`,
      "utf8",
    );

    await expect(
      scanExtensionHostVersions(
        [loaded],
        workspace,
        path.join(workspace, "missing-host"),
      ),
    ).resolves.toEqual({
      host_version: null,
      copies: [],
      mismatches: [],
      warnings: [],
    });
  });

  it("classifies realpath-linked copies outside dependency folders", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-version-other-"),
    );
    tempRoots.push(workspace);
    const host = path.join(workspace, "host");
    await writePmPackage(host, "2026.8.15");
    const loaded = await extension(workspace, "other-layout");
    const sharedPackage = path.join(workspace, "shared-pm");
    await writePmPackage(sharedPackage, "2026.8.14");
    const packageLink = path.join(
      path.dirname(loaded.entry_path),
      "node_modules",
      "@unbrained",
      "pm-cli",
    );
    await mkdir(path.dirname(packageLink), { recursive: true });
    await symlink(sharedPackage, packageLink, "dir");

    const census = await scanExtensionHostVersions([loaded], workspace, host);
    expect(census.mismatches[0]).toMatchObject({
      layout: "other",
      path: "shared-pm/package.json",
    });
  });

  it("orders external path collisions by version", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-version-external-workspace-"),
    );
    const firstRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-version-external-a-"),
    );
    const secondRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-version-external-b-"),
    );
    tempRoots.push(workspace, firstRoot, secondRoot);
    const host = path.join(workspace, "host");
    await writePmPackage(host, "2026.8.15");
    const first = await extension(firstRoot, "external-first");
    const second = await extension(secondRoot, "external-second");
    await writePmPackage(
      path.join(
        path.dirname(first.entry_path),
        "node_modules",
        "@unbrained",
        "pm-cli",
      ),
      "2026.8.12",
    );
    await writePmPackage(
      path.join(
        path.dirname(second.entry_path),
        "node_modules",
        "@unbrained",
        "pm-cli",
      ),
      "2026.8.13",
    );

    const census = await scanExtensionHostVersions(
      [second, first],
      workspace,
      host,
    );
    expect(census.mismatches.map((copy) => copy.version)).toEqual([
      "2026.8.12",
      "2026.8.13",
    ]);
    expect(census.mismatches.every((copy) => copy.path.startsWith("<external>/"))).toBe(true);
  });
});
