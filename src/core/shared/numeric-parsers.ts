/**
 * @module core/shared/numeric-parsers
 *
 * Provides dependency-neutral numeric parsers shared by CLI and SDK surfaces.
 */
import { EXIT_CODE } from "./constants.js";
import { PmCliError } from "./errors.js";

/** Parses a non-negative numeric limit and floors fractional values. */
export function parseLimit(
  raw: string | undefined,
  label = "--limit",
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PmCliError(
      `${label} must be a non-negative number`,
      EXIT_CODE.USAGE,
    );
  }
  return Math.floor(parsed);
}
