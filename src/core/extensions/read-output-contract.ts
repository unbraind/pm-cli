/**
 * @module core/extensions/read-output-contract
 * Validates package-declared read-only row paths before command activation.
 */
import { PM_TOOL_ACTIONS } from "../../sdk/cli-contracts/enum-contracts.js";
import { PM_READ_OUTPUT_SURFACES } from "../../sdk/read-output/options.js";
import type { ExtensionCommandReadOutput } from "./extension-types.js";
import { asRegistrationRecord } from "./registration-validation.js";

/** Reject malformed, ambiguous or unsafe row declarations and retain an immutable snapshot. */
export function normalizeExtensionReadOutput(value: unknown, command = "", action = ""): ExtensionCommandReadOutput | undefined {
  if (value === undefined) return undefined;
  if (isNativeExtensionOutputCommand(command) || isNativeExtensionOutputCommand(action)) throw new TypeError("Native pm commands and actions cannot declare read_output");
  const candidate = asRegistrationRecord("registerCommand definition.read_output", value);
  if (Object.keys(candidate).some((key) => key !== "row_keys") || !Array.isArray(candidate.row_keys)) {
    throw new TypeError("registerCommand definition.read_output requires only row_keys: string[]");
  }
  const paths = Array.from(candidate.row_keys);
  const reserved = new Set(["__proto__", "constructor", "prototype", "row_contract", "read_output", "read_session", "omission_receipt", "output_budget_truncation"]);
  if (paths.some((entry) => typeof entry !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/u.test(entry) || entry.split(".").some((segment: string) => reserved.has(segment)))) {
    throw new TypeError("registerCommand definition.read_output row_keys must be safe dot-delimited property paths");
  }
  if (new Set(paths).size !== paths.length || paths.some((entry) => paths.some((other) => other.startsWith(`${entry}.`)))) {
    throw new TypeError("registerCommand definition.read_output row_keys must be unique and non-overlapping");
  }
  return Object.freeze({ row_keys: Object.freeze([...paths]) });
}

/** Preserve native dispatch authority when packages declare custom read commands. */
export function isNativeExtensionOutputCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase().replace(/\s+/gu, "-");
  return PM_TOOL_ACTIONS.includes(normalized as (typeof PM_TOOL_ACTIONS)[number]) || PM_READ_OUTPUT_SURFACES.includes(normalized as (typeof PM_READ_OUTPUT_SURFACES)[number]);
}
