/**
 * @module sdk/governance/validate-normalization
 *
 * Provides shared path and meaningful-value normalization for validation
 * diagnostics without coupling the helpers to the command orchestration.
 */
import { toNonEmptyStringOrUndefined } from "../../core/shared/primitives.js";

/** Normalize a repository-relative path to stable forward-slash form. */
export function normalizeRelativePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

/** Normalize a repository-relative directory without trailing separators. */
export function normalizeRelativeDirectoryPath(value: string): string {
  return normalizeRelativePath(value).replace(/\/+$/, "");
}

/** Treat blank and legacy null-like metadata tokens as absent values. */
export function toMeaningfulString(value: unknown): string | undefined {
  const normalized = toNonEmptyStringOrUndefined(value);
  if (!normalized) {
    return undefined;
  }
  const lowered = normalized.toLowerCase();
  if (
    lowered === "none" ||
    lowered === "null" ||
    lowered === "n/a" ||
    lowered === "na"
  ) {
    return undefined;
  }
  return normalized;
}
