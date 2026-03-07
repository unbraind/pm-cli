import { describe, expect, it } from "vitest";
import * as cliCommands from "../../src/cli/commands/index.js";
import * as rootCommandTypes from "../../src/command-types.js";
import * as rootConstants from "../../src/constants.js";
import * as rootErrors from "../../src/errors.js";
import * as rootFsUtils from "../../src/fs-utils.js";
import * as rootHistory from "../../src/history.js";
import * as rootId from "../../src/id.js";
import * as rootItemFormat from "../../src/item-format.js";
import * as rootItemStore from "../../src/item-store.js";
import * as rootLock from "../../src/lock.js";
import * as rootOutput from "../../src/output.js";
import * as rootParse from "../../src/parse.js";
import * as rootPaths from "../../src/paths.js";
import * as rootSerialization from "../../src/serialization.js";
import * as rootSettings from "../../src/settings.js";
import * as rootTime from "../../src/time.js";
import * as rootTypes from "../../src/types.js";
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

describe("module boundaries export surface", () => {
  it("re-exports CLI command handlers", () => {
    expect(typeof cliCommands.runInit).toBe("function");
    expect(typeof cliCommands.runCreate).toBe("function");
    expect(typeof cliCommands.runDelete).toBe("function");
    expect(typeof cliCommands.runList).toBe("function");
    expect(typeof cliCommands.runSearch).toBe("function");
    expect(typeof cliCommands.runReindex).toBe("function");
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

  it("re-exports root compatibility modules", () => {
    expect(typeof rootCommandTypes).toBe("object");
    expect(rootConstants.EXIT_CODE.CONFLICT).toBe(4);
    expect(typeof rootErrors.PmCliError).toBe("function");
    expect(typeof rootFsUtils.ensureDir).toBe("function");
    expect(typeof rootHistory.createHistoryEntry).toBe("function");
    expect(typeof rootId.normalizeItemId).toBe("function");
    expect(typeof rootItemFormat.serializeItemDocument).toBe("function");
    expect(typeof rootItemStore.locateItem).toBe("function");
    expect(typeof rootLock.acquireLock).toBe("function");
    expect(typeof rootOutput.formatOutput).toBe("function");
    expect(typeof rootParse.parseTags).toBe("function");
    expect(typeof rootPaths.resolvePmRoot).toBe("function");
    expect(typeof rootSerialization.stableStringify).toBe("function");
    expect(typeof rootSettings.readSettings).toBe("function");
    expect(typeof rootTime.nowIso).toBe("function");
    expect(Array.isArray(rootTypes.ITEM_TYPE_VALUES)).toBe(true);
  });
});
