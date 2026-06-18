/**
 * @module core/item/parent-reference-policy
 *
 * Defines item parsing, formatting, and lifecycle helpers for Parent Reference Policy.
 */
import type { ParentReferencePolicy } from "../../types/index.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";

/**
 * Implements normalize parent reference policy for the public runtime surface of this module.
 */
export function normalizeParentReferencePolicy(value: string | undefined): ParentReferencePolicy {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "warn" || normalized === "strict_error") {
    return normalized;
  }
  if (normalized === "strict") {
    return "strict_error";
  }
  throw new PmCliError(
    "Config set parent-reference-policy requires --policy with one of: warn, strict_error (alias: strict)",
    EXIT_CODE.USAGE,
  );
}

/**
 * Implements normalize parent reference value for the public runtime surface of this module.
 */
export function normalizeParentReferenceValue(rawValue: string): string {
  const value = rawValue.trim();
  if (value.length === 0) {
    throw new PmCliError("--parent must not be empty. Use --parent none to unset.", EXIT_CODE.USAGE);
  }
  const normalized = value.toLowerCase();
  if (normalized === "none" || normalized === "null" || normalized === "undefined") {
    throw new PmCliError(
      `--parent must not use placeholder token "${value}". Use --unset parent to clear this field.`,
      EXIT_CODE.USAGE,
    );
  }
  return value;
}

/**
 * Implements validate missing parent reference for the public runtime surface of this module.
 */
export function validateMissingParentReference(
  parentId: string,
  policy: ParentReferencePolicy,
): { warnings: string[] } {
  if (policy === "strict_error") {
    throw new PmCliError(
      `Parent item "${parentId}" was not found. Create it first or use --parent none.`,
      EXIT_CODE.USAGE,
    );
  }
  return {
    warnings: [`validation_warning:parent_reference_missing:${parentId}`],
  };
}
