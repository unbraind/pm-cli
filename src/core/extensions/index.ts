import {
  runCommandHandler,
  runCommandOverride,
  runOnIndexHooks,
  runOnReadHooks,
  runRendererOverride,
  runOnWriteHooks,
  type CommandHandlerContext,
  type CommandHandlerResult,
  type CommandOverrideContext,
  type CommandOverrideResult,
  type ExtensionCommandRegistry,
  type ExtensionHookRegistry,
  type ExtensionRendererRegistry,
  type OnIndexHookContext,
  type OnReadHookContext,
  type OnWriteHookContext,
  type OutputRendererFormat,
  type RendererOverrideResult,
} from "./loader.js";

let activeExtensionHooks: ExtensionHookRegistry | null = null;
let activeExtensionCommands: ExtensionCommandRegistry | null = null;
let activeExtensionRenderers: ExtensionRendererRegistry | null = null;
let activeCommandContext: Omit<CommandOverrideContext, "result"> | null = null;

export function setActiveExtensionHooks(hooks: ExtensionHookRegistry | null): void {
  activeExtensionHooks = hooks;
}

export function setActiveExtensionCommands(commands: ExtensionCommandRegistry | null): void {
  activeExtensionCommands = commands;
}

export function setActiveExtensionRenderers(renderers: ExtensionRendererRegistry | null): void {
  activeExtensionRenderers = renderers;
}

export function setActiveCommandContext(context: Omit<CommandOverrideContext, "result"> | null): void {
  activeCommandContext = context;
}

export function clearActiveExtensionHooks(): void {
  activeExtensionHooks = null;
  activeExtensionCommands = null;
  activeExtensionRenderers = null;
  activeCommandContext = null;
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

export * from "./loader.js";
