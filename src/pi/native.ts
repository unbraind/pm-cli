import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { readSettings } from "../core/store/settings.js";
import { resolvePmRoot } from "../core/store/paths.js";
import { normalizeStatusInput } from "../core/item/status.js";
import { resolveRuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
import { PM_TOOL_ACTIONS, isPmToolAction } from "../sdk/cli-contracts.js";
import {
  runActivity,
  runAggregate,
  runAppend,
  runCalendar,
  runClaim,
  runClose,
  runComments,
  runCommentsAudit,
  runCompletion,
  runConfig,
  runContext,
  runContracts,
  runCreate,
  runDedupeAudit,
  runDelete,
  runDeps,
  runDocs,
  runExtension,
  runFiles,
  runFilesDiscover,
  runGc,
  runGet,
  runGuide,
  runHealth,
  runHistory,
  runInit,
  runLearnings,
  runList,
  runNormalize,
  runNotes,
  runReindex,
  runRelease,
  runRestore,
  runSearch,
  runStats,
  runTemplatesList,
  runTemplatesSave,
  runTemplatesShow,
  runTest,
  runTestAll,
  runTestRunsList,
  runTestRunsLogs,
  runTestRunsResume,
  runTestRunsStatus,
  runTestRunsStop,
  runUpdate,
  runUpdateMany,
  runValidate,
} from "../cli/commands/index.js";

export type NativePmArgs = Record<string, unknown>;

const GLOBAL_KEYS = new Set([
  "action",
  "cwd",
  "path",
  "json",
  "quiet",
  "profile",
  "noExtensions",
  "noPager",
  "pmExecutable",
  "timeoutMs",
  "options",
]);

const NATIVE_PM_ACTION_ALIASES = ["files-discover"] as const;
const NATIVE_PM_ACTIONS = new Set<string>([...PM_TOOL_ACTIONS, ...NATIVE_PM_ACTION_ALIASES]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function mutationOptions(options: Record<string, unknown>): { author?: string; message?: string } {
  return {
    author: readString(options, "author"),
    message: typeof options.message === "string" ? options.message : undefined,
  };
}

function requiredString(args: Record<string, unknown>, key: string, action: string): string {
  const value = readString(args, key);
  if (!value) {
    throw new PmCliError(`Action "${action}" requires "${key}".`, 64);
  }
  return value;
}

export function nativeGlobalOptions(args: NativePmArgs): GlobalOptions {
  return {
    json: args.json !== false,
    quiet: args.quiet === true,
    profile: args.profile === true,
    noExtensions: args.noExtensions === true,
    noPager: args.noPager !== false,
    path: readString(args, "path"),
  };
}

export function nativeCommandOptions(args: NativePmArgs): Record<string, unknown> {
  const options = asRecord(args.options);
  for (const [key, value] of Object.entries(args)) {
    if (GLOBAL_KEYS.has(key) || value === undefined) continue;
    if (options[key] === undefined) options[key] = value;
  }
  const author = readString(args, "author");
  if (author && options.author === undefined) options.author = author;
  return options;
}

async function withCwd<T>(cwd: unknown, run: () => Promise<T>): Promise<T> {
  if (typeof cwd !== "string" || cwd.trim().length === 0) return run();
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

async function runStartTask(id: string, options: Record<string, unknown>, global: GlobalOptions): Promise<unknown> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const status = normalizeStatusInput("in_progress", statusRegistry) ?? statusRegistry.open_status;
  const force = options.force === true;
  const baseOptions = mutationOptions(options);
  const claim = await runClaim(id, force, global, baseOptions);
  const update = await runUpdate(id, { ...baseOptions, status, force }, global);
  return { id, action: "start_task", claim, update };
}

async function runPauseTask(id: string, options: Record<string, unknown>, global: GlobalOptions): Promise<unknown> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const force = options.force === true;
  const baseOptions = mutationOptions(options);
  const update = await runUpdate(id, { ...baseOptions, status: statusRegistry.open_status, force }, global);
  const release = await runRelease(id, force, global, baseOptions);
  return { id, action: "pause_task", update, release };
}

async function runCloseTask(id: string, reason: string, options: Record<string, unknown>, global: GlobalOptions): Promise<unknown> {
  const force = options.force === true;
  const baseOptions = mutationOptions(options);
  const close = await runClose(id, reason, { ...baseOptions, validateClose: readString(options, "validateClose"), force }, global);
  const release = await runRelease(id, force, global, baseOptions);
  return { id, action: "close_task", close, release };
}

function resolvePackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

async function loadBundledExtensionRuntime(name: "beads" | "todos"): Promise<Record<string, unknown>> {
  const runtimePath = path.join(resolvePackageRoot(), ".agents", "pm", "extensions", name, "runtime.js");
  return import(pathToFileURL(runtimePath).href) as Promise<Record<string, unknown>>;
}

async function runBeadsImport(options: Record<string, unknown>, global: GlobalOptions): Promise<unknown> {
  const runtime = await loadBundledExtensionRuntime("beads");
  const runner = runtime.runBeadsImport;
  if (typeof runner !== "function") {
    throw new PmCliError("Bundled beads runtime is missing runBeadsImport().", 1);
  }
  return runner(options, global) as Promise<unknown>;
}

async function runTodosImport(options: Record<string, unknown>, global: GlobalOptions): Promise<unknown> {
  const runtime = await loadBundledExtensionRuntime("todos");
  const runner = runtime.runTodosImport;
  if (typeof runner !== "function") {
    throw new PmCliError("Bundled todos runtime is missing runTodosImport().", 1);
  }
  return runner(options, global) as Promise<unknown>;
}

async function runTodosExport(options: Record<string, unknown>, global: GlobalOptions): Promise<unknown> {
  const runtime = await loadBundledExtensionRuntime("todos");
  const runner = runtime.runTodosExport;
  if (typeof runner !== "function") {
    throw new PmCliError("Bundled todos runtime is missing runTodosExport().", 1);
  }
  return runner(options, global) as Promise<unknown>;
}

export async function runNativePmAction(args: NativePmArgs): Promise<unknown> {
  return withCwd(args.cwd, async () => {
    const action = requiredString(args, "action", "pm").trim().toLowerCase();
    if (!NATIVE_PM_ACTIONS.has(action) && !isPmToolAction(action)) {
      throw new PmCliError(`Unsupported native pm action: ${action}`, 64);
    }
    const global = nativeGlobalOptions(args);
    const options = nativeCommandOptions(args);
    const id = readString(args, "id") ?? readString(options, "id");
    const force = args.force === true || options.force === true;

    switch (action) {
      case "init": return runInit(readString(args, "prefix") ?? readString(options, "prefix"), global, options);
      case "config": return runConfig(readString(args, "scope") ?? readString(options, "scope") ?? "project", readString(args, "configAction") ?? readString(options, "configAction") ?? requiredString(options, "action", action), readString(args, "key") ?? readString(options, "key"), options, global);
      case "extension-init": return runExtension(requiredString(args, "target", action), { ...options, init: true }, global);
      case "extension-install": return runExtension(readString(args, "target") ?? readString(options, "target"), { ...options, install: true }, global);
      case "extension-uninstall": return runExtension(requiredString(args, "target", action), { ...options, uninstall: true }, global);
      case "extension-explore": return runExtension(undefined, { ...options, explore: true }, global);
      case "extension-manage": return runExtension(undefined, { ...options, manage: true }, global);
      case "extension-doctor": return runExtension(undefined, { ...options, doctor: true }, global);
      case "extension-adopt": return runExtension(requiredString(args, "target", action), { ...options, adopt: true }, global);
      case "extension-adopt-all": return runExtension(undefined, { ...options, adoptAll: true }, global);
      case "extension-activate": return runExtension(requiredString(args, "target", action), { ...options, activate: true }, global);
      case "extension-deactivate": return runExtension(requiredString(args, "target", action), { ...options, deactivate: true }, global);
      case "extension": return runExtension(readString(args, "target") ?? readString(options, "target"), options, global);
      case "beads-import": return runBeadsImport(options, global);
      case "todos-import": return runTodosImport(options, global);
      case "todos-export": return runTodosExport(options, global);
      case "create": return runCreate(options, global);
      case "list": case "list-all": case "list-draft": case "list-open": case "list-in-progress": case "list-blocked": case "list-closed": case "list-canceled": return runList(action === "list" ? readString(args, "status") : action === "list-all" ? undefined : action.replace("list-", "").replaceAll("-", "_"), options, global);
      case "aggregate": return runAggregate(options, global);
      case "dedupe-audit": return runDedupeAudit(options, global);
      case "calendar": case "cal": return runCalendar(options, global);
      case "context": case "ctx": return runContext(options, global);
      case "get": return runGet(id ?? requiredString(options, "id", action), global);
      case "search": return runSearch(readString(args, "query") ?? readString(args, "keywords") ?? requiredString(options, "query", action), options, global);
      case "reindex": return runReindex(options, global);
      case "history": return runHistory(id ?? requiredString(options, "id", action), options, global);
      case "activity": return runActivity(options, global);
      case "restore": return runRestore(id ?? requiredString(options, "id", action), readString(args, "target") ?? requiredString(options, "target", action), options, global);
      case "update": return runUpdate(id ?? requiredString(options, "id", action), options, global);
      case "update-many": return runUpdateMany(options as never, global);
      case "normalize": return runNormalize(options as never, global);
      case "close": return runClose(id ?? requiredString(options, "id", action), readString(args, "text") ?? readString(args, "reason") ?? requiredString(options, "text", action), options, global);
      case "delete": return runDelete(id ?? requiredString(options, "id", action), options, global);
      case "append": return runAppend(id ?? requiredString(options, "id", action), options as never, global);
      case "comments": return runComments(id ?? requiredString(options, "id", action), options, global);
      case "comments-audit": return runCommentsAudit(options, global);
      case "notes": return runNotes(id ?? requiredString(options, "id", action), options, global);
      case "learnings": return runLearnings(id ?? requiredString(options, "id", action), options, global);
      case "files": return runFiles(id ?? requiredString(options, "id", action), options, global);
      case "files-discover": return runFilesDiscover(id ?? requiredString(options, "id", action), options, global);
      case "docs": return runDocs(id ?? requiredString(options, "id", action), options, global);
      case "deps": return runDeps(id ?? requiredString(options, "id", action), options, global);
      case "test": return runTest(id ?? requiredString(options, "id", action), options, global);
      case "test-all": return runTestAll(options, global);
      case "test-runs-list": return runTestRunsList(options, global);
      case "test-runs-status": return runTestRunsStatus(requiredString(args, "runId", action), global);
      case "test-runs-logs": return runTestRunsLogs(requiredString(args, "runId", action), options, global);
      case "test-runs-stop": return runTestRunsStop(requiredString(args, "runId", action), options, global);
      case "test-runs-resume": return runTestRunsResume(requiredString(args, "runId", action), options, global);
      case "stats": return runStats(global);
      case "health": return runHealth(global, options);
      case "validate": return runValidate(options, global);
      case "gc": return runGc(global, options);
      case "contracts": return runContracts(options, global);
      case "completion": return runCompletion(requiredString(args, "shell", action), undefined, undefined, options.eagerTags === true, options.runtime as never);
      case "templates-save":
        return runTemplatesSave(
          readString(args, "template") ?? readString(options, "template") ?? requiredString(options, "name", action),
          options,
          global,
        );
      case "templates-list": return runTemplatesList(global);
      case "templates-show":
        return runTemplatesShow(
          readString(args, "template") ?? readString(options, "template") ?? requiredString(options, "name", action),
          global,
        );
      case "claim": return runClaim(id ?? requiredString(options, "id", action), force, global, options);
      case "release": return runRelease(id ?? requiredString(options, "id", action), force, global, options);
      case "start-task": return runStartTask(id ?? requiredString(options, "id", action), options, global);
      case "pause-task": return runPauseTask(id ?? requiredString(options, "id", action), options, global);
      case "close-task": return runCloseTask(id ?? requiredString(options, "id", action), readString(args, "text") ?? readString(args, "reason") ?? requiredString(options, "text", action), options, global);
      case "guide": return runGuide(options, global);
      default: throw new PmCliError(`Unsupported native pm action: ${action}`, 64);
    }
  });
}
