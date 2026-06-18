/**
 * @module core/extensions/index
 *
 * Implements extension runtime contracts and governance for Index.
 */
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
  type PreflightOverrideContext,
  type PreflightOverrideResult,
  type RendererOverrideResult,
  type ServiceOverrideResult,
} from "./loader.js";
import type { ItemFrontMatter } from "../../types/index.js";

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

/**
 * Implements set active extension hooks for the public runtime surface of this module.
 */
export function setActiveExtensionHooks(hooks: ExtensionHookRegistry | null): void {
  activeExtensionHooks = hooks;
}

/**
 * Implements set active extension commands for the public runtime surface of this module.
 */
export function setActiveExtensionCommands(commands: ExtensionCommandRegistry | null): void {
  activeExtensionCommands = commands;
}

/**
 * Implements set active extension parsers for the public runtime surface of this module.
 */
export function setActiveExtensionParsers(parsers: ExtensionParserRegistry | null): void {
  activeExtensionParsers = parsers;
}

/**
 * Implements set active extension preflight for the public runtime surface of this module.
 */
export function setActiveExtensionPreflight(preflight: ExtensionPreflightRegistry | null): void {
  activeExtensionPreflight = preflight;
}

/**
 * Implements set active extension services for the public runtime surface of this module.
 */
export function setActiveExtensionServices(services: ExtensionServiceRegistry | null): void {
  activeExtensionServices = services;
}

/**
 * Implements set active extension renderers for the public runtime surface of this module.
 */
export function setActiveExtensionRenderers(renderers: ExtensionRendererRegistry | null): void {
  activeExtensionRenderers = renderers;
}

/**
 * Implements set active extension registrations for the public runtime surface of this module.
 */
export function setActiveExtensionRegistrations(registrations: ExtensionRegistrationRegistry | null): void {
  activeExtensionRegistrations = registrations;
}

/**
 * Implements get active extension registrations for the public runtime surface of this module.
 */
export function getActiveExtensionRegistrations(): ExtensionRegistrationRegistry | null {
  return activeExtensionRegistrations;
}

/**
 * Implements set active command context for the public runtime surface of this module.
 */
export function setActiveCommandContext(context: Omit<CommandOverrideContext, "result"> | null): void {
  activeCommandContext = context;
}

/**
 * Implements set active command result for the public runtime surface of this module.
 */
export function setActiveCommandResult(result: unknown): void {
  activeCommandResult = result;
}

/**
 * Implements get active command result for the public runtime surface of this module.
 */
export function getActiveCommandResult(): unknown {
  return activeCommandResult;
}

/**
 * Implements record after command affected item for the public runtime surface of this module.
 */
export function recordAfterCommandAffectedItem(item: AfterCommandAffectedItem): void {
  if (!item || (activeExtensionHooks?.afterCommand?.length ?? 0) === 0) {
    return;
  }
  activeAfterCommandAffectedItems.push(item);
}

/**
 * Implements project after command item snapshot for the public runtime surface of this module.
 */
export function projectAfterCommandItemSnapshot(
  metadata: ItemFrontMatter,
  changedFields: readonly string[],
): Partial<ItemFrontMatter> {
  if (!metadata || !metadata.id) {
    return {};
  }
  const snapshot: Record<string, unknown> = {
    id: metadata.id,
    type: metadata.type,
    status: metadata.status,
  };
  if (!Array.isArray(changedFields)) {
    return snapshot as Partial<ItemFrontMatter>;
  }
  const source = metadata as unknown as Record<string, unknown>;
  for (const field of changedFields) {
    if (typeof field !== "string") {
      continue;
    }
    const actualField = field.startsWith("unset:") ? field.slice("unset:".length) : field;
    if (
      actualField === "id" ||
      actualField === "type" ||
      actualField === "status" ||
      AFTER_COMMAND_SNAPSHOT_OMITTED_FIELDS.has(actualField)
    ) {
      continue;
    }
    if (Object.hasOwn(source, actualField) && source[actualField] !== undefined) {
      snapshot[actualField] = source[actualField];
    }
  }
  return snapshot as Partial<ItemFrontMatter>;
}

/**
 * Implements consume after command affected items for the public runtime surface of this module.
 */
export function consumeAfterCommandAffectedItems(): AfterCommandAffectedItem[] | undefined {
  if (activeAfterCommandAffectedItems.length === 0) {
    return undefined;
  }
  const affected = activeAfterCommandAffectedItems;
  activeAfterCommandAffectedItems = [];
  return affected;
}

/**
 * Implements clear active extension hooks for the public runtime surface of this module.
 */
