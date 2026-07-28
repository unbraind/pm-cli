/**
 * @module core/extensions/flag-definition-validation
 *
 * Shares extension flag spelling validation between author-time blueprint
 * preflight and runtime activation.
 */
import { RESERVED_EXTENSION_HOST_FLAG_NAMES } from "./reserved-host-flags.js";

/**
 * Long extension declaration accepted by Commander: canonical kebab names,
 * legacy underscore aliases, and an optional value placeholder.
 */
export const EXTENSION_LONG_FLAG_PATTERN =
  /^--[a-z0-9][a-z0-9_-]*(?:[ =](?:<[^<>]+>|\[[^[\]]+\]))?$/;

/** Machine-readable failure returned for one invalid extension flag token. */
export type ExtensionFlagTokenFailure =
  | "host_owned_flag_collision"
  | "malformed_long_flag";

/** Invalid token and failure classification returned for one flag definition. */
export interface ExtensionFlagTokenFinding {
  /** Trimmed long or short token that failed validation. */
  token: string;
  /** Stable failure classification shared by lint and activation. */
  failure: ExtensionFlagTokenFailure;
}

/** Describe why a declared long flag cannot be registered, or `null` when valid. */
export function validateExtensionLongFlagToken(
  value: unknown,
): ExtensionFlagTokenFailure | null {
  if (typeof value !== "string") {
    return null;
  }
  const token = value.trim();
  const hostToken = token.split(/[ =]/, 1)[0]!;
  if (RESERVED_EXTENSION_HOST_FLAG_NAMES.has(hostToken)) {
    return "host_owned_flag_collision";
  }
  return EXTENSION_LONG_FLAG_PATTERN.test(token)
    ? null
    : "malformed_long_flag";
}

/** Find the first host-owned or malformed token in one extension flag definition. */
export function findExtensionFlagTokenFailure(
  long: unknown,
  short: unknown,
): ExtensionFlagTokenFinding | null {
  const reserved = [long, short].find(
    (token) =>
      typeof token === "string" &&
      RESERVED_EXTENSION_HOST_FLAG_NAMES.has(
        token.trim().split(/[ =]/, 1)[0]!,
      ),
  );
  if (typeof reserved === "string") {
    return {
      token: reserved.trim().split(/[ =]/, 1)[0]!,
      failure: "host_owned_flag_collision",
    };
  }
  if (typeof long !== "string") {
    return null;
  }
  const token = long.trim();
  const failure = validateExtensionLongFlagToken(token);
  return failure === null ? null : { token, failure };
}

/** Render the shared actionable diagnostic used by preflight and activation. */
export function describeExtensionLongFlagFailure(
  token: string,
  failure: ExtensionFlagTokenFailure,
): string {
  return failure === "host_owned_flag_collision"
    ? `cannot shadow host-owned global flag "${token}"; read it from context.global instead`
    : `long flag "${token}" must start with a double-dash name such as "--my-flag" or "--my-flag <value>"`;
}
