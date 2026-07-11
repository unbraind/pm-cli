/**
 * @module cli/shared-parsers
 *
 * Provides CLI runtime support for Shared Parsers.
 */
import { PmCliError } from "../core/shared/errors.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import {
  resolveTypeName,
  type ItemTypeRegistry,
} from "../core/item/type-registry.js";
import type { ItemType } from "../types/index.js";

/** Implements parse limit for the public runtime surface of this module. */
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

/** Implements parse integer limit for the public runtime surface of this module. */
export function parseIntegerLimit(
  raw: string | undefined,
  label = "--limit",
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError(
      `${label} must be a non-negative integer`,
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
}

/** Implements parse priority for the public runtime surface of this module. */
export function parsePriority(
  raw: string | undefined,
  label = "--priority",
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) {
    throw new PmCliError(`${label} filter must be 0..4`, EXIT_CODE.USAGE);
  }
  return parsed;
}

/** Implements parse type for the public runtime surface of this module. */
export function parseType(
  raw: string | undefined,
  typeRegistry: ItemTypeRegistry,
  label = "--type",
): ItemType | undefined {
  if (raw === undefined) return undefined;
  const parsed = resolveTypeName(raw, typeRegistry);
  if (!parsed) {
    throw new PmCliError(
      `${label} filter must be one of ${typeRegistry.types.join("|")}`,
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
}
