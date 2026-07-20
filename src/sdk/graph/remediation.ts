/**
 * @module sdk/graph/remediation
 *
 * Dry-run remediation planning over the relationship governance audit. The
 * planner turns bounded audit findings and transitive-redundancy evidence into
 * exact, machine-readable proposed operations — remove, retype, supersede,
 * waive, or investigate — each carrying its policy code, evidence, confidence,
 * and rationale. Planning never mutates the workspace and never invents an
 * edge: proposals with structural proof (duplicates, retired sentinels,
 * witnessed shortcuts) get actionable operations, while judgment calls stay
 * explicit `investigate` steps for a human or agent to resolve.
 */
import type { RelationshipEdge } from "../relationships.js";
import { findRedundantRelationshipEdges } from "./analytics.js";
import type { WorkspaceRelationshipAssembly } from "./assembly.js";
import {
  auditWorkspaceRelationshipGraph,
  collectDuplicateRelationshipEdgeGroups,
  formatDuplicateEdgeGroup,
  type DuplicateRelationshipEdgeGroup,
  type RelationshipAuditFinding,
  type RelationshipAuditFindingCode,
  type RelationshipAuditOptions,
  type RelationshipAuditReport,
} from "./governance.js";

/** Exact operation family a remediation step proposes; audits never auto-apply. */
export type RelationshipRemediationOperation =
  | "add"
  | "remove"
  | "retype"
  | "supersede"
  | "waive"
  | "investigate";

/** Planner confidence that applying the proposed operation is safe and correct. */
export type RelationshipRemediationConfidence = "high" | "medium" | "low";

/** Policy source a remediation step was derived from. */
export type RelationshipRemediationCode =
  | RelationshipAuditFindingCode
  | "redundant_edge";

/** One exact dry-run remediation proposal with evidence and confidence. */
export interface RelationshipRemediationStep {
  /** Proposed operation family. */
  op: RelationshipRemediationOperation;
  /** Audit finding code or `redundant_edge` for witnessed transitive shortcuts. */
  code: RelationshipRemediationCode;
  /** Compact deterministic subject — the edge, reference, or node to act on. */
  subject: string;
  /** Why this operation is proposed and what applying it means. */
  rationale: string;
  /** Deterministic evidence strings backing the proposal. */
  evidence: string[];
  /** Planner confidence in the proposal. */
  confidence: RelationshipRemediationConfidence;
}

/** Tuning inputs accepted by dry-run remediation planning. */
export interface RelationshipRemediationPlanOptions
  extends RelationshipAuditOptions {
  /** Maximum witnessed redundant edges scanned into proposals; defaults to the audit sample bound. */
  redundancyLimit?: number;
}

/** Complete deterministic result of one dry-run remediation planning pass. */
export interface RelationshipRemediationPlan {
  /** Proposed steps in audit severity order, redundancy proposals last. */
  steps: RelationshipRemediationStep[];
  /** The governance-audit report the plan was derived from. */
  report: RelationshipAuditReport;
  /** Whether bounded samples or scan limits omitted derivable proposals. */
  truncated: boolean;
  /** Nodes visited and edges inspected by the redundancy witness scan. */
  cost: { visitedNodes: number; inspectedEdges: number };
}

/** Per-finding-code operation template applied to every sampled subject. */
const FINDING_STEP_TEMPLATES: Record<
  RelationshipAuditFindingCode,
  {
    op: RelationshipRemediationOperation;
    confidence: RelationshipRemediationConfidence;
    rationale: string;
  }
> = {
  missing_reference_active: {
    op: "investigate",
    confidence: "medium",
    rationale:
      "Restore or re-create the referenced item, or remove/retype the reference on the active holder; the correct fix depends on why the target is absent.",
  },
  missing_reference_terminal: {
    op: "waive",
    confidence: "high",
    rationale:
      "Terminal-holder reference to an absent item is historical debt; waive it or clean it up only in a dedicated changelog-safe closed-item batch.",
  },
  legacy_no_blocker_sentinel: {
    op: "remove",
    confidence: "high",
    rationale:
      "The pre-structured-dependency no-active-blocker sentinel is retired and carries no information; blocker state derives from blocked_by edges.",
  },
  ordering_cycle: {
    op: "investigate",
    confidence: "low",
    rationale:
      "Every cycle member is unschedulable until one ordering edge is removed or retyped; the planner never chooses which edge to cut.",
  },
  legacy_ordering_cycle: {
    op: "waive",
    confidence: "high",
    rationale:
      "Terminal-only ordering cycles have no scheduling effect; repairing them would mutate closed history (changelog drag).",
  },
  // duplicate_edge findings are expanded into per-stored-edge remove steps by
  // the planner itself (see stepsFromDuplicateGroup); this template documents
  // the family for exhaustiveness and backs any future sample-only fallback.
  duplicate_edge: {
    op: "remove",
    confidence: "high",
    rationale:
      "Parallel same-family spellings state one relationship twice; remove all but one stored spelling, keeping the holder's canonical direction.",
  },
  legacy_duplicate_edge: {
    op: "waive",
    confidence: "high",
    rationale:
      "Duplicated spellings between terminal items are historical noise; waive or batch changelog-safe cleanup.",
  },
  duplicate_dependency_row: {
    op: "remove",
    confidence: "high",
    rationale:
      "The identical dependency row is stored more than once on the holder; drop the repeats so the row exists exactly once — graph semantics are unchanged.",
  },
  legacy_duplicate_dependency_row: {
    op: "waive",
    confidence: "high",
    rationale:
      "Repeated identical rows on terminal holders are storage noise; waive or clean up only in a changelog-safe closed-item batch.",
  },
  stale_lifecycle_block: {
    op: "investigate",
    confidence: "medium",
    rationale:
      "Re-open the missing prerequisite as an ordering edge, or move the item back to an active status; only the holder's owner knows which is true.",
  },
  isolated_active_node: {
    op: "investigate",
    confidence: "medium",
    rationale:
      "Link the item to its parent, prerequisite, or origin — or register it as an explicitly exempt isolate; the audit never fabricates an edge.",
  },
  sparse_active_node: {
    op: "investigate",
    confidence: "low",
    rationale:
      "Investigate for an honest second edge (story-to-task, defect family, cross-epic complement); sparse is not automatically defective.",
  },
};

