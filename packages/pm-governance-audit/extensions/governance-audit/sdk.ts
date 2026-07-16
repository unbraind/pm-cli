/**
 * @module pm-governance-audit/sdk
 *
 * Resolves the host pm SDK runtime and exposes the typed subset consumed by
 * the governance-audit package without copying core command implementations.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as RuntimeSdk from "@unbrained/pm-cli/sdk/runtime";

const packageRoot = process.env.PM_CLI_PACKAGE_ROOT?.trim();
let loadedRuntime: typeof RuntimeSdk;
/* c8 ignore start -- copied installs exercise PM_CLI_PACKAGE_ROOT in subprocess integration coverage. */
try {
  if (packageRoot) {
    loadedRuntime = (await import(
      pathToFileURL(path.join(packageRoot, "dist", "sdk", "runtime.js")).href
    )) as typeof RuntimeSdk;
  } else {
    loadedRuntime = await import("@unbrained/pm-cli/sdk/runtime");
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(
    `pm-governance-audit could not load the host SDK runtime (PM_CLI_PACKAGE_ROOT=${packageRoot ?? "<unset>"}). Rebuild or reinstall @unbrained/pm-cli and the audit package. ${detail}`,
    { cause: error },
  );
}
/* c8 ignore stop */
const runtime = loadedRuntime;

/** Host SDK values used by package-owned audit commands and runtime decorators. */
export const {
  EXIT_CODE,
  PmCliError,
  PmClient,
  getActiveExtensionRegistrations,
  getSettingsPath,
  isTerminalStatus,
  locateItem,
  normalizeStatusInput,
  nowIso,
  pathExists,
  readBooleanOption,
  readCsvListOption,
  readLocatedItem,
  readSettings,
  readStringOption,
  resolveItemTypeRegistry,
  resolvePmRoot,
  resolveRuntimeStatusRegistry,
  runClose,
  runUpdate,
} = runtime;

/** Preserve the host SDK list overloads across the dynamic runtime boundary. */
export const runList: typeof RuntimeSdk.runList = runtime.runList;

/** Runtime status registry inferred from the host SDK's schema resolver. */
export type RuntimeStatusRegistry = ReturnType<
  typeof resolveRuntimeStatusRegistry
>;

export type {
  GlobalOptions,
  ItemMetadata,
  ItemStatus,
  ListedItem,
  ListOptions,
  UpdateCommandOptions,
} from "@unbrained/pm-cli/sdk/runtime";
