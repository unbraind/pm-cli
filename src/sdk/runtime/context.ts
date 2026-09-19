/**
 * @module sdk/runtime/context
 * Defines internal action context and required argument validation.
 */
import {
  activateExtensions
} from "../../core/extensions/index.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  type PmContextIntentPackageModule
} from "../context-intent-runtime.js";
import {
  readRuntimeString as readString
} from "../runtime-input.js";

/** Read a required non-empty string from an action argument bag. */
export function readRequiredString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = readString(args, key);
  if (!value) {
    throw new PmCliError(`Missing required argument: ${key}`, 64);
  }
  return value;
}

/** Resolved extension activation result used by the request-local runtime context. */
type ExtensionActivationResult = Awaited<ReturnType<typeof activateExtensions>>;

/**
 * The active extension runtime exposed to an action while it executes: the merged
 * registration registry (custom item types, fields, profiles) plus the command handler
 * registry used to dispatch extension-contributed actions. `null` when extensions are
 * disabled, no workspace exists yet, or activation failed (see {@link withActiveExtensions}).
 */
type ActiveExtensionRuntime = {
  registrations: ExtensionActivationResult["registrations"];
  commands: ExtensionActivationResult["commands"];
  pmRoot: string;
  packages: readonly PmContextIntentPackageModule[];
};

/** Normalized action arguments and active runtime state passed to a built-in handler. */
interface McpActionDispatchContext {
  action: string;
  args: Record<string, unknown>;
  options: Record<string, unknown>;
  id: string | undefined;
  force: boolean;
  global: GlobalOptions;
  activeExtensions: ActiveExtensionRuntime | null;
}

/** Built-in action handler returning a value or asynchronous result before read projection. */
type McpActionHandler = (
  ctx: McpActionDispatchContext,
) => Promise<unknown> | unknown;

/** Look up only an own registry entry so inherited object properties cannot become actions. */
function getOwnHandler<T>(
  handlers: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.prototype.hasOwnProperty.call(handlers, key)
    ? handlers[key]
    : undefined;
}

export { ActiveExtensionRuntime,ExtensionActivationResult,McpActionDispatchContext,McpActionHandler,getOwnHandler };
