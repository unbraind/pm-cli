/**
 * @module core/extensions/extension-hook-runtime
 *
 * Implements extension runtime contracts and governance for Extension Hook Runtime.
 */
import {
  cloneCommandOptionsSnapshot,
  cloneContextSnapshot,
  cloneGlobalOptionsSnapshot,
  normalizeCommandName,
} from "./extension-runtime-helpers.js";
import type {
  RegisteredExtensionHook,
  ExtensionHookRegistry,
  BeforeCommandHookContext,
  AfterCommandHookContext,
  OnWriteHookContext,
  OnReadHookContext,
  OnIndexHookContext,
  ExtensionCommandRegistry,
  CommandHandlerContext,
  CommandHandlerResult,
  ExtensionParserRegistry,
  ParserOverrideContext,
  ParserOverrideResult,
  ExtensionPreflightRegistry,
  PreflightOverrideContext,
  PreflightOverrideResult,
  PreflightRuntimeDecision,
  ExtensionServiceRegistry,
  ServiceOverrideContext,
  ServiceOverrideResult,
  CommandOverrideContext,
  CommandOverrideResult,
  ExtensionRendererRegistry,
  RendererOverrideContext,
  RendererOverrideResult,
} from "./extension-types.js";

type HookName = keyof ExtensionHookRegistry;

async function executeRegisteredHooks<TContext>(
  entries: Array<
    RegisteredExtensionHook<(context: TContext) => Promise<void> | void>
  >,
  hookName: HookName,
  context: TContext,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of entries) {
    try {
      await entry.run(cloneContextSnapshot(context));
    } catch {
      warnings.push(
        `extension_hook_failed:${entry.layer}:${entry.name}:${hookName}`,
      );
    }
  }
  return warnings;
}

/** Implements run before command hooks for the public runtime surface of this module. */
export async function runBeforeCommandHooks(
  hooks: ExtensionHookRegistry,
  context: BeforeCommandHookContext,
): Promise<string[]> {
  return executeRegisteredHooks(hooks.beforeCommand, "beforeCommand", context);
}

/** Implements run after command hooks for the public runtime surface of this module. */
export async function runAfterCommandHooks(
  hooks: ExtensionHookRegistry,
  context: AfterCommandHookContext,
): Promise<string[]> {
  return executeRegisteredHooks(hooks.afterCommand, "afterCommand", context);
}

/** Implements run on write hooks for the public runtime surface of this module. */
export async function runOnWriteHooks(
  hooks: ExtensionHookRegistry,
  context: OnWriteHookContext,
): Promise<string[]> {
  return executeRegisteredHooks(hooks.onWrite, "onWrite", context);
}

/** Implements run on read hooks for the public runtime surface of this module. */
export async function runOnReadHooks(
  hooks: ExtensionHookRegistry,
  context: OnReadHookContext,
): Promise<string[]> {
  return executeRegisteredHooks(hooks.onRead, "onRead", context);
}

/** Implements run on index hooks for the public runtime surface of this module. */
export async function runOnIndexHooks(
  hooks: ExtensionHookRegistry,
  context: OnIndexHookContext,
): Promise<string[]> {
  return executeRegisteredHooks(hooks.onIndex, "onIndex", context);
}

/** Normalize an extension handler failure into a single-line, length-bounded message so the real cause can be surfaced to the user/CI without leaking multi-line stack noise or unbounded payloads. */
function describeHandlerError(error: unknown): string {
  let raw = "";
  if (error instanceof Error && typeof error.message === "string") {
    raw = error.message;
  } else if (typeof error === "string") {
    raw = error;
  } else if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    // Extensions may throw plain/serialized objects that carry a message but do
    // not inherit from the base Error class.
    raw = (error as { message: string }).message;
  }
  const normalized = raw.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return "";
  }
  const maxLength = 300;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

