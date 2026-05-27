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

let activeExtensionHooks: ExtensionHookRegistry | null = null;
let activeExtensionCommands: ExtensionCommandRegistry | null = null;
let activeExtensionParsers: ExtensionParserRegistry | null = null;
let activeExtensionPreflight: ExtensionPreflightRegistry | null = null;
let activeExtensionServices: ExtensionServiceRegistry | null = null;
let activeExtensionRenderers: ExtensionRendererRegistry | null = null;
let activeExtensionRegistrations: ExtensionRegistrationRegistry | null = null;
let activeCommandContext: Omit<CommandOverrideContext, "result"> | null = null;
let activeCommandResult: unknown = undefined;

export function setActiveExtensionHooks(hooks: ExtensionHookRegistry | null): void {
  activeExtensionHooks = hooks;
}

export function setActiveExtensionCommands(commands: ExtensionCommandRegistry | null): void {
  activeExtensionCommands = commands;
}

export function setActiveExtensionParsers(parsers: ExtensionParserRegistry | null): void {
  activeExtensionParsers = parsers;
}

export function setActiveExtensionPreflight(preflight: ExtensionPreflightRegistry | null): void {
  activeExtensionPreflight = preflight;
}

export function setActiveExtensionServices(services: ExtensionServiceRegistry | null): void {
  activeExtensionServices = services;
}

export function setActiveExtensionRenderers(renderers: ExtensionRendererRegistry | null): void {
  activeExtensionRenderers = renderers;
}

export function setActiveExtensionRegistrations(registrations: ExtensionRegistrationRegistry | null): void {
  activeExtensionRegistrations = registrations;
}

export function getActiveExtensionRegistrations(): ExtensionRegistrationRegistry | null {
  return activeExtensionRegistrations;
}

export function setActiveCommandContext(context: Omit<CommandOverrideContext, "result"> | null): void {
  activeCommandContext = context;
}

export function setActiveCommandResult(result: unknown): void {
  activeCommandResult = result;
}

export function getActiveCommandResult(): unknown {
  return activeCommandResult;
}

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
}

export async function runActiveOnWriteHooks(context: OnWriteHookContext): Promise<string[]> {
  if (!activeExtensionHooks) {
    return [];
  }
  return runOnWriteHooks(activeExtensionHooks, context);
}

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

export async function runActiveOnIndexHooks(context: OnIndexHookContext): Promise<string[]> {
  if (!activeExtensionHooks) {
    return [];
  }
  return runOnIndexHooks(activeExtensionHooks, context);
}

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