/** Format one stored edge as a concrete removable identity. */
function formatStoredEdge(edge: RelationshipEdge): string {
  return `${edge.source} -${edge.kind}-> ${edge.target}`;
}

/**
 * Expand one active duplicate group into concrete per-stored-edge removals.
 * The deterministic keeper is the group's first sorted edge; every other
 * stored spelling gets its own remove proposal naming the exact edge to drop,
 * so the plan stays machine-executable instead of pointing at a display
 * string that spans several stored rows.
 */
function stepsFromDuplicateGroup(
  group: DuplicateRelationshipEdgeGroup,
): RelationshipRemediationStep[] {
  const [keeper, ...extras] = group.edges;
  return extras.map((edge) => ({
    op: "remove" as const,
    code: "duplicate_edge" as const,
    subject: formatStoredEdge(edge),
    rationale:
      "This stored spelling restates the kept canonical edge of the same semantic family; removing it leaves the relationship stated exactly once.",
    evidence: [
      `keep: ${formatStoredEdge(keeper!)}`,
      `group: ${formatDuplicateEdgeGroup(group)}`,
    ],
    confidence: "high" as const,
  }));
}

/** Derive one proposal per bounded sample subject of an audit finding. */
function stepsFromFinding(
  finding: RelationshipAuditFinding,
  duplicateGroups: Map<string, DuplicateRelationshipEdgeGroup>,
): RelationshipRemediationStep[] {
  if (finding.code === "duplicate_edge") {
    // Sample subjects are the deterministic group format strings, so each one
    // resolves to its concrete stored-edge group for exact removal targeting.
    return finding.sample.flatMap((subject) =>
      stepsFromDuplicateGroup(duplicateGroups.get(subject)!),
    );
  }
  const template = FINDING_STEP_TEMPLATES[finding.code];
  return finding.sample.map((subject) => ({
    op: template.op,
    code: finding.code,
    subject,
    rationale: template.rationale,
    evidence: [finding.policy],
    confidence: template.confidence,
  }));
}

/**
 * Build one deterministic dry-run remediation plan over an assembled workspace
 * relationship graph. The plan runs the shared governance audit, derives one
 * exact proposal per bounded finding subject, then appends witnessed
 * transitive-shortcut removal proposals from the redundancy scan (medium
 * confidence, because shortcut edges are sometimes deliberate emphasis).
 * `truncated` reports whether sample or scan bounds omitted derivable steps;
 * nothing is ever applied automatically.
 */
export function planRelationshipRemediation(
  assembly: WorkspaceRelationshipAssembly,
  options: RelationshipRemediationPlanOptions = {},
): RelationshipRemediationPlan {
  const { redundancyLimit, ...auditOptions } = options;
  const report = auditWorkspaceRelationshipGraph(assembly, auditOptions);
  const duplicateGroups = new Map(
    collectDuplicateRelationshipEdgeGroups(assembly).map((group) => [
      formatDuplicateEdgeGroup(group),
      group,
    ]),
  );
  const steps = report.findings.flatMap((finding) =>
    stepsFromFinding(finding, duplicateGroups),
  );
  let truncated = report.findings.some((finding) => finding.sample_truncated);
  options.signal?.throwIfAborted();
  const redundancy = findRedundantRelationshipEdges(assembly.graph, {
    limit: redundancyLimit ?? options.maxSampleSize ?? 25,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  for (const row of redundancy.value) {
    steps.push({
      op: "remove",
      code: "redundant_edge",
      subject: `${row.edge.source} -> ${row.edge.target} (${row.edge.kind})`,
      rationale:
        "The stored edge is implied by a longer same-family witness path; shortcut edges are sometimes deliberate emphasis, so confirm intent before removing.",
      evidence: [`witness: ${row.witness.join(" -> ")}`],
      confidence: "medium",
    });
  }
  truncated = truncated || redundancy.meta.truncated;
  return {
    steps,
    report,
    truncated,
    cost: {
      visitedNodes: redundancy.meta.visitedNodes,
      inspectedEdges: redundancy.meta.inspectedEdges,
    },
  };
}