/** Implements run command handler for the public runtime surface of this module. */
export async function runCommandHandler(
  commands: ExtensionCommandRegistry,
  context: CommandHandlerContext,
): Promise<CommandHandlerResult> {
  const command = normalizeCommandName(context.command);
  if (command.length === 0) {
    return {
      handled: false,
      result: null,
      warnings: [],
    };
  }

  const matched = [...commands.handlers]
    .reverse()
    .find((entry) => entry.command === command);
  if (!matched) {
    return {
      handled: false,
      result: null,
      warnings: [],
    };
  }

  try {
    const result = await matched.run({
      command,
      args: cloneContextSnapshot(context.args),
      options: cloneContextSnapshot(context.options),
      global: cloneContextSnapshot(context.global),
      pm_root: context.pm_root,
    });
    return {
      handled: true,
      result,
      warnings: [],
    };
  } catch (error: unknown) {
    const exitCode =
      typeof error === "object" && error !== null && "exitCode" in error
        ? (error as { exitCode?: unknown }).exitCode
        : undefined;
    if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
      throw error;
    }
    return {
      handled: false,
      result: null,
      warnings: [
        `extension_command_handler_failed:${matched.layer}:${matched.name}:${matched.command}`,
      ],
      errorMessage: describeHandlerError(error),
    };
  }
}

/** Implements run parser override for the public runtime surface of this module. */
export async function runParserOverride(
  parsers: ExtensionParserRegistry,
  context: ParserOverrideContext,
): Promise<ParserOverrideResult> {
  const command = normalizeCommandName(context.command);
  if (command.length === 0) {
    return {
      overridden: false,
      context: {
        command,
        args: cloneContextSnapshot(context.args),
        options: cloneCommandOptionsSnapshot(context.options),
        global: cloneGlobalOptionsSnapshot(context.global),
        pm_root: context.pm_root,
      },
      warnings: [],
    };
  }

  const matched = [...parsers.overrides]
    .reverse()
    .find((entry) => entry.command === command);
  if (!matched) {
    return {
      overridden: false,
      context: {
        command,
        args: cloneContextSnapshot(context.args),
        options: cloneCommandOptionsSnapshot(context.options),
        global: cloneGlobalOptionsSnapshot(context.global),
        pm_root: context.pm_root,
      },
      warnings: [],
    };
  }

  try {
    const delta =
      (await Promise.resolve(
        matched.run({
          command,
          args: cloneContextSnapshot(context.args),
          options: cloneCommandOptionsSnapshot(context.options),
          global: cloneGlobalOptionsSnapshot(context.global),
          pm_root: context.pm_root,
        }),
      )) ?? {};
    const nextArgs = Array.isArray(delta.args)
      ? cloneContextSnapshot(delta.args)
      : cloneContextSnapshot(context.args);
    const nextOptions = delta.options
      ? cloneCommandOptionsSnapshot(delta.options)
      : cloneCommandOptionsSnapshot(context.options);
    const nextGlobal = delta.global
      ? cloneGlobalOptionsSnapshot(delta.global)
      : cloneGlobalOptionsSnapshot(context.global);
    return {
      overridden: true,
      context: {
        command,
        args: nextArgs,
        options: nextOptions,
        global: nextGlobal,
        pm_root: context.pm_root,
      },
      warnings: [],
    };
  } catch {
    return {
      overridden: false,
      context: {
        command,
        args: cloneContextSnapshot(context.args),
        options: cloneCommandOptionsSnapshot(context.options),
        global: cloneGlobalOptionsSnapshot(context.global),
        pm_root: context.pm_root,
      },
      warnings: [
        `extension_parser_override_failed:${matched.layer}:${matched.name}:${matched.command}`,
      ],
    };
  }
}

