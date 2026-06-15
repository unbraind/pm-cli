import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as cliCommands from "../../src/cli/commands/index.js";
import * as coreFs from "../../src/core/fs/fs-utils.js";
import * as coreFsIndex from "../../src/core/fs/index.js";
import * as coreHistory from "../../src/core/history/history.js";
import * as coreHistoryIndex from "../../src/core/history/index.js";
import * as coreItemFormat from "../../src/core/item/item-format.js";
import * as coreItemId from "../../src/core/item/id.js";
import * as coreItemParse from "../../src/core/item/parse.js";
import * as coreItemIndex from "../../src/core/item/index.js";
import * as coreLock from "../../src/core/lock/lock.js";
import * as coreLockIndex from "../../src/core/lock/index.js";
import * as coreOutput from "../../src/core/output/output.js";
import * as coreSharedCommandTypes from "../../src/core/shared/command-types.js";
import * as coreSharedConstants from "../../src/core/shared/constants.js";
import * as coreSharedErrors from "../../src/core/shared/errors.js";
import * as coreSharedSerialization from "../../src/core/shared/serialization.js";
import * as coreSharedTime from "../../src/core/shared/time.js";
import * as coreSharedIndex from "../../src/core/shared/index.js";
import * as coreStoreItemStore from "../../src/core/store/item-store.js";
import * as coreStorePaths from "../../src/core/store/paths.js";
import * as coreStoreSettings from "../../src/core/store/settings.js";
import * as coreStoreIndex from "../../src/core/store/index.js";
import * as sharedTypes from "../../src/types/index.js";
import {
  findPmPackageRootFromPath,
  resolveConfiguredPmPackageRoot,
  resolvePmCliVersion,
  resolvePmPackageRootFromModule,
} from "../../src/core/packages/root.js";

describe("module boundaries export surface", () => {
  it("re-exports CLI command handlers", () => {
    expect(typeof cliCommands.runInit).toBe("function");
    expect(typeof cliCommands.runCreate).toBe("function");
    expect(typeof cliCommands.runDelete).toBe("function");
    expect(typeof cliCommands.runList).toBe("function");
    expect(typeof cliCommands.runSearch).toBe("function");
    expect(typeof cliCommands.runReindex).toBe("undefined");
    expect(typeof cliCommands.runTestAll).toBe("function");
  });

  it("re-exports core namespaces", () => {
    expect(typeof coreFs.ensureDir).toBe("function");
    expect(typeof coreFsIndex.ensureDir).toBe("function");
    expect(typeof coreHistory.createHistoryEntry).toBe("function");
    expect(typeof coreHistoryIndex.hashDocument).toBe("function");
    expect(typeof coreItemFormat.serializeItemDocument).toBe("function");
    expect(typeof coreItemId.normalizeItemId).toBe("function");
    expect(typeof coreItemParse.parseTags).toBe("function");
    expect(typeof coreItemIndex.normalizeItemId).toBe("function");
    expect(typeof coreLock.acquireLock).toBe("function");
    expect(typeof coreLockIndex.acquireLock).toBe("function");
    expect(typeof coreOutput.formatOutput).toBe("function");
    expect(typeof coreStoreItemStore.locateItem).toBe("function");
    expect(typeof coreStorePaths.resolvePmRoot).toBe("function");
    expect(typeof coreStoreSettings.readSettings).toBe("function");
    expect(typeof coreStoreIndex.readSettings).toBe("function");
  });

  it("re-exports shared constants and types", () => {
    expect(coreSharedConstants.EXIT_CODE.SUCCESS).toBe(0);
    expect(typeof coreSharedErrors.PmCliError).toBe("function");
    expect(typeof coreSharedCommandTypes).toBe("object");
    expect(typeof coreSharedSerialization.stableStringify).toBe("function");
    expect(typeof coreSharedTime.resolveIsoOrRelative).toBe("function");
    expect(coreSharedIndex.EXIT_CODE.NOT_FOUND).toBe(3);
    expect(Array.isArray(sharedTypes.ITEM_TYPE_VALUES)).toBe(true);
  });

  it("resolves pm package roots and version fallbacks without throwing", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-root-"));
    try {
      const packageRoot = path.join(tempRoot, "pkg");
      const nestedFile = path.join(packageRoot, "dist", "cli.js");
      await mkdir(path.dirname(nestedFile), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@unbrained/pm-cli", version: "1.2.3" }), "utf8");
      await writeFile(nestedFile, "", "utf8");

      expect(findPmPackageRootFromPath(nestedFile)).toBe(packageRoot);
      expect(findPmPackageRootFromPath(path.join(tempRoot, "missing.js"))).toBeUndefined();
      // Passing an existing directory resolves it directly rather than via dirname of a file.
      expect(findPmPackageRootFromPath(path.join(packageRoot, "dist"))).toBe(packageRoot);
      expect(resolvePmPackageRootFromModule(new URL(nestedFile, "file://").href)).toBe(packageRoot);
      expect(resolvePmCliVersion(new URL(nestedFile, "file://").href)).toBe("1.2.3");
      expect(resolveConfiguredPmPackageRoot({ PM_CLI_PACKAGE_ROOT: ` ${packageRoot} ` })).toBe(packageRoot);
      expect(resolveConfiguredPmPackageRoot({}, "PM_CLI_PACKAGE_ROOT", new URL(nestedFile, "file://").href)).toBe(packageRoot);

      const malformedRoot = path.join(tempRoot, "bad");
      const malformedFile = path.join(malformedRoot, "dist", "cli.js");
      await mkdir(path.dirname(malformedFile), { recursive: true });
      await writeFile(path.join(malformedRoot, "package.json"), "{bad", "utf8");
      await writeFile(malformedFile, "", "utf8");
      expect(findPmPackageRootFromPath(malformedFile)).toBeUndefined();
      expect(resolvePmPackageRootFromModule(new URL(malformedFile, "file://").href, ["fallback"])).toBe(
        path.join(malformedRoot, "dist", "fallback"),
      );
      expect(resolvePmCliVersion(new URL(malformedFile, "file://").href, ["fallback"])).toBeUndefined();
      expect(resolvePmCliVersion("not-a-file-url")).toBeUndefined();

      // package.json present and named correctly but with a blank/non-string version → undefined.
      const blankVersionRoot = path.join(tempRoot, "blank-version");
      const blankVersionFile = path.join(blankVersionRoot, "dist", "cli.js");
      await mkdir(path.dirname(blankVersionFile), { recursive: true });
      await writeFile(
        path.join(blankVersionRoot, "package.json"),
        JSON.stringify({ name: "@unbrained/pm-cli", version: "   " }),
        "utf8",
      );
      await writeFile(blankVersionFile, "", "utf8");
      expect(resolvePmCliVersion(new URL(blankVersionFile, "file://").href)).toBeUndefined();
      expect(resolveConfiguredPmPackageRoot({}, "PM_CLI_PACKAGE_ROOT")).toBe(process.cwd());
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
