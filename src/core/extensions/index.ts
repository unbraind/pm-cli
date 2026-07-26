/**
 * @module core/extensions/index
 *
 * Implements extension runtime contracts and governance for Index.
 */
import { existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  runCommandHandler,
  runCommandOverride,
  runOnIndexHooks,
  runParserOverride,
  runPreflightOverride,
  runOnReadHooks,
  runRendererOverride,
  runServiceOverride,
  runServiceOverrideSync,
  runOnWriteHooks,
  type CommandHandlerContext,
  type CommandHandlerResult,
  type CommandOverrideContext,
  type CommandOverrideResult,
  type ExtensionCommandRegistry,
  type ExtensionHookRegistry,
  type ExtensionParserRegistry,
  type ExtensionPreflightRegistry,
  type ExtensionRegistrationRegistry,
  type ExtensionRendererRegistry,
  type ExtensionServiceName,
  type ExtensionServiceRegistry,
  type AfterCommandAffectedItem,
  type OnIndexHookContext,
  type OnReadHookContext,
  type OnWriteHookContext,
  type OutputRendererFormat,
  type ParserOverrideContext,
  type ParserOverrideResult,
  type PortableWorkspaceContext,
  type PreflightOverrideContext,
  type PreflightOverrideResult,
  type RendererOverrideResult,
  type ServiceOverrideResult,
} from "./loader.js";
import type { ItemMetadata } from "../../types/index.js";

let activeExtensionHooks: ExtensionHookRegistry | null = null;
let activeExtensionCommands: ExtensionCommandRegistry | null = null;
let activeExtensionParsers: ExtensionParserRegistry | null = null;
let activeExtensionPreflight: ExtensionPreflightRegistry | null = null;
let activeExtensionServices: ExtensionServiceRegistry | null = null;
let activeExtensionRenderers: ExtensionRendererRegistry | null = null;
let activeExtensionRegistrations: ExtensionRegistrationRegistry | null = null;
let activeCommandContext: Omit<CommandOverrideContext, "result"> | null = null;
let activeCommandResult: unknown = undefined;
let activeAfterCommandAffectedItems: AfterCommandAffectedItem[] = [];
interface ExtensionRuntimeState {
  hooks: ExtensionHookRegistry | null;
  commands: ExtensionCommandRegistry | null;
  parsers: ExtensionParserRegistry | null;
  preflight: ExtensionPreflightRegistry | null;
  services: ExtensionServiceRegistry | null;
  renderers: ExtensionRendererRegistry | null;
  registrations: ExtensionRegistrationRegistry | null;
  commandContext: Omit<CommandOverrideContext, "result"> | null;
  commandResult: unknown;
  affectedItems: AfterCommandAffectedItem[];
}
const isolatedExtensionRuntime = new AsyncLocalStorage<ExtensionRuntimeState>();

function runtimeState(): ExtensionRuntimeState | undefined {
  return isolatedExtensionRuntime.getStore();
}

/** Run one embedded request with extension registries isolated from concurrent workspaces. */
export function runWithIsolatedExtensionRuntime<T>(
  run: () => Promise<T>,
): Promise<T> {
  return isolatedExtensionRuntime.run(
    {
      hooks: null,
      commands: null,
      parsers: null,
      preflight: null,
      services: null,
      renderers: null,
      registrations: null,
      commandContext: null,
      commandResult: undefined,
      affectedItems: [],
    },
    run,
  );
}
const AFTER_COMMAND_SNAPSHOT_OMITTED_FIELDS = new Set([
  "body",
  "comments",
  "dependencies",
  "docs",
  "events",
  "files",
  "learnings",
  "notes",
  "reminders",
  "test_runs",
  "tests",
]);