/** Implements run preflight override for the public runtime surface of this module. */
export async function runPreflightOverride(
  preflight: ExtensionPreflightRegistry,
  context: PreflightOverrideContext,
): Promise<PreflightOverrideResult> {
  const matched = [...preflight.overrides].reverse()[0];
  const baseContext: CommandHandlerContext = {
    command: normalizeCommandName(context.command),
    args: cloneContextSnapshot(context.args),
    options: cloneCommandOptionsSnapshot(context.options),
    global: cloneGlobalOptionsSnapshot(context.global),
    pm_root: context.pm_root,
  };
  const baseDecision: PreflightRuntimeDecision = cloneContextSnapshot(
    context.decision,
  );
  if (!matched) {
    return {
      overridden: false,
      context: baseContext,
      decision: baseDecision,
      warnings: [],
    };
  }

  try {
    const delta =
      (await Promise.resolve(
        matched.run({
          command: baseContext.command,
          args: cloneContextSnapshot(baseContext.args),
          options: cloneCommandOptionsSnapshot(baseContext.options),
          global: cloneGlobalOptionsSnapshot(baseContext.global),
          pm_root: baseContext.pm_root,
          decision: cloneContextSnapshot(baseDecision),
        }),
      )) ?? {};
    const nextContext: CommandHandlerContext = {
      command: baseContext.command,
      args: Array.isArray(delta.args)
        ? cloneContextSnapshot(delta.args)
        : baseContext.args,
      options: delta.options
        ? cloneCommandOptionsSnapshot(delta.options)
        : baseContext.options,
      global: delta.global
        ? cloneGlobalOptionsSnapshot(delta.global)
        : baseContext.global,
      pm_root: baseContext.pm_root,
    };
    const nextDecision: PreflightRuntimeDecision = {
      enforce_item_format_gate:
        typeof delta.enforce_item_format_gate === "boolean"
          ? delta.enforce_item_format_gate
          : baseDecision.enforce_item_format_gate,
      run_preflight_item_format_sync:
        typeof delta.run_preflight_item_format_sync === "boolean"
          ? delta.run_preflight_item_format_sync
          : baseDecision.run_preflight_item_format_sync,
      run_extension_migrations:
        typeof delta.run_extension_migrations === "boolean"
          ? delta.run_extension_migrations
          : baseDecision.run_extension_migrations,
      enforce_mandatory_migration_gate:
        typeof delta.enforce_mandatory_migration_gate === "boolean"
          ? delta.enforce_mandatory_migration_gate
          : baseDecision.enforce_mandatory_migration_gate,
    };
    return {
      overridden: true,
      context: nextContext,
      decision: nextDecision,
      warnings: [],
    };
  } catch {
    return {
      overridden: false,
      context: baseContext,
      decision: baseDecision,
      warnings: [
        `extension_preflight_override_failed:${matched.layer}:${matched.name}`,
      ],
    };
  }
}

function resolveDefaultServiceResult(
  context: ServiceOverrideContext,
): ServiceOverrideResult {
  return {
    handled: false,
    result: context.payload,
    warnings: [],
  };
}

function matchingServiceOverrides(
  services: ExtensionServiceRegistry,
  service: ServiceOverrideContext["service"],
) {
  return [...services.overrides]
    .reverse()
    .filter((entry) => entry.service === service);
}

function buildServiceOverrideContext(context: ServiceOverrideContext) {
  return {
    service: context.service,
    command: context.command
      ? normalizeCommandName(context.command)
      : undefined,
    args: context.args ? cloneContextSnapshot(context.args) : undefined,
    options: context.options
      ? cloneCommandOptionsSnapshot(context.options)
      : undefined,
    global: context.global
      ? cloneGlobalOptionsSnapshot(context.global)
      : undefined,
    pm_root: context.pm_root,
    payload: cloneContextSnapshot(context.payload),
  };
}

/** Implements run service override sync for the public runtime surface of this module. */
export function runServiceOverrideSync(
  services: ExtensionServiceRegistry,
  context: ServiceOverrideContext,
): ServiceOverrideResult {
  const matches = matchingServiceOverrides(services, context.service);
  if (matches.length === 0) {
    return resolveDefaultServiceResult(context);
  }

  const warnings: string[] = [];
  for (const matched of matches) {
    try {
      const serviceContext = buildServiceOverrideContext(context);
      const result = matched.run(serviceContext);
      if (result instanceof Promise) {
        warnings.push(
          `extension_service_override_async_unsupported:${matched.layer}:${matched.name}:${matched.service}`,
        );
        continue;
      }
      if (
        context.service === "output_format" &&
        (result === null ||
          result === undefined ||
          result === serviceContext.payload)
      ) {
        continue;
      }
      return {
        handled: true,
        result,
        warnings,
      };
    } catch {
      warnings.push(
        `extension_service_override_failed:${matched.layer}:${matched.name}:${matched.service}`,
      );
    }
  }
  return {
    handled: false,
    result: context.payload,
    warnings,
  };
}

