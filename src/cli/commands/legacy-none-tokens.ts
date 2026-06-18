/**
 * @module cli/commands/legacy-none-tokens
 *
 * Implements the pm legacy none tokens command surface and its agent-facing runtime behavior.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";

/**
 * Shared legacy "none"/"null" sentinel handling for the create and update
 * commands. These tokens used to mean "clear this field"; they are now
 * rejected in favour of explicit --unset / --clear-* flags.
 *
 * Extracted verbatim from create.ts and update.ts (pm-why9) — behaviour and
 * error strings are identical to the previous per-command copies.
 */
const LEGACY_NONE_TOKENS = new Set(["none", "null"]);

/**
 * Implements check whether legacy none token for the public runtime surface of this module.
 */
export function isLegacyNoneToken(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return LEGACY_NONE_TOKENS.has(value.trim().toLowerCase());
}

/**
 * Implements assert no legacy none token for the public runtime surface of this module.
 */
export function assertNoLegacyNoneToken(value: string | undefined, flag: string, replacementHint?: string): void {
  if (!isLegacyNoneToken(value)) {
    return;
  }
  const suffix = replacementHint ? ` ${replacementHint}` : "";
  throw new PmCliError(`${flag} no longer accepts "none" or "null".${suffix}`.trim(), EXIT_CODE.USAGE);
}

/**
 * Implements assert no legacy none tokens for the public runtime surface of this module.
 */
export function assertNoLegacyNoneTokens(values: string[] | undefined, flag: string, replacementHint?: string): void {
  if (!values || values.length === 0) {
    return;
  }
  const hasLegacyToken = values.some((value) => isLegacyNoneToken(value));
  if (!hasLegacyToken) {
    return;
  }
  const suffix = replacementHint ? ` ${replacementHint}` : "";
  throw new PmCliError(`${flag} no longer accepts "none" or "null".${suffix}`.trim(), EXIT_CODE.USAGE);
}
