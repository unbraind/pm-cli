/**
 * @module sdk/lifecycle/plan-mutation-receipt
 * Bounded mutation acknowledgements; full Plan state remains a separate read.
 */
import type {
  PlanCommandResult,
  PlanStepSummary,
  PlanSubcommand,
} from "./plan.js";
import type { PlanMode, PlanStepStatus } from "../../types/index.js";
import { quoteCommandArg, renderPmCommand } from "../command-line.js";

/** Stable mutation facts whose size does not grow with unrelated Plan content. */
export interface PlanMutationReceipt {
  /** Discriminator used by CLI and MCP mutation projection. */
  kind: "plan_mutation";
  /** Operation that completed successfully. */
  action: PlanSubcommand;
  /** Persisted Plan identifier. */
  id: string;
  /** Persisted item lifecycle state. */
  status: string;
  /** Persisted execution mode. */
  mode: PlanMode;
  /** Counts over the complete persisted step collection. */
  steps_summary: PlanStepSummary;
  /** Affected step identity when the operation returns a step. */
  step?: Pick<NonNullable<PlanCommandResult["step"]>, "id" | "order"> & {
    status: PlanStepStatus;
  };
  /** Number of items created by this materialization. */
  materialized_count: number;
  /** Number of already completed or materialized steps skipped. */
  skipped_count: number;
  /** Number of warnings in the full SDK result. */
  warning_count: number;
  /** Up to three warning previews, each bounded to 160 characters. */
  warnings: string[];
  /** Whether any warning content is absent from the previews. */
  warnings_truncated: boolean;
  /** First applicable next action, falling back to read-only inspection. */
  next_action: string;
  /** Read-only recovery for complete steps, evidence and resume context. */
  inspection_command: string;
  /** Explicitly declares that this acknowledgement is not complete Plan state. */
  omission_receipt: {
    /** Full Plan content is intentionally withheld. */
    has_omissions: true;
    /** Projection group count. */
    omitted_field_group_count: 1;
    /** Named omitted group and its safe read-only recovery. */
    omitted_field_groups: { name: "plan_detail"; restore_with: string }[];
  };
}

/** Project completed work; omit the root for MCP recovery in the caller's existing workspace context. */
export function buildPlanMutationReceipt(
  result: PlanCommandResult,
  pmRoot: string | undefined,
): PlanMutationReceipt {
  const inspectionCommand = renderPmCommand([
    "plan",
    "show",
    result.plan.id,
    "--depth",
    "deep",
    ...(pmRoot === undefined ? [] : ["--pm-path", pmRoot]),
  ]);
  return {
    kind: "plan_mutation",
    action: result.action,
    id: result.plan.id,
    status: result.plan.status,
    mode: result.plan.mode,
    steps_summary: result.plan.steps_summary,
    ...(result.step === undefined
      ? {}
      : {
          step: {
            id: result.step.id,
            order: result.step.order,
            status: result.step.status,
          },
        }),
    materialized_count: result.materialized?.length ?? 0,
    skipped_count: result.materialize_skipped?.length ?? 0,
    warning_count: result.warnings.length,
    warnings: result.warnings
      .slice(0, 3)
      .map(
        /** Bound each preview independently; the receipt retains the full warning count. */
        (warning) => warning.slice(0, 160),
      ),
    warnings_truncated:
      result.warnings.length > 3 ||
      result.warnings.some(
        /** Report text truncation even when all warnings fit the three-preview limit. */
        (warning) => warning.length > 160,
      ),
    next_action:
      result.next_actions?.[0] === undefined
        ? inspectionCommand
        : pmRoot === undefined
          ? result.next_actions[0]
          : `${result.next_actions[0]} --pm-path ${quoteCommandArg(pmRoot)}`,
    inspection_command: inspectionCommand,
    omission_receipt: {
      has_omissions: true,
      omitted_field_group_count: 1,
      omitted_field_groups: [
        { name: "plan_detail", restore_with: inspectionCommand },
      ],
    },
  };
}
