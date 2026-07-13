import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as RuntimeSdk from "@unbrained/pm-cli/sdk/runtime";

const packageRoot = process.env.PM_CLI_PACKAGE_ROOT?.trim();
let loadedRuntime: typeof RuntimeSdk;
/* c8 ignore start -- copied installs exercise PM_CLI_PACKAGE_ROOT in subprocess integration coverage. */
if (packageRoot) {
  loadedRuntime = (await import(
    pathToFileURL(path.join(packageRoot, "dist", "sdk", "runtime.js")).href
  )) as typeof RuntimeSdk;
  /* c8 ignore stop */
} else {
  loadedRuntime = await import("@unbrained/pm-cli/sdk/runtime");
}
const runtime = loadedRuntime;

export const {
  EXIT_CODE,
  PmCliError,
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
  runList,
  runUpdate,
} = runtime;

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
