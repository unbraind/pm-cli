import type { GlobalOptions } from "../shared/command-types.js";

export function normalizeCommandName(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

export function defaultGlobalOptions(): GlobalOptions {
  return {
    json: false,
    quiet: false,
    noExtensions: false,
    profile: false,
  };
}

export function cloneCommandOptionsSnapshot(options: Record<string, unknown> | undefined): Record<string, unknown> {
  return options ? cloneContextSnapshot(options) : {};
}

export function cloneGlobalOptionsSnapshot(options: GlobalOptions | undefined): GlobalOptions {
  return options ? cloneContextSnapshot(options) : defaultGlobalOptions();
}

export function cloneContextSnapshot<T>(value: T): T {
  return structuredClone(value);
}
