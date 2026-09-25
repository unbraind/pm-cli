/** @module sdk/runtime/schema-preview Prevent preview requests from reaching schema operations that cannot honor them. */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { WORKFLOW_POLICY_ACTIONS } from "../cli-contracts/enum-contracts.js";

const PREVIEW_ACTIONS = new Set<string>([
  "rename-type", "rename-field", "remap-status", ...WORKFLOW_POLICY_ACTIONS,
]);

/** Refuse unsupported preview requests before any schema mutation, across CLI and SDK/MCP dispatch. */
export function assertSchemaPreviewSupported(subcommand: string, dryRun: boolean): void {
  if (dryRun && !PREVIEW_ACTIONS.has(subcommand)) {
    throw new PmCliError(
      `schema ${subcommand} does not support --dry-run. Preview is supported for rename-type, rename-field, remap-status and workflow-policy actions. Remove --dry-run only when you intend to apply changes.`,
      EXIT_CODE.USAGE,
      { code: "invalid_argument_value", examples: ["pm schema rename-type Spike --to Experiment --dry-run"] },
    );
  }
}
