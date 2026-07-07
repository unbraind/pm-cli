import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PmClient,
  extension,
  extensionActivate,
  extensionDeactivate,
  extensionList,
  packageActivate,
  packageCatalog,
  packageDeactivate,
  packageDescribe,
  packageDoctor,
  packageInstall,
  packageLifecycle,
  packageList,
  packageManage,
  packageReload,
  packageUninstall,
  upgrade,
  type ExtensionCommandResult,
  type PackageCommandResult,
  type UpgradeResult,
} from "../../../src/sdk/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("SDK package and extension lifecycle primitives", () => {
  it("exposes typed package and extension lifecycle helpers on PmClient and top-level exports", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });

      const extensions = await client.extensionList({ project: true });
      expect(extensions).toMatchObject({
        ok: true,
        action: "explore",
        scope: "project",
      });
      const defaultExtension = await client.extension(undefined, { project: true });
      expect(defaultExtension).toMatchObject({
        ok: true,
        action: "explore",
        scope: "project",
      });

      const packages = await client.packageList({ project: true });
      expect(packages).toMatchObject({
        ok: true,
        action: "explore",
        scope: "project",
      });
      const defaultPackage = await client.package(undefined, { project: true });
      expect(defaultPackage).toMatchObject({
        ok: true,
        action: "explore",
        scope: "project",
      });

      const directPackage = await packageLifecycle("list", { project: true }, { pmRoot: pmPath, noExtensions: true });
      expect(directPackage).toMatchObject({
        ok: true,
        action: "explore",
        scope: "project",
      });

      const catalog = await packageCatalog({ project: true }, { pmRoot: pmPath, noExtensions: true });
      expect(catalog).toMatchObject({
        ok: true,
        action: "catalog",
        scope: "project",
      });

      const doctor = await packageDoctor({ project: true, isolated: true }, { pmRoot: pmPath, noExtensions: true });
      expect(doctor).toMatchObject({
        ok: true,
        action: "doctor",
        scope: "project",
      });
      await expect(client.run("package-doctor", { target: "missing-package", options: { project: true, isolated: true } })).rejects.toThrow(
        'Action "doctor" does not accept a target argument.',
      );

      const topLevelExtensions = await extensionList({ project: true }, { pmRoot: pmPath, noExtensions: true });
      expect(topLevelExtensions).toMatchObject({
        ok: true,
        action: "explore",
        scope: "project",
      });

      const genericExtension = await extension("list", { project: true }, { pmRoot: pmPath, noExtensions: true });
      expect(genericExtension).toMatchObject({
        ok: true,
        action: "explore",
        scope: "project",
      });

      const topLevelPackages = await packageList({ project: true }, { pmRoot: pmPath, noExtensions: true });
      expect(topLevelPackages).toMatchObject({
        ok: true,
        action: "explore",
        scope: "project",
      });

      const managed = await packageManage(undefined, { project: true }, { pmRoot: pmPath, noExtensions: true });
      expect(managed).toMatchObject({
        ok: true,
        action: "manage",
        scope: "project",
      });
      const targetedManaged = await client.packageManage("missing-package", { project: true });
      expect(targetedManaged).toMatchObject({
        ok: true,
        action: "manage",
        scope: "project",
      });

      const described = await packageDescribe(undefined, { project: true }, { pmRoot: pmPath, noExtensions: true });
      expect(described).toMatchObject({
        ok: true,
        action: "describe",
        scope: "project",
      });
      await expect(client.packageDescribe("missing-package", { project: true })).rejects.toThrow(/No loaded package named/);
      await expect(
        client.run("package-describe", { target: "missing-package", options: { project: true, vocabulary: "extension" } }),
      ).rejects.toThrow(/No loaded package named/);
      await expect(
        client.run("package", { target: "missing-package", options: { project: true, describe: true, vocabulary: "extension" } }),
      ).rejects.toThrow(/No loaded package named/);

      const reloaded = await packageReload({ project: true }, { pmRoot: pmPath, noExtensions: true });
      expect(reloaded).toMatchObject({
        ok: true,
        action: "reload",
        scope: "project",
      });

      await expect(client.extensionActivate("missing-extension", { project: true })).rejects.toThrow(/not installed|not found/i);
      await expect(extensionActivate("missing-extension", { project: true }, { pmRoot: pmPath, noExtensions: true })).rejects.toThrow(
        /not installed|not found/i,
      );
      await expect(client.extensionDeactivate("missing-extension", { project: true })).rejects.toThrow(/not installed|not found/i);
      await expect(
        extensionDeactivate("missing-extension", { project: true }, { pmRoot: pmPath, noExtensions: true }),
      ).rejects.toThrow(/not installed|not found/i);
      await expect(client.packageInstall(path.join(tempRoot, "missing-package"), { project: true })).rejects.toThrow();
      await expect(
        packageInstall(path.join(tempRoot, "missing-package"), { project: true }, { pmRoot: pmPath, noExtensions: true }),
      ).rejects.toThrow();
      await expect(client.packageUninstall("missing-package", { project: true })).rejects.toThrow(/not installed|not found/i);
      await expect(packageUninstall("missing-package", { project: true }, { pmRoot: pmPath, noExtensions: true })).rejects.toThrow(
        /not installed|not found/i,
      );
      await expect(packageActivate("missing-package", { project: true }, { pmRoot: pmPath, noExtensions: true })).rejects.toThrow(
        /not installed|not found/i,
      );
      await expect(packageDeactivate("missing-package", { project: true }, { pmRoot: pmPath, noExtensions: true })).rejects.toThrow(
        /not installed|not found/i,
      );

      await expect(
        client.upgrade("missing-package", {
          dryRun: true,
          packagesOnly: true,
          commandRunner: async () => ({ stdout: "", stderr: "" }),
        }),
      ).rejects.toThrow('Managed package "missing-package" was not found in project scope.');
    });
  });

  it("routes upgrade through the SDK dispatcher without requiring command-line argv", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const result = await upgrade(
        undefined,
        {
          dryRun: true,
          cliOnly: true,
          commandRunner: async () => ({ stdout: "", stderr: "" }),
        },
        { pmRoot: pmPath, noExtensions: true },
      );

      expect(result).toMatchObject({
        ok: true,
        action: "upgrade",
        dry_run: true,
        cli: {
          requested: true,
          status: "planned",
          package: "@unbrained/pm-cli",
        },
      });
    });
  });

  it("keeps lifecycle result contracts available as public SDK types", () => {
    const extensionResult: Pick<ExtensionCommandResult, "ok" | "action" | "scope"> = {
      ok: true,
      action: "catalog",
      scope: "project",
    };
    const packageResult: Pick<PackageCommandResult, "ok" | "action" | "scope"> = {
      ok: true,
      action: "catalog",
      scope: "project",
    };
    const upgradeResult: Pick<UpgradeResult, "ok" | "action" | "dry_run"> = {
      ok: true,
      action: "upgrade",
      dry_run: true,
    };

    expect(extensionResult).toEqual({
      ok: true,
      action: "catalog",
      scope: "project",
    });
    expect(packageResult).toEqual({
      ok: true,
      action: "catalog",
      scope: "project",
    });
    expect(upgradeResult).toEqual({
      ok: true,
      action: "upgrade",
      dry_run: true,
    });
  });
});
