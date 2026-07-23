import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateExtensions,
  loadExtensions,
  resolveExtensionRoots,
  runCommandHandler,
} from "../../../src/core/extensions/loader.js";
import { snapshotExtensionModuleGraph } from "../../../src/core/extensions/module-graph-snapshot.js";
import { readSettings } from "../../../src/core/store/settings.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("extension reinstall module-graph verification", () => {
  it("rejects an entry outside the package directory", async () => {
    await expect(
      snapshotExtensionModuleGraph("/tmp/snapshot-root", {
        layer: "project",
        directory: "outside-entry",
        manifest_path: "/tmp/extension/extension.json",
        entry_path: "/tmp/outside.js",
      }),
    ).rejects.toThrow(/outside its package directory/);
  });

  it("loads overwritten transitive modules from a fresh snapshot", async () => {
    await withTempPmPath(async (context) => {
      const extensionRoot = resolveExtensionRoots(
        context.pmPath,
        context.tempRoot,
      ).project;
      const fixture = await writeTestExtension({
        root: extensionRoot,
        directory: "fresh-graph",
        entryFilename: "index.js",
        manifestOverrides: { priority: 0 },
        entrySource:
          'import { value } from "./dependency.js";\nexport default { activate(api) { api.registerCommand({ name: "fresh graph", run: () => value }); } };\n',
      });
      const dependencyPath = path.join(
        fixture.extensionRoot,
        "dependency.js",
      );
      await writeFile(dependencyPath, 'export const value = "before";\n', "utf8");
      const settings = await readSettings(context.pmPath);

      const initial = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
        cwd: context.tempRoot,
      });
      const initialActivation = await activateExtensions(initial);
      await expect(
        runCommandHandler(initialActivation.commands, {
          command: "fresh graph",
          args: [],
          options: {},
          global: {},
          pm_root: context.pmPath,
        }),
      ).resolves.toMatchObject({ handled: true, result: "before" });

      await writeFile(
        fixture.entryPath,
        'import { nextValue } from "./dependency.js";\nexport default { activate(api) { api.registerCommand({ name: "fresh graph", run: () => nextValue }); } };\n',
        "utf8",
      );
      await writeFile(
        dependencyPath,
        'export const nextValue = "after";\n',
        "utf8",
      );
      const staleEntryOnlyReload = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
        cwd: context.tempRoot,
        cache_bust: true,
        reload_token: "entry-only",
      });
      // Node versions differ in how aggressively they retain the overwritten
      // dependency namespace, but entry-only cache busting still addresses only
      // one URL. The fresh-snapshot assertion below is the stable contract.
      expect(
        staleEntryOnlyReload.loaded.length + staleEntryOnlyReload.failed.length,
      ).toBe(1);

      const snapshotRoot = await mkdtemp(
        path.join(os.tmpdir(), "pm-extension-fresh-graph-test-"),
      );
      try {
        const freshGraphReload = await loadExtensions({
          pmRoot: context.pmPath,
          settings,
          cwd: context.tempRoot,
          cache_bust: true,
          reload_token: "fresh-graph",
          module_graph_snapshot_root: snapshotRoot,
        });
        expect(freshGraphReload.failed).toEqual([]);
        const freshActivation = await activateExtensions(freshGraphReload);
        await expect(
          runCommandHandler(freshActivation.commands, {
            command: "fresh graph",
            args: [],
            options: {},
            global: {},
            pm_root: context.pmPath,
          }),
        ).resolves.toMatchObject({ handled: true, result: "after" });
      } finally {
        await rm(snapshotRoot, { recursive: true, force: true });
      }
    });
  });
});
