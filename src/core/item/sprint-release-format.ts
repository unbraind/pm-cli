import type { SprintReleaseFormatPolicy } from "../../types/index.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";

const SPRINT_RELEASE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SPRINT_RELEASE_MAX_LENGTH = 64;

export function normalizeSprintReleaseFormatPolicy(value: string | undefined): SprintReleaseFormatPolicy {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "warn" || normalized === "strict_error") {
    return normalized;
  }
  if (normalized === "strict") {
    return "strict_error";
  }
  throw new PmCliError(
    "Config set sprint-release-format-policy requires --policy with one of: warn, strict_error (alias: strict)",
    EXIT_CODE.USAGE,
  );
}

export function validateSprintOrReleaseValue(
  field: "sprint" | "release",
  rawValue: string,
  policy: SprintReleaseFormatPolicy,
): { value: string; warnings: string[] } {
  const value = rawValue.trim();
  if (value.length === 0) {
    throw new PmCliError(`--${field} must not be empty. Use --${field} none to unset.`, EXIT_CODE.USAGE);
  }
  const isValid = value.length <= SPRINT_RELEASE_MAX_LENGTH && SPRINT_RELEASE_VALUE_PATTERN.test(value);
  if (isValid) {
    return { value, warnings: [] };
  }
  const guidance = "Expected 1-64 characters matching [A-Za-z0-9][A-Za-z0-9._/-]* (no spaces).";
  if (policy === "strict_error") {
    throw new PmCliError(`Invalid --${field} value "${value}". ${guidance}`, EXIT_CODE.USAGE);
  }
  return {
    value,
    warnings: [`validation_warning:${field}_format:${value}`],
  };
}
