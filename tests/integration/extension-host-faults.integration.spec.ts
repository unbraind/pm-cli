import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyExtensionDirectoryForInstall } from "../../src/sdk/extension/install-runtime.js";
import { captureExtensionInstallSnapshot } from "../../src/sdk/extension/install-snapshot.js";
import { snapshotExtensionModuleGraph } from "../../src/core/extensions/module-graph-snapshot.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("extension host filesystem faults", () => {
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
      });
    },
  );
});