function findSourceRepositoryRoot(candidate: string): string | undefined {
  let cursor = path.resolve(candidate);
  while (true) {
    if (existsSync(path.join(cursor, ".git"))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

/**
 * Resolve portable workspace coordinates without reading tracker state.
 *
 * Linked-test runners set `PM_SOURCE_WORKSPACE_ROOT` before swapping `PM_PATH`,
 * preserving source VCS identity while every mutation remains sandboxed.
 */
export function resolvePortableWorkspaceContext(
  pmRoot: string | undefined,
): PortableWorkspaceContext {
  const sourceCandidate =
    process.env.PM_SOURCE_WORKSPACE_ROOT?.trim() || process.cwd();
  const sourceWorkspaceRoot =
    findSourceRepositoryRoot(sourceCandidate) ?? path.resolve(sourceCandidate);
  const repoRoot = findSourceRepositoryRoot(sourceWorkspaceRoot);
  if (!pmRoot) {
    return {
      source_workspace_root: sourceWorkspaceRoot,
      ...(repoRoot ? { repo_root: repoRoot } : {}),
    };
  }
  const relativePmRoot = path.relative(sourceWorkspaceRoot, path.resolve(pmRoot));
  const contained =
    relativePmRoot.length > 0 &&
    !relativePmRoot.startsWith(`..${path.sep}`) &&
    relativePmRoot !== ".." &&
    !path.isAbsolute(relativePmRoot);
  return {
    source_workspace_root: sourceWorkspaceRoot,
    ...(repoRoot ? { repo_root: repoRoot } : {}),
    ...(contained
      ? { pm_root_rel: relativePmRoot.split(path.sep).join("/") }
      : {}),
  };
}

/** Implements set active extension hooks for the public runtime surface of this module. */
export function setActiveExtensionHooks(
  hooks: ExtensionHookRegistry | null,
): void {
  const state = runtimeState();
  if (state) {
    state.hooks = hooks;
    return;
  }
  activeExtensionHooks = hooks;
}

/** Implements set active extension commands for the public runtime surface of this module. */
export function setActiveExtensionCommands(
  commands: ExtensionCommandRegistry | null,
): void {
  const state = runtimeState();
  if (state) {
    state.commands = commands;
    return;
  }
  activeExtensionCommands = commands;
}

/** Implements set active extension parsers for the public runtime surface of this module. */
export function setActiveExtensionParsers(
  parsers: ExtensionParserRegistry | null,
): void {
  const state = runtimeState();
  if (state) {
    state.parsers = parsers;
    return;
  }
  activeExtensionParsers = parsers;
}

/** Implements set active extension preflight for the public runtime surface of this module. */
export function setActiveExtensionPreflight(
  preflight: ExtensionPreflightRegistry | null,
): void {
  const state = runtimeState();
  if (state) {
    state.preflight = preflight;
    return;
  }
  activeExtensionPreflight = preflight;
}

/** Implements set active extension services for the public runtime surface of this module. */
export function setActiveExtensionServices(
  services: ExtensionServiceRegistry | null,
): void {
  const state = runtimeState();
  if (state) {
    state.services = services;
    return;
  }
  activeExtensionServices = services;
}

/** Implements set active extension renderers for the public runtime surface of this module. */
export function setActiveExtensionRenderers(
  renderers: ExtensionRendererRegistry | null,
): void {
  const state = runtimeState();
  if (state) {
    state.renderers = renderers;
    return;
  }
  activeExtensionRenderers = renderers;
}

/** Implements set active extension registrations for the public runtime surface of this module. */
export function setActiveExtensionRegistrations(
  registrations: ExtensionRegistrationRegistry | null,
): void {
  const state = runtimeState();
  if (state) {
    state.registrations = registrations;
    return;
  }
  activeExtensionRegistrations = registrations;
}

/** Implements get active extension registrations for the public runtime surface of this module. */
export function getActiveExtensionRegistrations(): ExtensionRegistrationRegistry | null {
  const state = runtimeState();
  return state ? state.registrations : activeExtensionRegistrations;
}

/**
 * Clear every request-local or module-level active-extension registry in one step.
 *
 * The actives describe the CURRENT invocation only. One-shot `pm` processes
 * reset them for free by exiting; embedded SDK requests receive an async-local
 * state and reset it at invocation entry so concurrent workspaces cannot see
 * each other's registrations.
 */
export function resetActiveExtensionRuntimeState(): void {
  const state = runtimeState();
  if (state) {
    state.hooks = null;
    state.commands = null;
    state.parsers = null;
    state.preflight = null;
    state.services = null;
    state.renderers = null;
    state.registrations = null;
    state.commandContext = null;
    state.commandResult = null;
    state.affectedItems = [];
    return;
  }
  activeExtensionHooks = null;
  activeExtensionCommands = null;
  activeExtensionParsers = null;
  activeExtensionPreflight = null;
  activeExtensionServices = null;
  activeExtensionRenderers = null;
  activeExtensionRegistrations = null;
  activeCommandContext = null;
  activeCommandResult = null;
}

/** Implements set active command context for the public runtime surface of this module. */
export function setActiveCommandContext(
  context: Omit<CommandOverrideContext, "result"> | null,
): void {
  const resolved = context
    ? {
        ...context,
        ...resolvePortableWorkspaceContext(context.pm_root),
      }
    : null;
  const state = runtimeState();
  if (state) {
    state.commandContext = resolved;
    return;
  }
  activeCommandContext = resolved;
}

/** Implements set active command result for the public runtime surface of this module. */
export function setActiveCommandResult(result: unknown): void {
  const state = runtimeState();
  if (state) {
    state.commandResult = result;
    return;
  }
  activeCommandResult = result;
}

/** Implements get active command result for the public runtime surface of this module. */
export function getActiveCommandResult(): unknown {
  const state = runtimeState();
  return state ? state.commandResult : activeCommandResult;
}

/** Implements record after command affected item for the public runtime surface of this module. */
export function recordAfterCommandAffectedItem(
  item: AfterCommandAffectedItem,
): void {
  if (!item) {
    return;
  }
  const state = runtimeState();
  if (state) {
    state.affectedItems.push(item);
  } else {
    activeAfterCommandAffectedItems.push(item);
  }
}

/** Implements project after command item snapshot for the public runtime surface of this module. */
export function projectAfterCommandItemSnapshot(
  metadata: ItemMetadata,
  changedFields: readonly string[],
): Partial<ItemMetadata> {
  if (!metadata || !metadata.id) {
    return {};
  }
  const snapshot: Record<string, unknown> = {
    id: metadata.id,
    type: metadata.type,
    status: metadata.status,
  };
  if (!Array.isArray(changedFields)) {
    return snapshot as Partial<ItemMetadata>;
  }
  const source = metadata as unknown as Record<string, unknown>;
  for (const field of changedFields) {
    if (typeof field !== "string") {
      continue;
    }
    const actualField = field.startsWith("unset:")
      ? field.slice("unset:".length)
      : field;
    if (
      actualField === "id" ||
      actualField === "type" ||
      actualField === "status" ||
      AFTER_COMMAND_SNAPSHOT_OMITTED_FIELDS.has(actualField)
    ) {
      continue;
    }
    if (
      Object.hasOwn(source, actualField) &&
      source[actualField] !== undefined
    ) {
      snapshot[actualField] = source[actualField];
    }
  }
  return snapshot as Partial<ItemMetadata>;
}

/** Implements consume after command affected items for the public runtime surface of this module. */
export function consumeAfterCommandAffectedItems():
  | AfterCommandAffectedItem[]
  | undefined {
  const state = runtimeState();
  const affectedItems = state?.affectedItems ?? activeAfterCommandAffectedItems;
  if (affectedItems.length === 0) {
    return undefined;
  }
  const affected = affectedItems;
  if (state) {
    state.affectedItems = [];
  } else {
    activeAfterCommandAffectedItems = [];
  }
  return affected;
}

/** Implements clear active extension hooks for the public runtime surface of this module. */
export function clearActiveExtensionHooks(): void {
  const state = runtimeState();
  if (state) {
    state.hooks = null;
    state.commands = null;
    state.parsers = null;
    state.preflight = null;
    state.services = null;
    state.renderers = null;
    state.registrations = null;
    state.commandContext = null;
    state.commandResult = undefined;
    state.affectedItems = [];
    return;
  }
  activeExtensionHooks = null;
  activeExtensionCommands = null;
  activeExtensionParsers = null;
  activeExtensionPreflight = null;
  activeExtensionServices = null;
  activeExtensionRenderers = null;
  activeExtensionRegistrations = null;
  activeCommandContext = null;
  activeCommandResult = undefined;
  activeAfterCommandAffectedItems = [];
}

/** Implements run active on write hooks for the public runtime surface of this module. */
export async function runActiveOnWriteHooks(
  context: OnWriteHookContext,
): Promise<string[]> {
  const state = runtimeState();
  const hooks = state ? state.hooks : activeExtensionHooks;
  if (!hooks) {
    return [];
  }
  return runOnWriteHooks(hooks, context);
}

/** Implements run active on read hooks for the public runtime surface of this module. */
export async function runActiveOnReadHooks(
  context: OnReadHookContext,
): Promise<string[]> {
  const state = runtimeState();
  const hooks = state ? state.hooks : activeExtensionHooks;
  if (!hooks) {
    return [];
  }
  return runOnReadHooks(hooks, context);
}

/** Synchronous fast-path predicate: true only when at least one onRead hook is registered. Bulk readers (e.g. the metadata cache scanning hundreds of files) use this to skip per-file `await runActiveOnReadHooks(...)` calls entirely when no extension observes reads, avoiding hundreds of needless microtasks. */
export function hasActiveOnReadHooks(): boolean {
  const state = runtimeState();
  const hooks = state ? state.hooks : activeExtensionHooks;
  return (hooks?.onRead?.length ?? 0) > 0;
}

/** Implements run active on index hooks for the public runtime surface of this module. */
export async function runActiveOnIndexHooks(
  context: OnIndexHookContext,
): Promise<string[]> {
  const state = runtimeState();
  const hooks = state ? state.hooks : activeExtensionHooks;
  if (!hooks) {
    return [];
  }
  return runOnIndexHooks(hooks, context);
}

/** Implements run active command override for the public runtime surface of this module. */
export function runActiveCommandOverride(
  result: unknown,
): CommandOverrideResult {
  const state = runtimeState();
  const commands = state ? state.commands : activeExtensionCommands;
  const commandContext = state ? state.commandContext : activeCommandContext;
  if (!commands || !commandContext) {
    return {
      overridden: false,
      result,
      warnings: [],
    };
  }
  return runCommandOverride(commands, {
    command: commandContext.command,
    args: [...commandContext.args],
    options: commandContext.options
      ? { ...commandContext.options }
      : {},
    global: commandContext.global
      ? { ...commandContext.global }
      : undefined,
    pm_root: commandContext.pm_root,
    source_workspace_root: commandContext.source_workspace_root,
    repo_root: commandContext.repo_root,
    pm_root_rel: commandContext.pm_root_rel,
    result,
  });
}

/** Implements run active command handler for the public runtime surface of this module. */
export async function runActiveCommandHandler(
  context: CommandHandlerContext,
): Promise<CommandHandlerResult> {
  const state = runtimeState();
  const commands = state ? state.commands : activeExtensionCommands;
  if (!commands) {
    return {
      handled: false,
      result: null,
      warnings: [],
    };
  }
  return runCommandHandler(commands, {
    ...context,
    ...resolvePortableWorkspaceContext(context.pm_root),
  });
}

/** Implements run active parser override for the public runtime surface of this module. */
export async function runActiveParserOverride(
  context: ParserOverrideContext,
): Promise<ParserOverrideResult> {
  const state = runtimeState();
  const parsers = state ? state.parsers : activeExtensionParsers;
  if (!parsers) {
    return {
      overridden: false,
      context: {
        command: context.command,
        args: [...context.args],
        options: { ...context.options },
        global: { ...context.global },
        pm_root: context.pm_root,
      },
      warnings: [],
    };
  }
  return runParserOverride(parsers, {
    ...context,
    ...resolvePortableWorkspaceContext(context.pm_root),
  });
}

/** Implements run active preflight override for the public runtime surface of this module. */
export async function runActivePreflightOverride(
  context: PreflightOverrideContext,
): Promise<PreflightOverrideResult> {
  const state = runtimeState();
  const preflight = state ? state.preflight : activeExtensionPreflight;
  if (!preflight) {
    return {
      overridden: false,
      context: {
        command: context.command,
        args: [...context.args],
        options: { ...context.options },
        global: { ...context.global },
        pm_root: context.pm_root,
      },
      decision: { ...context.decision },
      warnings: [],
    };
  }
  return runPreflightOverride(preflight, {
    ...context,
    ...resolvePortableWorkspaceContext(context.pm_root),
  });
}

/** Implements run active renderer override for the public runtime surface of this module. */
export function runActiveRendererOverride(
  format: OutputRendererFormat,
  result: unknown,
): RendererOverrideResult {
  const state = runtimeState();
  const renderers = state ? state.renderers : activeExtensionRenderers;
  const commandContext = state ? state.commandContext : activeCommandContext;
  if (!renderers) {
    return {
      overridden: false,
      rendered: null,
      warnings: [],
    };
  }
  return runRendererOverride(renderers, {
    format,
    command: commandContext?.command,
    args: commandContext ? [...commandContext.args] : [],
    options: commandContext?.options
      ? { ...commandContext.options }
      : {},
    global: commandContext?.global
      ? { ...commandContext.global }
      : undefined,
    pm_root: commandContext?.pm_root,
    source_workspace_root: commandContext?.source_workspace_root,
    repo_root: commandContext?.repo_root,
    pm_root_rel: commandContext?.pm_root_rel,
    result,
  });
}

function buildServiceContext(service: ExtensionServiceName, payload: unknown) {
  const state = runtimeState();
  const commandContext = state ? state.commandContext : activeCommandContext;
  return {
    service,
    command: commandContext?.command,
    args: commandContext ? [...commandContext.args] : [],
    options: commandContext?.options
      ? { ...commandContext.options }
      : {},
    global: commandContext?.global
      ? { ...commandContext.global }
      : undefined,
    pm_root: commandContext?.pm_root,
    source_workspace_root: commandContext?.source_workspace_root,
    repo_root: commandContext?.repo_root,
    pm_root_rel: commandContext?.pm_root_rel,
    payload,
  };
}

/** Implements run active service override for the public runtime surface of this module. */
export async function runActiveServiceOverride(
  service: ExtensionServiceName,
  payload: unknown,
): Promise<ServiceOverrideResult> {
  const state = runtimeState();
  const services = state ? state.services : activeExtensionServices;
  if (!services) {
    return {
      handled: false,
      result: payload,
      warnings: [],
    };
  }
  return runServiceOverride(
    services,
    buildServiceContext(service, payload),
  );
}

/** Implements run active service override sync for the public runtime surface of this module. */
export function runActiveServiceOverrideSync(
  service: ExtensionServiceName,
  payload: unknown,
): ServiceOverrideResult {
  const state = runtimeState();
  const services = state ? state.services : activeExtensionServices;
  if (!services) {
    return {
      handled: false,
      result: payload,
      warnings: [],
    };
  }
  return runServiceOverrideSync(
    services,
    buildServiceContext(service, payload),
  );
}

export * from "./loader.js";
export * from "./command-hook-context.js";
export { createSerialQueue } from "../shared/serial-queue.js";
export {
  EXTENSION_CAPABILITY_REGISTRATION_SURFACES,
  collectUsedExtensionCapabilities,
  reconcileExtensionCapabilityUsage,
  type CollectUsedExtensionCapabilitiesOptions,
  type ExtensionCapabilityUsageReconciliation,
} from "./capability-usage.js";