export function clearActiveExtensionHooks(): void {
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

/**
 * Implements run active on write hooks for the public runtime surface of this module.
 */
export async function runActiveOnWriteHooks(context: OnWriteHookContext): Promise<string[]> {
  if (!activeExtensionHooks) {
    return [];
  }
  return runOnWriteHooks(activeExtensionHooks, context);
}

/**
 * Implements run active on read hooks for the public runtime surface of this module.
 */
export async function runActiveOnReadHooks(context: OnReadHookContext): Promise<string[]> {
  if (!activeExtensionHooks) {
    return [];
  }
  return runOnReadHooks(activeExtensionHooks, context);
}

/**
 * Synchronous fast-path predicate: true only when at least one onRead hook is
 * registered. Bulk readers (e.g. the metadata cache scanning hundreds of files)
 * use this to skip per-file `await runActiveOnReadHooks(...)` calls entirely when
 * no extension observes reads, avoiding hundreds of needless microtasks.
 */
export function hasActiveOnReadHooks(): boolean {
  return (activeExtensionHooks?.onRead?.length ?? 0) > 0;
}

/**
 * Implements run active on index hooks for the public runtime surface of this module.
 */
export async function runActiveOnIndexHooks(context: OnIndexHookContext): Promise<string[]> {
  if (!activeExtensionHooks) {
    return [];
  }
  return runOnIndexHooks(activeExtensionHooks, context);
}

/**
 * Implements run active command override for the public runtime surface of this module.
 */
export function runActiveCommandOverride(result: unknown): CommandOverrideResult {
  if (!activeExtensionCommands || !activeCommandContext) {
    return {
      overridden: false,
      result,
      warnings: [],
    };
  }
  return runCommandOverride(activeExtensionCommands, {
    command: activeCommandContext.command,
    args: [...activeCommandContext.args],
    options: activeCommandContext.options ? { ...activeCommandContext.options } : {},
    global: activeCommandContext.global ? { ...activeCommandContext.global } : undefined,
    pm_root: activeCommandContext.pm_root,
    result,
  });
}

/**
 * Implements run active command handler for the public runtime surface of this module.
 */
export async function runActiveCommandHandler(context: CommandHandlerContext): Promise<CommandHandlerResult> {
  if (!activeExtensionCommands) {
    return {
      handled: false,
      result: null,
      warnings: [],
    };
  }
  return runCommandHandler(activeExtensionCommands, context);
}

/**
 * Implements run active parser override for the public runtime surface of this module.
 */
export async function runActiveParserOverride(context: ParserOverrideContext): Promise<ParserOverrideResult> {
  if (!activeExtensionParsers) {
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
  return runParserOverride(activeExtensionParsers, context);
}

/**
 * Implements run active preflight override for the public runtime surface of this module.
 */
export async function runActivePreflightOverride(context: PreflightOverrideContext): Promise<PreflightOverrideResult> {
  if (!activeExtensionPreflight) {
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
  return runPreflightOverride(activeExtensionPreflight, context);
}

/**
 * Implements run active renderer override for the public runtime surface of this module.
 */
export function runActiveRendererOverride(format: OutputRendererFormat, result: unknown): RendererOverrideResult {
  if (!activeExtensionRenderers) {
    return {
      overridden: false,
      rendered: null,
      warnings: [],
    };
  }
  return runRendererOverride(activeExtensionRenderers, {
    format,
    command: activeCommandContext?.command,
    args: activeCommandContext ? [...activeCommandContext.args] : [],
    options: activeCommandContext?.options ? { ...activeCommandContext.options } : {},
    global: activeCommandContext?.global ? { ...activeCommandContext.global } : undefined,
    pm_root: activeCommandContext?.pm_root,
    result,
  });
}

function buildServiceContext(service: ExtensionServiceName, payload: unknown) {
  return {
    service,
    command: activeCommandContext?.command,
    args: activeCommandContext ? [...activeCommandContext.args] : [],
    options: activeCommandContext?.options ? { ...activeCommandContext.options } : {},
    global: activeCommandContext?.global ? { ...activeCommandContext.global } : undefined,
    pm_root: activeCommandContext?.pm_root,
    payload,
  };
}

/**
 * Implements run active service override for the public runtime surface of this module.
 */
export async function runActiveServiceOverride(
  service: ExtensionServiceName,
  payload: unknown,
): Promise<ServiceOverrideResult> {
  if (!activeExtensionServices) {
    return {
      handled: false,
      result: payload,
      warnings: [],
    };
  }
  return runServiceOverride(activeExtensionServices, buildServiceContext(service, payload));
}

/**
 * Implements run active service override sync for the public runtime surface of this module.
 */
export function runActiveServiceOverrideSync(service: ExtensionServiceName, payload: unknown): ServiceOverrideResult {
  if (!activeExtensionServices) {
    return {
      handled: false,
      result: payload,
      warnings: [],
    };
  }
  return runServiceOverrideSync(activeExtensionServices, buildServiceContext(service, payload));
}

export * from "./loader.js";
