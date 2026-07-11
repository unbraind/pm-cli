/**
 * @module core/extensions/extension-runtime-helpers
 *
 * Implements extension runtime contracts and governance for Extension Runtime Helpers.
 */
import type { GlobalOptions } from "../shared/command-types.js";

/** Implements normalize command name for the public runtime surface of this module. */
export function normalizeCommandName(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

/** Implements default global options for the public runtime surface of this module. */
export function defaultGlobalOptions(): GlobalOptions {
  return {
    json: false,
    quiet: false,
    noExtensions: false,
    profile: false,
  };
}

/** Implements clone command options snapshot for the public runtime surface of this module. */
export function cloneCommandOptionsSnapshot(
  options: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return options ? cloneContextSnapshot(options) : {};
}

/** Implements clone global options snapshot for the public runtime surface of this module. */
export function cloneGlobalOptionsSnapshot(
  options: GlobalOptions | undefined,
): GlobalOptions {
  return options ? cloneContextSnapshot(options) : defaultGlobalOptions();
}

/** Implements clone context snapshot for the public runtime surface of this module. */
export function cloneContextSnapshot<T>(value: T): T {
  return structuredClone(value);
}
