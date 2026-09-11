/**
 * @module sdk/governance/workflow-completeness
 *
 * Reduces declarative field requirements into bounded, content-free diagnostics.
 */
import { createWorkflowPolicyEvaluator, type WorkflowPolicyDocument, type WorkflowPolicyDecision } from "../../core/policy/workflow-policy.js";
import { readWorkflowPolicies } from "../../core/policy/workflow-policy-store.js";
import type { ValidateCheck } from "./validate.js";

/** One item-policy violation, retaining field paths but never field values. */
export interface WorkflowCompletenessViolation {
  /** Stable item identifier. */
  id: string;
  /** Runtime item type. */
  type: string;
  /** Lifecycle status evaluated. */
  status: string;
  /** Exact rule and missing-field evidence. */
  decision: WorkflowPolicyDecision;
}

/** Load the policy snapshot while containing storage failures in an error check so other validation can continue. */
export async function readWorkflowCompletenessCheck(
  pmRoot: string,
  items: Parameters<typeof buildWorkflowCompletenessCheck>[1],
  rowLimit?: number,
  sourceIncomplete?: boolean,
): Promise<{ check: ValidateCheck; warnings: string[] }> {
  const document = await readWorkflowPolicies(pmRoot).catch(() => null);
  if (document === null) return {
    check: { name: "completeness", status: "error", ok: false, details: {
      policy_registry_readable: false,
      policy_registry_path: "schema/policies.json",
      remediation_hint: "Repair schema/policies.json, then rerun pm validate.",
    } },
    warnings: ["validate_completeness_policy_registry_unreadable"],
  };
  return buildWorkflowCompletenessCheck(document, items, rowLimit, sourceIncomplete);
}

/** Classify contract applicability separately from evidence compliance. */
function completenessContractStatus(requirements: number, items: number, governed: number): string {
  if (requirements === 0) return "undeclared";
  if (items === 0) return "empty";
  if (governed === 0) return "inapplicable";
  return governed === items ? "covered" : "partial";
}

/** Evaluate every supplied item while bounding the diagnostic rows independently. */
export function buildWorkflowCompletenessCheck(
  document: WorkflowPolicyDocument,
  items: readonly (Readonly<Record<string, unknown>> & { id: string; type: string; status: string })[],
  rowLimit = 5,
  sourceIncomplete = false,
): { check: ValidateCheck; warnings: string[] } {
  const violations: WorkflowCompletenessViolation[] = [];
  const byType = new Map<string, { items: number; violations: number; missing_fields: number }>();
  const requirements = document.policies.filter((policy) => policy.rule.kind === "require_fields");
  const stateRequirements = requirements.filter((policy) => policy.subject?.operations === undefined);
  const appliedPolicyIds = new Set<string>();
  let governedItems = 0;
  let requirementApplications = 0;
  let violationCount = 0;
  let incompleteItems = 0;
  let refused = 0;
  const evaluate = createWorkflowPolicyEvaluator(document);
  for (const item of items) {
    const evaluation = evaluate({
      operation: "", author: "", before: item, after: item, completeness_only: true,
    });
    governedItems += Number(evaluation.decisions.length > 0);
    requirementApplications += evaluation.decisions.length;
    evaluation.decisions.forEach((decision) => appliedPolicyIds.add(decision.policy_id));
    const missing = evaluation.decisions.filter((decision) => !decision.satisfied);
    if (missing.length === 0) continue;
    incompleteItems += 1;
    const bucket = byType.get(item.type) ?? { items: 0, violations: 0, missing_fields: 0 };
    bucket.items += 1;
    for (const decision of missing) {
      violationCount += 1;
      bucket.violations += 1;
      bucket.missing_fields += decision.missing_fields.length;
      if (decision.effect === "refuse") refused += 1;
      if (violations.length < rowLimit) violations.push({ id: item.id, type: item.type, status: item.status, decision });
    }
    byType.set(item.type, bucket);
  }
  const status = sourceIncomplete || refused > 0 ? "error" : violationCount > 0 ? "warn" : "ok";
  return {
    check: { name: "completeness", status, ok: status === "ok", details: {
      scope: "operation_independent_require_fields",
      declared_requirement_count: requirements.length,
      state_requirement_count: stateRequirements.length,
      applicable_requirement_count: appliedPolicyIds.size,
      requirement_application_count: requirementApplications,
      governed_items: governedItems, ungoverned_items: items.length - governedItems,
      contract_status: completenessContractStatus(requirements.length, items.length, governedItems),
      applied_policy_ids: [...appliedPolicyIds].sort().slice(0, Math.max(0, rowLimit)),
      applied_policy_ids_truncated: appliedPolicyIds.size > Math.max(0, rowLimit),
      checked_items: items.length, incomplete_items: incompleteItems, violation_count: violationCount,
      refused_violations: refused, missing_by_type: Object.fromEntries(byType),
      violations, violations_truncated: violations.length < violationCount,
      enforcement: document.enforcement,
    } },
    warnings: [
      ...(violationCount > 0 ? [`validate_completeness_missing_fields:${violationCount}`] : []),
      ...(sourceIncomplete ? ["validate_completeness_source_incomplete"] : []),
    ],
  };
}
