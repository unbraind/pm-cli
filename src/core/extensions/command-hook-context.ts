/**
 * @module core/extensions/command-hook-context
 *
 * Builds invocation context shared by extension hooks and derived command
 * feedback, including core-only runs where no extensions are installed.
 */
import type { GlobalOptions } from "../shared/command-types.js";
import { createEmptyExtensionHookRegistry } from "./extension-registries.js";
import type { ExtensionHookRegistry } from "./loader.js";

/** Runtime state consumed after a command finishes. */
export interface ActiveExtensionHookContext<TMigrationBlocker> {
  /** Active extension hooks, empty for a core-only invocation. */
  hooks: ExtensionHookRegistry;
  /** Canonical dotted command path. */
  commandName: string;
  /** Positional command arguments after parser overrides. */
  commandArgs: string[];
  /** Command-scoped options after parser overrides. */
  commandOptions: Record<string, unknown>;
  /** Global options after parser overrides. */
  globalOptions: GlobalOptions;
  /** Tracker root for hooks and derived feedback. */
  pmRoot: string;
  /** Whether profile diagnostics should be rendered. */
  profileEnabled: boolean;
  /** Mandatory extension migrations that remain unresolved. */
  migrationBlockers: TMigrationBlocker[];
}

/** Creates post-command runtime state for an invocation without extensions. */
export function createCoreCommandHookContext(options: {
  /** Canonical dotted command path. */
  commandName: string;
  /** Positional command arguments. */
  commandArgs: string[];
  /** Command-scoped options. */
  commandOptions: Record<string, unknown>;
  /** Parsed global options. */
  globalOptions: GlobalOptions;
  /** Resolved tracker root. */
  pmRoot: string;
}): ActiveExtensionHookContext<never> {
  return {
    ...options,
    hooks: createEmptyExtensionHookRegistry(),
    profileEnabled: Boolean(options.globalOptions.profile),
    migrationBlockers: [],
  };
}
