/**
 * @module core/item/parent-reference-policy
 *
 * Defines item parsing, formatting, and lifecycle helpers for Parent Reference Policy.
 */
import type { ParentReferencePolicy } from "../../types/index.js";
import { normalizeItemId } from "./id.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { emptyMutationOptionMessage, sdkClearRemedy, type MutationInputAudience } from "./literal-mutation-input.js";

const PLACEHOLDER_REFERENCE_TOKENS = new Set(["none", "null", "undefined"]);

/** Implements normalize parent reference policy for the public runtime surface of this module. */
export function normalizeParentReferencePolicy(
  value: string | undefined,
): ParentReferencePolicy {
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
 * Normalize a parent reference. `audience` selects the refusal vocabulary: CLI
 * flags by default, or the SDK option and its `unset` remedy for typed callers.
 */
export function normalizeParentReferenceValue(rawValue: unknown, audience: MutationInputAudience = "cli"): string {
  const sdk = audience === "sdk";
  if (typeof rawValue !== "string") {
    throw new PmCliError(
      sdk ? `parent must be a string. ${sdkClearRemedy("parent")}.` : "--parent must be a string. Use --unset parent to clear this field.",
      EXIT_CODE.USAGE,
    );
  }
  const value = rawValue.trim();
  if (value.length === 0) {
    throw new PmCliError(emptyMutationOptionMessage(audience, "parent", ". Use --parent none to unset."), EXIT_CODE.USAGE);
  }
  if (isPlaceholderReferenceToken(value)) {
    throw new PmCliError(
      sdk
        ? `parent must not be the placeholder "${value}". ${sdkClearRemedy("parent")}, or omit parent.`
        : `--parent must not use placeholder token "${value}". Use --unset parent to clear this field.`,
      EXIT_CODE.USAGE,
    );
  }
  return value;
}

/** Detects parent-style placeholder tokens that should never become stored ids. */
export function isPlaceholderReferenceToken(value: string): boolean {
  return PLACEHOLDER_REFERENCE_TOKENS.has(value.trim().toLowerCase());
}

/** Implements validate missing parent reference for the public runtime surface of this module. */
export function validateMissingParentReference(
  parentId: string,
  policy: ParentReferencePolicy,
  audience: MutationInputAudience = "cli",
): { warnings: string[] } {
  if (policy === "strict_error") {
    throw new PmCliError(
      `Parent item "${parentId}" was not found. Create it first or ${audience === "sdk" ? "omit parent" : "use --parent none"}.`,
      EXIT_CODE.USAGE,
    );
  }
  return {
    warnings: [`validation_warning:parent_reference_missing:${parentId}`],
  };
}

/** Rejects the one-node hierarchy cycle where an item points at itself. */
export function assertParentReferenceIsNotSelf(
  itemId: string,
  parentId: string,
  prefix: string,
  audience: MutationInputAudience = "cli",
): void {
  const normalizedItemId = normalizeItemId(itemId, prefix);
  const normalizedParentId = normalizeItemId(parentId, prefix);
  if (normalizedItemId !== normalizedParentId) {
    return;
  }
  const normalizationDetail =
    parentId !== normalizedParentId || itemId !== normalizedItemId
      ? ` (normalized from parent "${parentId}" and item "${itemId}")`
      : "";
  throw new PmCliError(
    `Parent item "${normalizedParentId}" cannot be the same as item "${normalizedItemId}"${normalizationDetail}. ${audience === "sdk" ? `${sdkClearRemedy("parent")}.` : "Use --unset parent to clear this field."}`,
    EXIT_CODE.USAGE,
  );
}
