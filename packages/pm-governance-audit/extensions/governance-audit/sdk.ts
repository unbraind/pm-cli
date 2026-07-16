/**
 * @module pm-governance-audit/sdk
 *
 * Resolves the host pm SDK runtime and exposes the typed subset consumed by
 * the governance-audit package without copying core command implementations.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  EXIT_CODE as RuntimeExitCode,
  PmCliError as RuntimePmCliError,
  PmClient as RuntimePmClient,
  getActiveExtensionRegistrations as runtimeGetActiveExtensionRegistrations,
  getSettingsPath as runtimeGetSettingsPath,
  isTerminalStatus as runtimeIsTerminalStatus,
  locateItem as runtimeLocateItem,
  normalizeStatusInput as runtimeNormalizeStatusInput,
  nowIso as runtimeNowIso,
  pathExists as runtimePathExists,
  readBooleanOption as runtimeReadBooleanOption,
  readCsvListOption as runtimeReadCsvListOption,
  readLocatedItem as runtimeReadLocatedItem,
  readSettings as runtimeReadSettings,
  readStringOption as runtimeReadStringOption,
  resolveItemTypeRegistry as runtimeResolveItemTypeRegistry,
  resolvePmRoot as runtimeResolvePmRoot,
  resolveRuntimeStatusRegistry as runtimeResolveRuntimeStatusRegistry,
  runClose as runtimeRunClose,
  runList as runtimeRunList,
  runUpdate as runtimeRunUpdate,
} from "@unbrained/pm-cli/sdk/runtime";

/** Typed host-runtime values consumed through the package's dynamic boundary. */
interface RuntimeSdkModule {
  EXIT_CODE: typeof RuntimeExitCode;
  PmCliError: typeof RuntimePmCliError;
  PmClient: typeof RuntimePmClient;
  getActiveExtensionRegistrations: typeof runtimeGetActiveExtensionRegistrations;
  getSettingsPath: typeof runtimeGetSettingsPath;
  isTerminalStatus: typeof runtimeIsTerminalStatus;
  locateItem: typeof runtimeLocateItem;
  normalizeStatusInput: typeof runtimeNormalizeStatusInput;
  nowIso: typeof runtimeNowIso;
  pathExists: typeof runtimePathExists;
  readBooleanOption: typeof runtimeReadBooleanOption;
  readCsvListOption: typeof runtimeReadCsvListOption;
  readLocatedItem: typeof runtimeReadLocatedItem;
  readSettings: typeof runtimeReadSettings;
  readStringOption: typeof runtimeReadStringOption;
  resolveItemTypeRegistry: typeof runtimeResolveItemTypeRegistry;
  resolvePmRoot: typeof runtimeResolvePmRoot;
  resolveRuntimeStatusRegistry: typeof runtimeResolveRuntimeStatusRegistry;
  runClose: typeof runtimeRunClose;
  runList: typeof runtimeRunList;
  runUpdate: typeof runtimeRunUpdate;
}

const packageRoot = process.env.PM_CLI_PACKAGE_ROOT?.trim();
let loadedRuntime: RuntimeSdkModule;
/* c8 ignore start -- copied installs exercise PM_CLI_PACKAGE_ROOT in subprocess integration coverage. */
try {
  if (packageRoot) {
    loadedRuntime = (await import(
      pathToFileURL(path.join(packageRoot, "dist", "sdk", "runtime.js")).href
    )) as RuntimeSdkModule;
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
export const runList: typeof runtimeRunList = runtime.runList;

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