/** Implements run service override for the public runtime surface of this module. */
export async function runServiceOverride(
  services: ExtensionServiceRegistry,
  context: ServiceOverrideContext,
): Promise<ServiceOverrideResult> {
  const matches = matchingServiceOverrides(services, context.service);
  if (matches.length === 0) {
    return resolveDefaultServiceResult(context);
  }

  const warnings: string[] = [];
  for (const matched of matches) {
    try {
      const serviceContext = buildServiceOverrideContext(context);
      const result = await Promise.resolve(matched.run(serviceContext));
      if (
        context.service === "output_format" &&
        (result === null ||
          result === undefined ||
          result === serviceContext.payload)
      ) {
        continue;
      }
      return {
        handled: true,
        result,
        warnings,
      };
    } catch {
      warnings.push(
        `extension_service_override_failed:${matched.layer}:${matched.name}:${matched.service}`,
      );
    }
  }
  return {
    handled: false,
    result: context.payload,
    warnings,
  };
}

/** Implements run command override for the public runtime surface of this module. */
export function runCommandOverride(
  commands: ExtensionCommandRegistry,
  context: CommandOverrideContext,
): CommandOverrideResult {
  const command = normalizeCommandName(context.command);
  if (command.length === 0) {
    return {
      overridden: false,
      result: context.result,
      warnings: [],
    };
  }

  const matched = [...commands.overrides]
    .reverse()
    .find((entry) => entry.command === command);
  if (!matched) {
    return {
      overridden: false,
      result: context.result,
      warnings: [],
    };
  }

  try {
    const overrideOptions = cloneCommandOptionsSnapshot(context.options);
    const overrideGlobal = cloneGlobalOptionsSnapshot(context.global);
    const overrideResult = matched.run({
      command,
      args: cloneContextSnapshot(context.args),
      options: overrideOptions,
      global: overrideGlobal,
      pm_root: context.pm_root,
      result: cloneContextSnapshot(context.result),
    });
    if (overrideResult instanceof Promise) {
      return {
        overridden: false,
        result: context.result,
        warnings: [
          `extension_command_override_async_unsupported:${matched.layer}:${matched.name}:${matched.command}`,
        ],
      };
    }
    return {
      overridden: true,
      result: overrideResult,
      warnings: [],
    };
  } catch {
    return {
      overridden: false,
      result: context.result,
      warnings: [
        `extension_command_override_failed:${matched.layer}:${matched.name}:${matched.command}`,
      ],
    };
  }
}

/** Implements run renderer override for the public runtime surface of this module. */
export function runRendererOverride(
  renderers: ExtensionRendererRegistry,
  context: RendererOverrideContext,
): RendererOverrideResult {
  const matched = [...renderers.overrides]
    .reverse()
    .find((entry) => entry.format === context.format);
  if (!matched) {
    return {
      overridden: false,
      rendered: null,
      warnings: [],
    };
  }

  try {
    const rendererCommand =
      typeof context.command === "string"
        ? normalizeCommandName(context.command)
        : "";
    const rendererArgs = Array.isArray(context.args)
      ? cloneContextSnapshot(context.args)
      : [];
    const rendererOptions = cloneCommandOptionsSnapshot(context.options);
    const rendererGlobal = cloneGlobalOptionsSnapshot(context.global);
    const rendererPmRoot =
      typeof context.pm_root === "string" ? context.pm_root : "";
    const rendered = matched.run({
      format: context.format,
      command: rendererCommand,
      args: rendererArgs,
      options: rendererOptions,
      global: rendererGlobal,
      pm_root: rendererPmRoot,
      result: cloneContextSnapshot(context.result),
    });
    if (rendered === null || rendered === undefined) {
      return {
        overridden: false,
        rendered: null,
        warnings: [],
      };
    }
    if (typeof rendered !== "string") {
      return {
        overridden: false,
        rendered: null,
        warnings: [
          `extension_renderer_invalid_result:${matched.layer}:${matched.name}:${matched.format}`,
        ],
      };
    }
    return {
      overridden: true,
      rendered,
      warnings: [],
    };
  } catch {
    return {
      overridden: false,
      rendered: null,
      warnings: [
        `extension_renderer_failed:${matched.layer}:${matched.name}:${matched.format}`,
      ],
    };
  }
}
