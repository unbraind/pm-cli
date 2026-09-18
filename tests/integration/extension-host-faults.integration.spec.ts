import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyExtensionDirectoryForInstall, withExtensionInstallLock } from "../../src/sdk/extension/install-runtime.js";
import { captureExtensionInstallSnapshot } from "../../src/sdk/extension/install-snapshot.js";
import { snapshotExtensionModuleGraph } from "../../src/core/extensions/module-graph-snapshot.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("extension host filesystem faults", () => {
  it("classifies host faults inside the install lease and releases ownership while preserving defects", async () => {
    await withTempPmPath(async (context) => {
      await expect(withExtensionInstallLock(context.pmPath, "fixture", async () => {
        throw Object.assign(new Error("quota denied a write"), { code: "EDQUOT" });
      })).rejects.toMatchObject({
        name: "PmCliError",
        context: { code: "host_environment_capacity_fault", reason: "EDQUOT" },
        message: expect.not.stringContaining(context.tempRoot),
      });
      const defect = new Error("Unexpected install implementation failure");
      await expect(withExtensionInstallLock(context.pmPath, "fixture", async () => {
        throw defect;
      })).rejects.toBe(defect);
      expect(await fs.readdir(path.join(context.pmPath, "runtime", "extension-install-locks"))).toEqual([]);
    });
  });
  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "reports failed lease cleanup after success and preserves a protected-operation failure",
    async () => {
      await withTempPmPath(async (context) => {
        const lockPath = path.join(context.pmPath, "runtime", "extension-install-locks", "scope.lock");
        const defect = new Error("Protected operation failed before cleanup");
        for (const operationFails of [false, true]) {
          try {
            const operation = withExtensionInstallLock(context.pmPath, "fixture", async () => {
              await fs.chmod(lockPath, 0o500);
              if (operationFails) throw defect;
              return "installed";
            });
            if (operationFails) {
              await expect(operation).rejects.toBe(defect);
            } else {
              await expect(operation).rejects.toMatchObject({
                name: "PmCliError",
                context: { code: "host_environment_permission_fault" },
                message: expect.not.stringContaining(context.tempRoot),
              });
            }
            expect(await fs.readdir(lockPath)).toContain("owner.json");
          } finally {
            await fs.chmod(lockPath, 0o700);
            await fs.rm(lockPath, { recursive: true });
          }
        }
      });
    },
  );
  it("translates exhausted copy capacity without retrying or exposing paths, and preserves defects", async () => {
    await withTempPmPath(async (context) => {
      const source = path.join(context.tempRoot, "private-source");
      const destination = path.join(context.tempRoot, "private-destination");
      await fs.mkdir(source);
      let calls = 0;
      await expect(
        copyExtensionDirectoryForInstall(source, destination, async () => {
          calls += 1;
          throw Object.assign(
            new Error(`ENOSPC: copyfile ${source} -> ${destination}`),
            { code: "ENOSPC" },
          );
        }),
      ).rejects.toMatchObject({
        name: "PmCliError",
        context: { code: "host_environment_capacity_fault", reason: "ENOSPC" },
        message: expect.not.stringContaining(context.tempRoot),
      });
      expect(calls).toBe(1);
      const defect = new Error("Unexpected copy implementation failure");
      await expect(
        copyExtensionDirectoryForInstall(source, destination, async () => {
          throw defect;
        }),
      ).rejects.toBe(defect);
    });
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "reports real backup and module verification permission failures with bounded operation names",
    async () => {
      await withTempPmPath(async (context) => {
        const source = path.join(context.tempRoot, "unreadable-extension");
        await fs.mkdir(source);
        await fs.writeFile(
          path.join(source, "index.mjs"),
          "export default {};\n",
        );
        await fs.chmod(source, 0);
        try {
          await expect(
            captureExtensionInstallSnapshot(
              context.pmPath,
              context.pmPath,
              source,
              true,
              path.join(context.tempRoot, "backup"),
            ),
          ).rejects.toMatchObject({
            name: "PmCliError",
            context: { code: "host_environment_permission_fault" },
            message: expect.stringContaining("extension_install_backup"),
          });
          await expect(
            snapshotExtensionModuleGraph(path.join(context.tempRoot, "graph"), {
              layer: "project",
              directory: "fixture",
              manifest_path: path.join(source, "manifest.json"),
              entry_path: path.join(source, "index.mjs"),
            }),
          ).rejects.toMatchObject({
            name: "PmCliError",
            context: { code: "host_environment_permission_fault" },
            message: expect.stringContaining("extension_module_graph_snapshot"),
          });
        } finally {
          await fs.chmod(source, 0o700);
        }
        const protectedParent = path.join(context.tempRoot, "protected-parent");
        const destination = path.join(protectedParent, "installed");
        await fs.mkdir(destination, { recursive: true });
        await fs.chmod(protectedParent, 0o500);
        try {
          await expect(
            copyExtensionDirectoryForInstall(source, destination),
          ).rejects.toMatchObject({
            name: "PmCliError",
            context: { code: "host_environment_permission_fault" },
            message: expect.stringContaining("extension_install_copy"),
          });
          expect(await fs.readdir(destination)).toEqual([]);
        } finally {
          await fs.chmod(protectedParent, 0o700);
        }
        const lockRoot = path.join(context.pmPath, "runtime", "extension-install-locks");
        await fs.mkdir(lockRoot, { recursive: true });
        await fs.chmod(lockRoot, 0o500);
        try {
          await expect(withExtensionInstallLock(context.pmPath, "fixture", async () => {
            throw new Error("Install must not run without its lease");
          })).rejects.toMatchObject({
            name: "PmCliError",
            context: { code: "host_environment_permission_fault" },
            message: expect.stringContaining("extension_install"),
          });
          expect(await fs.readdir(lockRoot)).toEqual([]);
        } finally {
          await fs.chmod(lockRoot, 0o700);
        }
      });
    },
  );
});
