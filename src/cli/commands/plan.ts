/**
 * @module cli/commands/plan
 *
 * Implements the pm plan command surface and its agent-facing runtime behavior.
 */
import {
  pathExists,
  getActiveExtensionRegistrations,
  resolveItemTypeRegistry,
  resolveTypeName,
  EXIT_CODE,
  type GlobalOptions,
  PmCliError,
  splitCommaList,
  nowIso,
  locateItem,
  mutateItem,
  readLocatedItem,
  getSettingsPath,
  resolvePmRoot,
  readSettings,
} from "../../sdk/runtime-primitives.js";
import type {
  DependencyKind,
  ItemDocument,
  ItemMetadata,
  PlanDecision,
  PlanDiscovery,
  PlanHarness,
  PlanMode,
  PlanStep,
  PlanStepDoc,
  PlanStepFile,
  PlanStepLink,
  PlanStepLinkKind,
  PlanStepStatus,
  PlanStepTest,
  PlanValidationCheck,
} from "../../types/index.js";
import {
  PLAN_HARNESS_VALUES,
  PLAN_MODE_VALUES,
  PLAN_STEP_LINK_KIND_VALUES,
  PLAN_STEP_STATUS_VALUES,
} from "../../types/index.js";
import {
  runCreate,
  type CreateCommandOptions,
  type CreateResult,
} from "./create.js";
import type {
  MutationMetadataCommandOptions,
  SharedLinkedResourceOptions,
} from "./mutation-command-options.js";

/** Public contract for plan subcommands, shared by SDK and presentation-layer consumers. */
export const PLAN_SUBCOMMANDS = [
  "create",
  "show",
  "add-step",
  "update-step",
  "complete-step",
  "block-step",
  "reorder-step",
  "remove-step",
  "link",
  "unlink",
  "decision",
  "discovery",
  "validation",
  "resume",
  "approve",
  "materialize",
] as const;
/** Restricts plan subcommand values accepted by command, SDK, and storage contracts. */
export type PlanSubcommand = (typeof PLAN_SUBCOMMANDS)[number];

/** Supported values accepted by the plan show depth contract. */
export const PLAN_SHOW_DEPTH_VALUES = ["brief", "standard", "deep"] as const;
/** Restricts plan show depth values accepted by command, SDK, and storage contracts. */
export type PlanShowDepth = (typeof PLAN_SHOW_DEPTH_VALUES)[number];

/** Documents the plan command options payload exchanged by command, SDK, and package integrations. */
export interface PlanCommandOptions
  extends
    Omit<
      MutationMetadataCommandOptions,
      "author" | "blockedBy" | "message" | "parent"
    >,
    Omit<
      SharedLinkedResourceOptions,
      "dep" | "doc" | "field" | "file" | "test"
    > {
  /** Value that configures or reports title for this contract. */
  title?: string;
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports scope for this contract. */
  scope?: string;
  /** Value that configures or reports parent for this contract. */
  parent?: string;
  /** Value that configures or reports related for this contract. */
  related?: string | string[];
  /** Value that configures or reports blocks for this contract. */
  blocks?: string | string[];
  /** Value that configures or reports blocked by for this contract. */
  blockedBy?: string | string[];
  /** Value that configures or reports harness for this contract. */
  harness?: string;
  /** Value that configures or reports mode for this contract. */
  mode?: string;
  /** Value that configures or reports resume context for this contract. */
  resumeContext?: string;
  /** Value that configures or reports tags for this contract. */
  tags?: string;
  /** Value that configures or reports priority for this contract. */
  priority?: string;
  /** Lifecycle status used when creating the Plan item. */
  status?: string;
  /** Required-option policy used when creating the Plan item. */
  createMode?: string;
  /** Value that configures or reports body for this contract. */
  body?: string;
  /** Value that configures or reports claim for this contract. */
  claim?: boolean;
  /** Value that configures or reports from search for this contract. */
  fromSearch?: string;
  /** Value that configures or reports step title for this contract. */
  stepTitle?: string;
  /** pm-6mit: repeatable --step values. On create each value seeds one ordered step (argv order; values are never comma-split so titles may contain commas). On other subcommands a single value aliases stepTitle. */
  step?: string | string[];
  /** Value that configures or reports step body for this contract. */
  stepBody?: string;
  /** Value that configures or reports step owner for this contract. */
  stepOwner?: string;
  /** Lifecycle status of the referenced plan step. */
  stepStatus?: string;
  /** Value that configures or reports step evidence for this contract. */
  stepEvidence?: string;
  /** Value that configures or reports step blocked reason for this contract. */
  stepBlockedReason?: string;
  /** Value that configures or reports step replacement for this contract. */
  stepReplacement?: string;
  /** Value that configures or reports depends on for this contract. */
  dependsOn?: string | string[];
  /** Value that configures or reports link for this contract. */
  link?: string | string[];
  /** Value that configures or reports link kind for this contract. */
  linkKind?: string;
  /** Value that configures or reports link note for this contract. */
  linkNote?: string;
  /** Value that configures or reports promote to item dep for this contract. */
  promoteToItemDep?: boolean;
  /** Value that configures or reports allow multiple active for this contract. */
  allowMultipleActive?: boolean;
  /** Value that configures or reports file for this contract. */
  file?: string | string[];
  /** Value that configures or reports test for this contract. */
  test?: string | string[];
  /** Value that configures or reports doc for this contract. */
  doc?: string | string[];
  /** Value that configures or reports decision text for this contract. */
  decisionText?: string;
  /** Value that configures or reports decision for this contract. */
  decision?: string;
  /** Value that configures or reports decision rationale for this contract. */
  decisionRationale?: string;
  /** Value that configures or reports decision evidence for this contract. */
  decisionEvidence?: string;
  /** Value that configures or reports discovery text for this contract. */
  discoveryText?: string;
  /** Value that configures or reports discovery for this contract. */
  discovery?: string;
  /** Value that configures or reports validation text for this contract. */
  validationText?: string;
  /** Value that configures or reports validation for this contract. */
  validation?: string;
  /** Value that configures or reports validation command for this contract. */
  validationCommand?: string;
  /** Value that configures or reports validation expected for this contract. */
  validationExpected?: string;
  /** Value that configures or reports depth for this contract. */
  depth?: string;
  /** Value that configures or reports fields for this contract. */
  fields?: string;
  /** Value that configures or reports steps for this contract. */
  steps?: string;
  /** Value that configures or reports template for this contract. */
  template?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  materializeType?: string;
  /** Value that configures or reports materialize parent for this contract. */
  materializeParent?: string;
  /** Value that configures or reports materialize tags for this contract. */
  materializeTags?: string;
  /** Custom field values forwarded to every materialized item as `name=value` pairs. */
  field?: string | string[];
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the plan command result payload exchanged by command, SDK, and package integrations. */
export interface PlanCommandResult {
  /** Value that configures or reports action for this contract. */
  action: PlanSubcommand;
  /** Value that configures or reports plan for this contract. */
  plan: PlanResultPlan;
  /** Value that configures or reports step for this contract. */
  step?: PlanStep;
  /** Value that configures or reports current step for this contract. */
  current_step?: PlanStep | undefined;
  /** Value that configures or reports next actions for this contract. */
  next_actions?: string[];
  /** Value that configures or reports materialized for this contract. */
  materialized?: {
    id: string;
    title: string;
    type: string;
    parent?: string;
    tags: string[];
    from_step: string;
  }[];
  // pm-fl0c #10 (2026-05-28): steps that pm plan materialize intentionally
  // skipped (already-completed or already-materialized via an `implements`
  // link). Surfacing these makes `--steps all` idempotent without users
  // having to read history to find out what was done.
  /** Value that configures or reports materialize skipped for this contract. */
  materialize_skipped?: {
    from_step: string;
    reason: "already_completed" | "already_materialized";
    existing_id?: string;
  }[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

/** Documents the plan result plan payload exchanged by command, SDK, and package integrations. */
export interface PlanResultPlan {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Lifecycle state reported for status. */
  status: string;
  /** Value that configures or reports mode for this contract. */
  mode: PlanMode;
  /** Value that configures or reports scope for this contract. */
  scope?: string;
  /** Value that configures or reports harness for this contract. */
  harness?: PlanHarness;
  /** Value that configures or reports parent for this contract. */
  parent?: string;
  /** Value that configures or reports resume context for this contract. */
  resume_context?: string;
  /** Value that configures or reports steps summary for this contract. */
  steps_summary: PlanStepSummary;
  /** Value that configures or reports current step for this contract. */
  current_step?:
    | { id: string; order: number; title: string; status: PlanStepStatus }
    | undefined;
  /** Value that configures or reports blocked steps for this contract. */
  blocked_steps?: {
    id: string;
    order: number;
    title: string;
    blocked_reason?: string;
  }[];
  /** Value that configures or reports steps for this contract. */
  steps?: PlanStep[];
  /** Value that configures or reports decisions for this contract. */
  decisions?: PlanDecision[];
  /** Value that configures or reports discoveries for this contract. */
  discoveries?: PlanDiscovery[];
  /** Value that configures or reports validation for this contract. */
  validation?: PlanValidationCheck[];
  /** Value that configures or reports linked items for this contract. */
  linked_items?: { id: string; kind: DependencyKind }[];
}

/** Documents the plan step summary payload exchanged by command, SDK, and package integrations. */
export interface PlanStepSummary {
  /** Value that configures or reports total for this contract. */
  total: number;
  /** Value that configures or reports pending for this contract. */
  pending: number;
  /** Value that configures or reports in progress for this contract. */
  in_progress: number;
  /** Value that configures or reports blocked for this contract. */
  blocked: number;
  /** Value that configures or reports completed for this contract. */
  completed: number;
  /** Value that configures or reports skipped for this contract. */
  skipped: number;
  /** Value that configures or reports superseded for this contract. */
  superseded: number;
  /** Whole-percent step-completion progress (`round(completed / total * 100)`), surfaced so agents see plan progress without recomputing it (GH-158 #5). */
  completion_pct: number;
}

const STEP_ID_PREFIX = "plan-step-";
const DEFAULT_PLAN_MODE: PlanMode = "draft";

/** Public contract for plan template names, shared by SDK and presentation-layer consumers. */
export const PLAN_TEMPLATE_NAMES = [
  "bug-investigation",
  "feature-implementation",
  "refactoring-sprint",
] as const;
/** Restricts plan template names accepted by `pm plan create --template` (GH-158 #2). */
export type PlanTemplateName = (typeof PLAN_TEMPLATE_NAMES)[number];

interface PlanTemplateStepSeed {
  title: string;
  body: string;
}

// Built-in step scaffolds for the most common agent workflows. Each seeds an
// ordered list of pending steps so `pm plan create --template <name>` produces a
// ready-to-execute plan instead of an empty shell (GH-158 #2).
const PLAN_TEMPLATES: Record<PlanTemplateName, PlanTemplateStepSeed[]> = {
  "bug-investigation": [
    {
      title: "Reproduce the bug",
      body: "Capture exact steps, inputs, and the observed vs expected behavior.",
    },
    {
      title: "Locate the root cause",
      body: "Trace the failure to the responsible code path with evidence.",
    },
    {
      title: "Write a failing test",
      body: "Add a regression test that fails for the current bug.",
    },
    {
      title: "Implement the fix",
      body: "Apply the minimal change that makes the failing test pass.",
    },
    {
      title: "Verify and document",
      body: "Run the full suite and record the resolution and verification.",
    },
  ],
  "feature-implementation": [
    {
      title: "Clarify requirements & acceptance criteria",
      body: "Confirm scope, edge cases, and done-conditions.",
    },
    {
      title: "Design the approach",
      body: "Decide the data model, interfaces, and integration points.",
    },
    {
      title: "Implement the change",
      body: "Build the feature behind the agreed design.",
    },
    { title: "Add tests", body: "Cover the new behavior and its edge cases." },
    {
      title: "Update docs & changelog",
      body: "Document the feature and surface it to users.",
    },
  ],
  "refactoring-sprint": [
    {
      title: "Map the current structure & risks",
      body: "Inventory the code to change and its blast radius.",
    },
    {
      title: "Add characterization tests",
      body: "Lock in current behavior before refactoring.",
    },
    {
      title: "Refactor incrementally",
      body: "Apply small, reversible steps keeping tests green.",
    },
    {
      title: "Verify behavior is unchanged",
      body: "Run the full suite and compare against the baseline.",
    },
    {
      title: "Clean up & document",
      body: "Remove dead code and record the new structure.",
    },
  ],
};

/** Resolves the ordered step seeds for a built-in plan template, rejecting unknown names with the allowed set so agents can self-correct. */
export function resolvePlanTemplateSteps(raw: string): PlanTemplateStepSeed[] {
  const normalized = raw.trim().toLowerCase();
  const template = Object.prototype.hasOwnProperty.call(
    PLAN_TEMPLATES,
    normalized,
  )
    ? PLAN_TEMPLATES[normalized as PlanTemplateName]
    : undefined;
  if (!template) {
    throw new PmCliError(
      `Unknown plan template "${raw}". Allowed: ${PLAN_TEMPLATE_NAMES.join(", ")}`,
      EXIT_CODE.USAGE,
      {
        code: "unknown_plan_template",
        examples: [
          `pm plan create --title "Fix login crash" --template ${PLAN_TEMPLATE_NAMES[0]}`,
        ],
      },
    );
  }
  return template.map((step) => ({ ...step }));
}

/** Computes whole-percent step completion (`round(completed / total * 100)`), returning 0 for an empty plan so the field is always a stable number. */
function planCompletionPct(completed: number, total: number): number {
  return total > 0 ? Math.round((completed / total) * 100) : 0;
}

/* c8 ignore start -- detailed plan helper branches are validated through broader plan workflow integration tests. */
function resolveAuthor(
  candidate: string | undefined,
  fallback: string,
): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? fallback;
  const trimmed = resolved.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

/** pm-6mit: ordered step titles from repeated --step values. Unlike toArray this NEVER comma-splits — each --step value is one full step title, so titles containing commas survive intact (also why --step must not be list:true in contracts: the bootstrap coalescer would comma-join values). */
function toOrderedStepTitles(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  return values
    .filter((entry) => entry !== undefined && entry !== null)
    .map((entry) => (typeof entry === "string" ? entry : String(entry)).trim())
    .filter((entry) => entry.length > 0);
}

function toArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value))
    return value.flatMap((entry) => splitCommaList(entry, { unique: false }));
  if (typeof value === "string" && value.trim().length > 0) {
    return splitCommaList(value, { unique: false });
  }
  return [];
}

function toSpecArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value))
    return value.map((entry) => entry.trim()).filter(Boolean);
  if (typeof value === "string" && value.trim().length > 0)
    return [value.trim()];
  return [];
}

function asPlanMode(
  value: string | undefined,
  fallback: PlanMode = DEFAULT_PLAN_MODE,
): PlanMode {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  const found = PLAN_MODE_VALUES.find((entry) => entry === normalized);
  if (!found) {
    throw new PmCliError(
      `Invalid plan mode "${value}". Allowed: ${PLAN_MODE_VALUES.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return found;
}

function asStepStatus(
  value: string | undefined,
  fallback: PlanStepStatus = "pending",
): PlanStepStatus {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  const found = PLAN_STEP_STATUS_VALUES.find((entry) => entry === normalized);
  if (!found) {
    throw new PmCliError(
      `Invalid step status "${value}". Allowed: ${PLAN_STEP_STATUS_VALUES.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return found;
}

function asLinkKind(
  value: string | undefined,
  fallback: PlanStepLinkKind = "related",
): PlanStepLinkKind {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  const found = PLAN_STEP_LINK_KIND_VALUES.find(
    (entry) => entry === normalized,
  );
  if (!found) {
    throw new PmCliError(
      `Invalid step link kind "${value}". Allowed: ${PLAN_STEP_LINK_KIND_VALUES.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return found;
}

function asHarness(value: string | undefined): PlanHarness | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  const found = PLAN_HARNESS_VALUES.find((entry) => entry === normalized);
  if (!found) {
    throw new PmCliError(
      `Invalid plan harness "${value}". Allowed: ${PLAN_HARNESS_VALUES.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return found;
}

function asDepth(value: string | undefined): PlanShowDepth {
  if (value === undefined) return "brief";
  const normalized = value.trim().toLowerCase();
  const found = PLAN_SHOW_DEPTH_VALUES.find((entry) => entry === normalized);
  if (!found) {
    throw new PmCliError(
      `Invalid --depth "${value}". Allowed: ${PLAN_SHOW_DEPTH_VALUES.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return found;
}

function parsePlanFields(raw: string | undefined): string[] | null {
  if (raw === undefined) {
    return null;
  }
  const fields = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (fields.length === 0) {
    throw new PmCliError(
      "Plan --fields requires a comma-separated list of plan field names",
      EXIT_CODE.USAGE,
    );
  }
  return fields;
}

const PLAN_FIELD_KEYS = new Set<keyof PlanResultPlan>([
  "id",
  "title",
  "status",
  "mode",
  "scope",
  "harness",
  "parent",
  "resume_context",
  "steps_summary",
  "current_step",
  "blocked_steps",
  "steps",
  "decisions",
  "discoveries",
  "validation",
  "linked_items",
]);

function projectPlanForFields(
  plan: PlanResultPlan,
  fields: string[],
): PlanResultPlan {
  const source = plan as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  const unknownFields: string[] = [];
  for (const field of fields) {
    const normalized = field.startsWith("plan.")
      ? field.slice("plan.".length)
      : field;
    if (normalized.length === 0) {
      continue;
    }
    if (!PLAN_FIELD_KEYS.has(normalized as keyof PlanResultPlan)) {
      unknownFields.push(field);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(source, normalized)) {
      projected[normalized] = source[normalized];
    }
  }
  if (unknownFields.length > 0) {
    throw new PmCliError(
      `Unknown Plan --fields value(s): ${unknownFields.join(", ")}`,
      EXIT_CODE.USAGE,
      {
        nextSteps: [
          `Use --fields ${[...PLAN_FIELD_KEYS].join(",")}`,
          "Run pm plan show <id> --depth brief for compact default fields.",
        ],
        recovery: {
          provided_fields: unknownFields,
          suggested_retry: `pm plan show <id> --fields ${[...PLAN_FIELD_KEYS].join(",")}`,
        },
      },
    );
  }
  return projected as unknown as PlanResultPlan;
}

function parsePairList(raw: string, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      throw new PmCliError(
        `Invalid ${label} entry "${trimmed}"; expected key=value`,
        EXIT_CODE.USAGE,
      );
    }
    out[trimmed.slice(0, equalsIndex).trim().toLowerCase()] = trimmed
      .slice(equalsIndex + 1)
      .trim();
  }
  return out;
}

function parseStepFile(spec: string): PlanStepFile {
  const fields = parsePairList(spec, "--file");
  if (!fields.path) {
    throw new PmCliError("--file requires path=<value>", EXIT_CODE.USAGE);
  }
  const file: PlanStepFile = { path: fields.path };
  if (fields.scope === "global" || fields.scope === "project")
    file.scope = fields.scope;
  if (fields.note) file.note = fields.note;
  return file;
}

function parseStepTest(spec: string): PlanStepTest {
  const fields = parsePairList(spec, "--test");
  if (!fields.command && !fields.path) {
    throw new PmCliError(
      "--test requires at least command=<value> or path=<value>",
      EXIT_CODE.USAGE,
    );
  }
  const test: PlanStepTest = {};
  if (fields.command) test.command = fields.command;
  if (fields.path) test.path = fields.path;
  if (fields.note) test.note = fields.note;
  return test;
}

function parseStepDoc(spec: string): PlanStepDoc {
  const fields = parsePairList(spec, "--doc");
  if (!fields.path) {
    throw new PmCliError("--doc requires path=<value>", EXIT_CODE.USAGE);
  }
  const doc: PlanStepDoc = { path: fields.path };
  if (fields.scope === "global" || fields.scope === "project")
    doc.scope = fields.scope;
  if (fields.note) doc.note = fields.note;
  return doc;
}

function summarizeSteps(steps: PlanStep[]): PlanStepSummary {
  const summary: PlanStepSummary = {
    total: steps.length,
    pending: 0,
    in_progress: 0,
    blocked: 0,
    completed: 0,
    skipped: 0,
    superseded: 0,
    completion_pct: 0,
  };
  for (const step of steps) {
    summary[step.status] += 1;
  }
  summary.completion_pct = planCompletionPct(summary.completed, summary.total);
  return summary;
}

function newStepId(existing: PlanStep[]): string {
  const used = new Set(existing.map((step) => step.id));
  for (
    let cursor = existing.length + 1;
    cursor < existing.length + 1024;
    cursor += 1
  ) {
    const candidate = `${STEP_ID_PREFIX}${String(cursor).padStart(3, "0")}`;
    if (!used.has(candidate)) return candidate;
  }
  /* c8 ignore next -- step id allocation only fails if 1024 consecutive ids are taken. */
  throw new PmCliError(
    "Could not allocate step id (limit reached)",
    EXIT_CODE.GENERIC_FAILURE,
  );
}

function resolveStepRef(steps: PlanStep[], ref: string): PlanStep {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new PmCliError("Step reference cannot be empty", EXIT_CODE.USAGE);
  }
  const direct = steps.find((step) => step.id === trimmed);
  if (direct) return direct;
  if (/^\d+$/.test(trimmed)) {
    const order = Number.parseInt(trimmed, 10);
    const byOrder = steps.find((step) => step.order === order);
    if (byOrder) return byOrder;
  }
  throw new PmCliError(`Step "${ref}" not found in plan`, EXIT_CODE.NOT_FOUND);
}

interface MaterializeTargetResolution {
  targets: PlanStep[];
  skipped: {
    from_step: string;
    reason: "already_completed" | "already_materialized";
    existing_id?: string;
  }[];
}

// pm-fl0c #10 (2026-05-28): skip steps whose status is "completed" and steps
// that already have an `implements` link from a prior materialize run, so
// `pm plan materialize --steps all` is idempotent and never re-creates fresh
// Tasks for work already tracked. Explicit step refs are still allowed
// through (the user asked by ID) but the skip-reason is recorded.
function classifyMaterializeSkip(step: PlanStep):
  | {
      reason: "already_completed" | "already_materialized";
      existing_id?: string;
    }
  | undefined {
  if (step.status === "completed") {
    return { reason: "already_completed" };
  }
  const existingImplements = (step.linked_items ?? []).find(
    (link) => link.kind === "implements",
  );
  if (existingImplements) {
    return {
      reason: "already_materialized",
      existing_id: existingImplements.id,
    };
  }
  return undefined;
}

function resolveMaterializeTargets(
  steps: PlanStep[],
  refs: string[],
): MaterializeTargetResolution {
  const allRefs = refs.filter((ref) => ref.trim().toLowerCase() === "all");
  const targets: PlanStep[] = [];
  const skipped: {
    from_step: string;
    reason: "already_completed" | "already_materialized";
    existing_id?: string;
  }[] = [];
  if (allRefs.length > 0) {
    if (refs.length > allRefs.length) {
      throw new PmCliError(
        "pm plan materialize --steps all cannot be combined with other step refs",
        EXIT_CODE.USAGE,
      );
    }
    for (const step of steps
      .slice()
      .sort((left, right) => left.order - right.order)) {
      const skip = classifyMaterializeSkip(step);
      if (skip) {
        skipped.push({ from_step: step.id, ...skip });
        continue;
      }
      targets.push(step);
    }
    return { targets, skipped };
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    const step = resolveStepRef(steps, ref);
    if (seen.has(step.id)) continue;
    seen.add(step.id);
    const skip = classifyMaterializeSkip(step);
    if (skip) {
      skipped.push({ from_step: step.id, ...skip });
      continue;
    }
    targets.push(step);
  }
  return { targets, skipped };
}

function resolvePlanLogText(
  kind: "decision" | "discovery" | "validation",
  options: PlanCommandOptions,
): string | undefined {
  const canonical =
    kind === "decision"
      ? options.decisionText
      : kind === "discovery"
        ? options.discoveryText
        : options.validationText;
  const shorthand =
    kind === "decision"
      ? options.decision
      : kind === "discovery"
        ? options.discovery
        : options.validation;
  return canonical?.trim() || shorthand?.trim() || undefined;
}

function findCurrentStep(steps: PlanStep[]): PlanStep | undefined {
  return (
    steps.find((step) => step.status === "in_progress") ??
    steps.find((step) => step.status === "pending")
  );
}

function blockedSteps(
  steps: PlanStep[],
): { id: string; order: number; title: string; blocked_reason?: string }[] {
  return steps
    .filter((step) => step.status === "blocked")
    .map((step) => ({
      id: step.id,
      order: step.order,
      title: step.title,
      blocked_reason: step.blocked_reason,
    }));
}

function projectPlan(
  item: ItemMetadata,
  depth: PlanShowDepth = "brief",
): PlanResultPlan {
  const steps = (item.plan_steps ?? [])
    .slice()
    .sort((left, right) => left.order - right.order);
  const summary = summarizeSteps(steps);
  const current = findCurrentStep(steps);
  const projection: PlanResultPlan = {
    id: item.id,
    title: item.title,
    status: item.status,
    mode: (item.plan_mode ?? DEFAULT_PLAN_MODE) as PlanMode,
    scope: item.plan_scope,
    harness: item.plan_harness,
    parent: item.parent,
    resume_context: item.plan_resume_context,
    steps_summary: summary,
    current_step: current
      ? {
          id: current.id,
          order: current.order,
          title: current.title,
          status: current.status,
        }
      : undefined,
    blocked_steps: blockedSteps(steps),
    linked_items: (item.dependencies ?? []).map((dep) => ({
      id: dep.id,
      kind: dep.kind,
    })),
  };
  if (depth === "standard" || depth === "deep") {
    projection.steps = steps;
  }
  if (depth === "deep") {
    projection.decisions = item.plan_decisions ?? [];
    projection.discoveries = item.plan_discoveries ?? [];
    projection.validation = item.plan_validation ?? [];
  }
  return projection;
}

function nextActionsFor(planId: string, plan: PlanResultPlan): string[] {
  const tips: string[] = [];
  if (plan.steps_summary.total === 0) {
    tips.push(`pm plan add-step ${planId} --step-title "First step"`);
  }
  if (plan.current_step) {
    tips.push(
      `pm plan update-step ${planId} ${plan.current_step.id} --step-status in_progress`,
      `pm plan complete-step ${planId} ${plan.current_step.id} --step-evidence "..."`,
    );
  }
  if (plan.steps_summary.blocked > 0) {
    tips.push(`pm plan show ${planId} --depth standard`);
  }
  if (plan.mode === "draft" || plan.mode === "research") {
    tips.push(`pm plan approve ${planId} --message "ready to execute"`);
  }
  if (
    plan.steps_summary.completed === plan.steps_summary.total &&
    plan.steps_summary.total > 0
  ) {
    tips.push(`pm close ${planId} "plan complete"`);
  }
  return tips;
}

function ensurePlanItem(item: ItemMetadata): void {
  const normalizedType = (item.type ?? "").trim().toLowerCase();
  if (normalizedType !== "plan") {
    throw new PmCliError(
      `Item ${item.id} is type ${item.type}; pm plan commands require type=Plan. Use pm plan create or pm create --type Plan first.`,
      EXIT_CODE.USAGE,
      {
        code: "wrong_item_type",
        required: "Use pm plan commands only with items whose type is Plan.",
        why: "Plan commands read and mutate Plan-specific step, decision, discovery, and validation fields.",
        examples: [
          `pm get ${item.id} --depth brief`,
          'pm plan create --title "Execution plan" --scope "<goal>"',
        ],
      },
    );
  }
}

interface PlanWriteContext {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
}

async function loadContext(global: GlobalOptions): Promise<PlanWriteContext> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);
  return { pmRoot, settings };
}

async function readPlanItem(
  ctx: PlanWriteContext,
  id: string,
): Promise<{ document: ItemDocument; itemId: string }> {
  const typeRegistry = resolveItemTypeRegistry(
    ctx.settings,
    getActiveExtensionRegistrations(),
  );
  const located = await locateItem(
    ctx.pmRoot,
    id,
    ctx.settings.id_prefix,
    ctx.settings.item_format,
    typeRegistry.type_to_folder,
  );
  if (!located) {
    throw new PmCliError(`Plan ${id} not found`, EXIT_CODE.NOT_FOUND);
  }
  const loaded = await readLocatedItem(located, {
    schema: ctx.settings.schema,
  });
  ensurePlanItem(loaded.document.metadata);
  return { document: loaded.document, itemId: located.id };
}

function buildPlanCreateDependencies(
  options: PlanCommandOptions,
): string[] | undefined {
  const deps: string[] = [];
  if (options.parent) {
    deps.push(`id=${options.parent.trim()},kind=parent`);
  }
  for (const ref of toArray(options.related))
    deps.push(`id=${ref},kind=related`);
  for (const ref of toArray(options.blocks)) deps.push(`id=${ref},kind=blocks`);
  for (const ref of toArray(options.blockedBy))
    deps.push(`id=${ref},kind=blocked_by`);
  return deps.length > 0 ? deps : undefined;
}

function buildInitialValidation(
  options: PlanCommandOptions,
): PlanValidationCheck | undefined {
  const text = options.validationText?.trim();
  const command = options.validationCommand?.trim();
  const expected = options.validationExpected?.trim();
  if (!text && !command && !expected) {
    return undefined;
  }
  return {
    text: text || command || "Validation check",
    command: command || undefined,
    expected: expected || undefined,
  };
}

function hasPlanStepDetailOptions(options: PlanCommandOptions): boolean {
  return (
    Boolean(options.stepBody?.trim()) ||
    Boolean(options.stepOwner?.trim()) ||
    Boolean(options.stepStatus?.trim()) ||
    Boolean(options.stepEvidence?.trim()) ||
    Boolean(options.stepBlockedReason?.trim()) ||
    Boolean(options.stepReplacement?.trim()) ||
    toArray(options.dependsOn).length > 0 ||
    toArray(options.link).length > 0
  );
}

function resolveInitialStepSeed(options: PlanCommandOptions): {
  repeatedStepTitles: string[];
  stepTitleFlag: string | undefined;
  stepTitles: string[];
  templateSteps: PlanTemplateStepSeed[];
} {
  const stepTitleFlag = options.stepTitle?.trim() || undefined;
  const repeatedStepTitles = toOrderedStepTitles(options.step);
  const templateSteps = options.template?.trim()
    ? resolvePlanTemplateSteps(options.template)
    : [];
  return {
    repeatedStepTitles,
    stepTitleFlag,
    stepTitles: [
      ...(stepTitleFlag ? [stepTitleFlag] : []),
      ...repeatedStepTitles,
      ...templateSteps.map((step) => step.title),
    ],
    templateSteps,
  };
}

function assertInitialStepSeedAllowed(
  seed: ReturnType<typeof resolveInitialStepSeed>,
  hasPerStepDetailOptions: boolean,
): void {
  if (
    (seed.stepTitleFlag || seed.repeatedStepTitles.length > 0) &&
    seed.templateSteps.length > 0
  ) {
    throw new PmCliError(
      "pm plan create --template cannot be combined with --step-title or --step; choose one step seeding source",
      EXIT_CODE.USAGE,
      {
        code: "ambiguous_option_combination",
        examples: [
          `pm plan create --title "Fix login crash" --template ${PLAN_TEMPLATE_NAMES[0]}`,
          'pm plan create --title "Custom plan" --step "Read the code" --step "Write the fix"',
        ],
      },
    );
  }
  if (seed.stepTitles.length > 1 && hasPerStepDetailOptions) {
    throw new PmCliError(
      "pm plan create per-step options apply to a single initial step; with multiple --step values create the plan first, then refine steps individually",
      EXIT_CODE.USAGE,
      {
        code: "ambiguous_option_combination",
        examples: [
          'pm plan create --title "Execution plan" --step "Read the code" --step "Write the fix"',
          'pm plan update-step <plan-id> plan-step-001 --step-body "Inspect retry path"',
        ],
      },
    );
  }
}

function buildSingleInitialStep(
  options: PlanCommandOptions,
  title: string,
): PlanStep {
  const status = asStepStatus(options.stepStatus, "pending");
  const linkedItems = buildLinkInputs(options, "depends_on");
  const files = toSpecArray(options.file).map(parseStepFile);
  const tests = toSpecArray(options.test).map(parseStepTest);
  const docs = toSpecArray(options.doc).map(parseStepDoc);
  const now = nowIso();
  return {
    id: "plan-step-001",
    order: 1,
    title,
    body: options.stepBody?.trim() || undefined,
    status,
    owner: options.stepOwner?.trim() || undefined,
    evidence: options.stepEvidence?.trim() || undefined,
    blocked_reason:
      status === "blocked"
        ? options.stepBlockedReason?.trim() || ""
        : undefined,
    linked_items: linkedItems.length > 0 ? linkedItems : undefined,
    files: files.length > 0 ? files : undefined,
    tests: tests.length > 0 ? tests : undefined,
    docs: docs.length > 0 ? docs : undefined,
    created_at: now,
    updated_at: now,
    completed_at: status === "completed" ? now : undefined,
  };
}

function buildInitialSteps(options: PlanCommandOptions): {
  steps: PlanStep[];
  hasPerStepDetailOptions: boolean;
} {
  const seed = resolveInitialStepSeed(options);
  const hasDetailOptions = hasPlanStepDetailOptions(options);
  assertInitialStepSeedAllowed(seed, hasDetailOptions);
  if (seed.stepTitles.length === 0) {
    return { steps: [], hasPerStepDetailOptions: hasDetailOptions };
  }
  if (seed.stepTitles.length === 1) {
    return {
      steps: [buildSingleInitialStep(options, seed.stepTitles[0])],
      hasPerStepDetailOptions: hasDetailOptions,
    };
  }
  const now = nowIso();
  return {
    steps: seed.stepTitles.map((stepTitle, index) => ({
      id: `${STEP_ID_PREFIX}${String(index + 1).padStart(3, "0")}`,
      order: index + 1,
      title: stepTitle,
      body: seed.templateSteps[index]?.body,
      status: "pending" as const,
      created_at: now,
      updated_at: now,
    })),
    hasPerStepDetailOptions: hasDetailOptions,
  };
}

function seedCreatedPlanMetadata(
  document: ItemDocument,
  options: PlanCommandOptions,
  mode: PlanMode,
  harness: PlanHarness | undefined,
): { changedFields: string[] } {
  const changedFields = ["plan_mode"];
  document.metadata.plan_mode = mode;
  if (harness) {
    document.metadata.plan_harness = harness;
    changedFields.push("plan_harness");
  }
  const scope = options.scope?.trim();
  if (scope) {
    document.metadata.plan_scope = scope;
    changedFields.push("plan_scope");
  }
  const resumeContext = options.resumeContext?.trim();
  if (resumeContext) {
    document.metadata.plan_resume_context = resumeContext;
    changedFields.push("plan_resume_context");
  }
  document.metadata.plan_steps ??= [];
  return { changedFields };
}

function seedCreatedPlanSteps(
  document: ItemDocument,
  initialSteps: PlanStep[],
  initialValidation: PlanValidationCheck | undefined,
): { changedFields: string[] } {
  ensurePlanItem(document.metadata);
  document.metadata.plan_steps = initialSteps;
  if (!initialValidation) return { changedFields: ["plan_steps"] };
  document.metadata.plan_validation = [
    ...(document.metadata.plan_validation ?? []),
    initialValidation,
  ];
  return { changedFields: ["plan_steps", "plan_validation"] };
}

function seedCreatedPlanValidation(
  document: ItemDocument,
  initialValidation: PlanValidationCheck,
): { changedFields: string[] } {
  ensurePlanItem(document.metadata);
  document.metadata.plan_validation = [
    ...(document.metadata.plan_validation ?? []),
    initialValidation,
  ];
  return { changedFields: ["plan_validation"] };
}

async function planCreate(
  options: PlanCommandOptions,
  global: GlobalOptions,
  ctx: PlanWriteContext,
): Promise<PlanCommandResult> {
  const title = options.title?.trim();
  if (!title) {
    throw new PmCliError("pm plan create requires --title", EXIT_CODE.USAGE, {
      code: "missing_required_option",
      examples: [
        'pm plan create --title "Refactor lock retry" --scope pm-a1b2',
      ],
    });
  }
  const mode = asPlanMode(options.mode, DEFAULT_PLAN_MODE);
  const harness = asHarness(options.harness);
  const fromSearch = options.fromSearch?.trim();

  const description =
    options.description?.trim() ?? options.scope?.trim() ?? title;
  const createOptions: CreateCommandOptions = {
    ...options,
    title,
    description,
    type: "Plan",
    template: undefined,
    file: toSpecArray(options.file),
    test: toSpecArray(options.test),
    doc: toSpecArray(options.doc),
    field: toSpecArray(options.field),
    blockedBy: undefined,
    dep: buildPlanCreateDependencies(options),
    message:
      options.message ??
      (fromSearch ? `plan create (search: ${fromSearch})` : `plan create`),
  };

  const createResult: CreateResult = await runCreate(createOptions, global);

  // The create command stores type_options. To use real metadata keys, run a follow-up mutate.
  const seedResult = await mutateItem({
    pmRoot: ctx.pmRoot,
    settings: ctx.settings,
    id: createResult.item.id,
    op: "plan_create_metadata",
    author: resolveAuthor(options.author, ctx.settings.author_default),
    message: "seed plan metadata",
    mutate(doc) {
      return seedCreatedPlanMetadata(doc, options, mode, harness);
    },
  });

  let finalMetadata: ItemMetadata = seedResult.item;
  let initialStep: PlanStep | undefined;
  const initialValidation = buildInitialValidation(options);
  const { steps: initialSteps, hasPerStepDetailOptions } =
    buildInitialSteps(options);
  if (initialSteps.length > 0) {
    initialStep = initialSteps[0];
    const stepped = await mutateItem({
      pmRoot: ctx.pmRoot,
      settings: ctx.settings,
      id: createResult.item.id,
      op: "plan_create_initial_step",
      author: resolveAuthor(options.author, ctx.settings.author_default),
      message:
        initialSteps.length === 1
          ? `plan create initial step "${initialSteps[0].title}"`
          : `plan create ${initialSteps.length} initial steps`,
      mutate(doc) {
        return seedCreatedPlanSteps(doc, initialSteps, initialValidation);
      },
    });
    finalMetadata = stepped.item;
  } else if (initialValidation) {
    const validated = await mutateItem({
      pmRoot: ctx.pmRoot,
      settings: ctx.settings,
      id: createResult.item.id,
      op: "plan_create_initial_validation",
      author: resolveAuthor(options.author, ctx.settings.author_default),
      message: "plan create initial validation",
      mutate(doc) {
        return seedCreatedPlanValidation(doc, initialValidation);
      },
    });
    finalMetadata = validated.item;
  } else if (hasPerStepDetailOptions) {
    throw new PmCliError(
      "pm plan create step options require --step-title (or a single --step)",
      EXIT_CODE.USAGE,
      {
        code: "missing_required_option",
        examples: [
          'pm plan create --title "Execution plan" --step-title "Read the code"',
        ],
      },
    );
  }
  if (options.claim) {
    const claimed = await mutateItem({
      pmRoot: ctx.pmRoot,
      settings: ctx.settings,
      id: createResult.item.id,
      op: "claim",
      author: resolveAuthor(options.author, ctx.settings.author_default),
      message: "plan claim by author",
      mutate(doc) {
        doc.metadata.assignee = resolveAuthor(
          options.author,
          ctx.settings.author_default,
        );
        return { changedFields: ["assignee"] };
      },
    });
    finalMetadata = claimed.item;
  }

  const plan = projectPlan(finalMetadata, "brief");
  return {
    action: "create",
    plan,
    step: initialStep,
    next_actions: nextActionsFor(createResult.item.id, plan),
    warnings: [...createResult.warnings],
    generated_at: nowIso(),
  };
}

async function planShow(
  id: string,
  options: PlanCommandOptions,
  ctx: PlanWriteContext,
): Promise<PlanCommandResult> {
  const depth = asDepth(options.depth);
  const fields = parsePlanFields(options.fields);
  const { document, itemId } = await readPlanItem(ctx, id);
  const fullPlan = projectPlan(
    document.metadata,
    fields === null ? depth : "deep",
  );
  const plan =
    fields === null ? fullPlan : projectPlanForFields(fullPlan, fields);
  return {
    action: "show",
    plan,
    next_actions: nextActionsFor(itemId, fullPlan),
    warnings: [],
    generated_at: nowIso(),
  };
}

interface MutateStepArgs {
  id: string;
  options: PlanCommandOptions;
  ctx: PlanWriteContext;
  op: string;
  message: string;
  mutator(
    steps: PlanStep[],
    doc: ItemDocument,
  ): { changedSteps: string[]; current?: PlanStep; resultStep?: PlanStep };
}

async function mutatePlanSteps(
  args: MutateStepArgs,
): Promise<{ document: ItemDocument; resultStep?: PlanStep; itemId: string }> {
  const author = resolveAuthor(
    args.options.author,
    args.ctx.settings.author_default,
  );
  let resultStep: PlanStep | undefined;
  const result = await mutateItem({
    pmRoot: args.ctx.pmRoot,
    settings: args.ctx.settings,
    id: args.id,
    op: args.op,
    author,
    message: args.options.message ?? args.message,
    force: args.options.force,
    mutate(doc) {
      ensurePlanItem(doc.metadata);
      const steps = (doc.metadata.plan_steps ?? []).slice();
      const before = JSON.stringify(steps);
      const outcome = args.mutator(steps, doc);
      resultStep = outcome.resultStep;
      const sorted = steps
        .slice()
        .sort((left, right) => left.order - right.order)
        .map((step, index) => ({ ...step, order: index + 1 }));
      doc.metadata.plan_steps = sorted;
      const after = JSON.stringify(sorted);
      const changedFields = before === after ? [] : ["plan_steps"];
      if (changedFields.length === 0 && outcome.changedSteps.length === 0) {
        return { changedFields: [] };
      }
      return {
        changedFields:
          changedFields.length > 0 ? changedFields : ["plan_steps"],
      };
    },
  });
  return {
    document: { metadata: result.item, body: result.body },
    resultStep,
    itemId: result.item.id,
  };
}

async function planAddStep(
  id: string,
  options: PlanCommandOptions,
  ctx: PlanWriteContext,
): Promise<PlanCommandResult> {
  const title = options.stepTitle?.trim();
  if (!title) {
    throw new PmCliError(
      "pm plan add-step requires --step-title",
      EXIT_CODE.USAGE,
    );
  }
  const status = asStepStatus(options.stepStatus, "pending");
  const allowMultipleActive = options.allowMultipleActive === true;

  const { document, resultStep, itemId } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: "plan_add_step",
    message: `plan add-step "${title}"`,
    mutator(steps) {
      const order = steps.length + 1;
      assertInProgressStepAllowed(
        steps,
        undefined,
        status,
        allowMultipleActive,
      );
      const step = buildAddedPlanStep(steps, options, { order, title, status });
      steps.push(step);
      return { changedSteps: [step.id], resultStep: step };
    },
  });

  const plan = projectPlan(document.metadata, "standard");
  return {
    action: "add-step",
    plan,
    step: resultStep,
    next_actions: nextActionsFor(itemId, plan),
    warnings: [],
    generated_at: nowIso(),
  };
}

function assertInProgressStepAllowed(
  steps: PlanStep[],
  currentStepId: string | undefined,
  desiredStatus: PlanStepStatus,
  allowMultipleActive: boolean,
): void {
  if (desiredStatus !== "in_progress" || allowMultipleActive) {
    return;
  }
  const activeStep = steps.find(
    (step) => step.id !== currentStepId && step.status === "in_progress",
  );
  if (!activeStep) {
    return;
  }
  throw new PmCliError(
    `Plan already has step ${activeStep.id} in_progress. Pass --allow-multiple-active or update that step first.`,
    EXIT_CODE.CONFLICT,
  );
}

function buildAddedPlanStep(
  existingSteps: PlanStep[],
  options: PlanCommandOptions,
  seed: { order: number; title: string; status: PlanStepStatus },
): PlanStep {
  const linkedItems = buildLinkInputs(options, "depends_on");
  const files = toSpecArray(options.file).map(parseStepFile);
  const tests = toSpecArray(options.test).map(parseStepTest);
  const docs = toSpecArray(options.doc).map(parseStepDoc);
  const now = nowIso();
  return {
    id: newStepId(existingSteps),
    order: seed.order,
    title: seed.title,
    body: options.stepBody?.trim() || undefined,
    status: seed.status,
    owner: options.stepOwner?.trim() || undefined,
    evidence: options.stepEvidence?.trim() || undefined,
    blocked_reason:
      seed.status === "blocked"
        ? options.stepBlockedReason?.trim() || ""
        : undefined,
    linked_items: linkedItems.length > 0 ? linkedItems : undefined,
    files: files.length > 0 ? files : undefined,
    tests: tests.length > 0 ? tests : undefined,
    docs: docs.length > 0 ? docs : undefined,
    created_at: now,
    updated_at: now,
    completed_at: seed.status === "completed" ? now : undefined,
  };
}

function buildLinkInputs(
  options: PlanCommandOptions,
  fallbackKind: PlanStepLinkKind,
): PlanStepLink[] {
  const dependsOn = toArray(options.dependsOn).map(
    (id) => ({ id, kind: fallbackKind }) as PlanStepLink,
  );
  const related = toArray(options.related).map(
    (id) => ({ id, kind: "related" }) as PlanStepLink,
  );
  const blocks = toArray(options.blocks).map(
    (id) => ({ id, kind: "blocks" }) as PlanStepLink,
  );
  const blockedBy = toArray(options.blockedBy).map(
    (id) => ({ id, kind: "blocked_by" }) as PlanStepLink,
  );
  const explicit = toArray(options.link);
  const explicitKind = asLinkKind(options.linkKind, fallbackKind);
  const note = options.linkNote?.trim();
  const explicitLinks = explicit.map((id) => {
    const link: PlanStepLink = { id, kind: explicitKind };
    if (note) link.note = note;
    return link;
  });
  return [...dependsOn, ...related, ...blocks, ...blockedBy, ...explicitLinks];
}

async function planUpdateStep(
  id: string,
  options: PlanCommandOptions,
  ctx: PlanWriteContext,
  args: {
    stepRef: string;
    finalStatus?: PlanStepStatus;
    op: string;
    allowMultipleActive?: boolean;
  },
): Promise<PlanCommandResult> {
  const { document, resultStep, itemId } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: args.op,
    message: options.message ?? `${args.op} ${args.stepRef}`,
    mutator(steps, doc) {
      const step = resolveStepRef(steps, args.stepRef);
      const now = nowIso();
      const desiredStatus =
        args.finalStatus ?? asStepStatus(options.stepStatus, step.status);
      const allowMultipleActive =
        options.allowMultipleActive === true ||
        args.allowMultipleActive === true;
      assertInProgressStepAllowed(
        steps,
        step.status === "in_progress" ? step.id : undefined,
        desiredStatus,
        allowMultipleActive,
      );
      applyStepUpdates(step, options, desiredStatus, now);
      doc.metadata.updated_at = now;
      return { changedSteps: [step.id], resultStep: step };
    },
  });
  const plan = projectPlan(document.metadata, "standard");
  return {
    action:
      args.op === "plan_complete_step"
        ? "complete-step"
        : args.op === "plan_block_step"
          ? "block-step"
          : "update-step",
    plan,
    step: resultStep,
    next_actions: nextActionsFor(itemId, plan),
    warnings: [],
    generated_at: nowIso(),
  };
}

function applyStepUpdates(
  step: PlanStep,
  options: PlanCommandOptions,
  desiredStatus: PlanStepStatus,
  now: string,
): void {
  assertBlockedStepReason(step, options, desiredStatus);
  applyStepFieldUpdates(step, options);
  step.status = desiredStatus;
  step.updated_at = now;
  applyStepCompletionTimestamp(step, desiredStatus, now);
}

function assertBlockedStepReason(
  step: PlanStep,
  options: PlanCommandOptions,
  desiredStatus: PlanStepStatus,
): void {
  if (
    desiredStatus !== "blocked" ||
    options.stepBlockedReason?.trim() ||
    step.blocked_reason
  ) {
    return;
  }
  throw new PmCliError(
    "Blocking a step requires --step-blocked-reason or an already-recorded blocked_reason.",
    EXIT_CODE.USAGE,
  );
}

function applyStepFieldUpdates(
  step: PlanStep,
  options: PlanCommandOptions,
): void {
  const title = options.stepTitle?.trim();
  if (title) {
    step.title = title;
  }
  if (options.stepBody !== undefined) {
    step.body = options.stepBody.trim() || undefined;
  }
  if (options.stepOwner !== undefined) {
    step.owner = options.stepOwner.trim() || undefined;
  }
  if (options.stepEvidence !== undefined) {
    step.evidence = options.stepEvidence.trim() || undefined;
  }
  if (options.stepBlockedReason !== undefined) {
    step.blocked_reason = options.stepBlockedReason.trim() || undefined;
  }
  if (options.stepReplacement !== undefined) {
    step.superseded_by = options.stepReplacement.trim() || undefined;
  }
}

function applyStepCompletionTimestamp(
  step: PlanStep,
  desiredStatus: PlanStepStatus,
  now: string,
): void {
  if (desiredStatus === "completed" && !step.completed_at) {
    step.completed_at = now;
    return;
  }
  if (desiredStatus !== "completed") {
    step.completed_at = undefined;
  }
}

async function planReorderStep(
  id: string,
  options: PlanCommandOptions,
  ctx: PlanWriteContext,
  stepRef: string,
  newOrder: number,
): Promise<PlanCommandResult> {
  const { document, itemId } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: "plan_reorder_step",
    message: options.message ?? `plan reorder-step ${stepRef} -> ${newOrder}`,
    mutator(steps) {
      const step = resolveStepRef(steps, stepRef);
      const filtered = steps.filter((entry) => entry.id !== step.id);
      const clamped = Math.max(1, Math.min(newOrder, filtered.length + 1));
      filtered.splice(clamped - 1, 0, step);
      filtered.forEach((entry, index) => {
        entry.order = index + 1;
        entry.updated_at = nowIso();
      });
      steps.length = 0;
      steps.push(...filtered);
      return { changedSteps: [step.id], resultStep: step };
    },
  });
  const plan = projectPlan(document.metadata, "standard");
  return {
    action: "reorder-step",
    plan,
    next_actions: nextActionsFor(itemId, plan),
    warnings: [],
    generated_at: nowIso(),
  };
}

async function planRemoveStep(
  id: string,
  options: PlanCommandOptions,
  ctx: PlanWriteContext,
  stepRef: string,
): Promise<PlanCommandResult> {
  const { document, itemId } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: "plan_remove_step",
    message: options.message ?? `plan remove-step ${stepRef}`,
    mutator(steps) {
      const step = resolveStepRef(steps, stepRef);
      const remaining = steps.filter((entry) => entry.id !== step.id);
      remaining.forEach((entry, index) => {
        entry.order = index + 1;
      });
      steps.length = 0;
      steps.push(...remaining);
      return { changedSteps: [step.id] };
    },
  });
  const plan = projectPlan(document.metadata, "standard");
  return {
    action: "remove-step",
    plan,
    next_actions: nextActionsFor(itemId, plan),
    warnings: [],
    generated_at: nowIso(),
  };
}

async function planLink(
  id: string,
  options: PlanCommandOptions,
  ctx: PlanWriteContext,
  stepRef: string,
): Promise<PlanCommandResult> {
  const newLinks = buildLinkInputs(
    options,
    asLinkKind(options.linkKind, "related"),
  );
  if (newLinks.length === 0) {
    throw new PmCliError(
      "pm plan link requires at least one --link/--related/--blocks/--blocked-by/--depends-on id",
      EXIT_CODE.USAGE,
    );
  }
  const promoteToItemDep = options.promoteToItemDep === true;
  const { document, itemId, resultStep } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: "plan_link_step",
    message: options.message ?? `plan link ${stepRef}`,
    mutator(steps, doc) {
      const step = resolveStepRef(steps, stepRef);
      const existing = step.linked_items ?? [];
      const dedupKey = (link: PlanStepLink) => `${link.kind}:${link.id}`;
      const seen = new Set(existing.map(dedupKey));
      for (const link of newLinks) {
        const key = dedupKey(link);
        if (seen.has(key)) continue;
        existing.push(link);
        seen.add(key);
      }
      step.linked_items = existing;
      step.updated_at = nowIso();
      if (promoteToItemDep) {
        const deps = doc.metadata.dependencies ?? [];
        const depKey = (dep: { id: string; kind: string }) =>
          `${dep.kind}:${dep.id}`;
        const seenDeps = new Set(deps.map(depKey));
        for (const link of newLinks) {
          const promotedKind: DependencyKind =
            link.kind === "depends_on" ? "blocked_by" : link.kind;
          const candidate = {
            id: link.id,
            kind: promotedKind,
            created_at: nowIso(),
            author: resolveAuthor(options.author, ctx.settings.author_default),
          };
          if (seenDeps.has(depKey(candidate))) continue;
          deps.push(candidate);
          seenDeps.add(depKey(candidate));
        }
        doc.metadata.dependencies = deps;
      }
      return { changedSteps: [step.id], resultStep: step };
    },
  });
  const plan = projectPlan(document.metadata, "standard");
  return {
    action: "link",
    plan,
    step: resultStep,
    next_actions: nextActionsFor(itemId, plan),
    warnings: [],
    generated_at: nowIso(),
  };
}

async function planUnlink(
  id: string,
  options: PlanCommandOptions,
  ctx: PlanWriteContext,
  stepRef: string,
): Promise<PlanCommandResult> {
  const removeIds = toArray(options.link);
  if (removeIds.length === 0) {
    throw new PmCliError(
      "pm plan unlink requires --link <id> to remove",
      EXIT_CODE.USAGE,
    );
  }
  const { document, itemId, resultStep } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: "plan_unlink_step",
    message: options.message ?? `plan unlink ${stepRef}`,
    mutator(steps) {
      const step = resolveStepRef(steps, stepRef);
      const filtered = (step.linked_items ?? []).filter(
        (link) => !removeIds.includes(link.id),
      );
      step.linked_items = filtered.length > 0 ? filtered : undefined;
      step.updated_at = nowIso();
      return { changedSteps: [step.id], resultStep: step };
    },
  });
  const plan = projectPlan(document.metadata, "standard");
  return {
    action: "unlink",
    plan,
    step: resultStep,
    next_actions: nextActionsFor(itemId, plan),
    warnings: [],
    generated_at: nowIso(),
  };
}

async function planAppendLog(
  id: string,
  options: PlanCommandOptions,
  ctx: PlanWriteContext,
  kind: "decision" | "discovery" | "validation",
): Promise<PlanCommandResult> {
  const logText = resolvePlanLogText(kind, options);
  if (!logText) {
    const canonical = `--${kind}-text`;
    const shorthand = `--${kind}`;
    throw new PmCliError(
      `pm plan ${kind} requires ${canonical}`,
      EXIT_CODE.USAGE,
      {
        code: "missing_required_option",
        examples: [
          `pm plan ${kind} <plan-id> ${canonical} "..."`,
          `pm plan ${kind} <plan-id> ${shorthand} "..."`,
        ],
        recovery: {
          suggested_retry: `pm plan ${kind} <plan-id> ${canonical} <value>`,
        },
      },
    );
  }
  const author = resolveAuthor(options.author, ctx.settings.author_default);
  const { document, itemId } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: `plan_append_${kind}`,
    message: options.message ?? `plan ${kind} append`,
    mutator(_steps, doc) {
      const now = nowIso();
      if (kind === "decision") {
        const list = doc.metadata.plan_decisions ?? [];
        list.push({
          ts: now,
          author,
          decision: logText,
          rationale: options.decisionRationale?.trim() || undefined,
          evidence: options.decisionEvidence?.trim() || undefined,
        });
        doc.metadata.plan_decisions = list;
        return { changedSteps: [] };
      }
      if (kind === "discovery") {
        const list = doc.metadata.plan_discoveries ?? [];
        list.push({ ts: now, author, text: logText });
        doc.metadata.plan_discoveries = list;
        return { changedSteps: [] };
      }
      const list = doc.metadata.plan_validation ?? [];
      list.push({
        text: logText,
        command: options.validationCommand?.trim() || undefined,
        expected: options.validationExpected?.trim() || undefined,
      });
      doc.metadata.plan_validation = list;
      return { changedSteps: [] };
    },
  });
  const plan = projectPlan(document.metadata, "deep");
  return {
    action: kind,
    plan,
    next_actions: nextActionsFor(itemId, plan),
    warnings: [],
    generated_at: nowIso(),
  };
}

async function planResume(
  id: string,
  options: PlanCommandOptions,
  ctx: PlanWriteContext,
): Promise<PlanCommandResult> {
  const text = options.resumeContext?.trim();
  if (!text) {
    throw new PmCliError(
      "pm plan resume requires --resume-context <text>",
      EXIT_CODE.USAGE,
    );
  }
  const { document, itemId } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: "plan_resume",
    message: options.message ?? "plan resume context update",
    mutator(_steps, doc) {
      doc.metadata.plan_resume_context = text;
      return { changedSteps: [] };
    },
  });
  const plan = projectPlan(document.metadata, "brief");
  return {
    action: "resume",
    plan,
    next_actions: nextActionsFor(itemId, plan),
    warnings: [],
    generated_at: nowIso(),
  };
}

async function planApprove(
  id: string,
  options: PlanCommandOptions,
  ctx: PlanWriteContext,
): Promise<PlanCommandResult> {
  const mode = asPlanMode(options.mode ?? "approved", "approved");
  const { document, itemId } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: "plan_approve",
    message: options.message ?? `plan approve mode=${mode}`,
    mutator(_steps, doc) {
      doc.metadata.plan_mode = mode;
      return { changedSteps: [] };
    },
  });
  const plan = projectPlan(document.metadata, "brief");
  return {
    action: "approve",
    plan,
    next_actions: nextActionsFor(itemId, plan),
    warnings: [],
    generated_at: nowIso(),
  };
}

function buildMaterializeSkippedWarnings(
  materializeSkipped: {
    from_step: string;
    reason: "already_completed" | "already_materialized";
    existing_id?: string;
  }[],
): string[] {
  return materializeSkipped.map(
    (entry) =>
      `plan_materialize_skipped:${entry.from_step}:${entry.reason}${entry.existing_id ? `:${entry.existing_id}` : ""}`,
  );
}

function buildMaterializeNoopResult(
  planRead: { document: ItemDocument; itemId: string },
  materializeSkipped: {
    from_step: string;
    reason: "already_completed" | "already_materialized";
    existing_id?: string;
  }[],
): PlanCommandResult {
  const plan = projectPlan(planRead.document.metadata, "standard");
  return {
    action: "materialize",
    plan,
    materialized: [],
    materialize_skipped: materializeSkipped,
    next_actions: nextActionsFor(planRead.itemId, plan),
    warnings: buildMaterializeSkippedWarnings(materializeSkipped),
    generated_at: nowIso(),
  };
}

function buildMaterializeDependencies(
  parent: string,
  planItemId: string,
  step: PlanStep,
): string[] {
  const deps = [
    `id=${parent},kind=parent`,
    `id=${planItemId},kind=discovered_from`,
  ];
  for (const link of step.linked_items ?? []) {
    const realKind: DependencyKind =
      link.kind === "blocked_by" ||
      link.kind === "blocks" ||
      link.kind === "related" ||
      link.kind === "discovered_from"
        ? link.kind
        : "related";
    deps.push(`id=${link.id},kind=${realKind}`);
  }
  return deps;
}

async function createMaterializedStepItems(params: {
  targets: PlanStep[];
  parent: string;
  planItemId: string;
  resolvedTypeName: string;
  tags: string | undefined;
  options: PlanCommandOptions;
  pmRoot: string;
}): Promise<
  {
    id: string;
    title: string;
    type: string;
    parent?: string;
    tags: string[];
    from_step: string;
  }[]
> {
  const materialized: {
    id: string;
    title: string;
    type: string;
    parent?: string;
    tags: string[];
    from_step: string;
  }[] = [];
  const materializeFields: Record<string, string> = {};
  const reservedMaterializeKeys = new Set([
    "title",
    "description",
    "type",
    "parent",
    "tags",
    "author",
    "message",
    "dep",
  ]);
  for (const specification of toSpecArray(params.options.field)) {
    const separator = specification.indexOf("=");
    if (separator <= 0) {
      throw new PmCliError(
        `Invalid --field entry "${specification}"; expected name=value`,
        EXIT_CODE.USAGE,
      );
    }
    const name = specification.slice(0, separator).trim();
    const value = specification.slice(separator + 1).trim();
    if (name.length === 0) {
      throw new PmCliError(
        `Invalid --field entry "${specification}"; expected name=value`,
        EXIT_CODE.USAGE,
      );
    }
    const segments = name
      .trim()
      .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replaceAll(/[^A-Za-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((segment) => segment.toLowerCase());
    if (segments.length === 0) {
      throw new PmCliError(
        `Invalid --field entry "${specification}"; expected name=value`,
        EXIT_CODE.USAGE,
      );
    }
    const [first, ...rest] = segments;
    const fieldKey = `${first}${rest.map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`).join("")}`;
    if (reservedMaterializeKeys.has(fieldKey)) {
      throw new PmCliError(
        `Invalid --field entry "${specification}"; "${fieldKey}" is reserved by materialize and cannot be overridden`,
        EXIT_CODE.USAGE,
      );
    }
    materializeFields[fieldKey] = value;
  }
  for (const step of params.targets) {
    const created = await runCreate(
      {
        ...materializeFields,
        title: step.title,
        description: step.body?.trim() || step.title,
        type: params.resolvedTypeName,
        parent: params.parent,
        tags: params.tags,
        author: params.options.author,
        message:
          params.options.message ??
          `materialized from plan ${params.planItemId} step ${step.id}`,
        dep: buildMaterializeDependencies(
          params.parent,
          params.planItemId,
          step,
        ),
      },
      { ...({} as GlobalOptions), path: params.pmRoot } as GlobalOptions,
    );
    materialized.push({
      id: created.item.id,
      title: created.item.title,
      type: params.resolvedTypeName,
      parent: created.item.parent,
      tags: created.item.tags ?? [],
      from_step: step.id,
    });
  }
  return materialized;
}

function linkMaterializedStepItems(
  currentSteps: PlanStep[],
  targets: PlanStep[],
  materialized: { id: string; type: string; from_step: string }[],
): void {
  for (const target of targets) {
    const matched = materialized.find((entry) => entry.from_step === target.id);
    if (!matched) {
      continue;
    }
    const step = currentSteps.find((entry) => entry.id === target.id);
    if (!step) {
      continue;
    }
    const links = step.linked_items ?? [];
    links.push({
      id: matched.id,
      kind: "implements",
      note: `materialized as ${matched.type}`,
    });
    step.linked_items = links;
    step.updated_at = nowIso();
  }
}

async function planMaterialize(
  id: string,
  options: PlanCommandOptions,
  ctx: PlanWriteContext,
): Promise<PlanCommandResult> {
  const stepRefs = toArray(options.steps);
  if (stepRefs.length === 0) {
    throw new PmCliError(
      "pm plan materialize requires --steps <ids|orders|all>",
      EXIT_CODE.USAGE,
    );
  }
  const targetType = options.materializeType?.trim() || "Task";
  const typeRegistry = resolveItemTypeRegistry(
    ctx.settings,
    getActiveExtensionRegistrations(),
  );
  const resolvedTypeName = resolveTypeName(targetType, typeRegistry);
  if (!resolvedTypeName) {
    throw new PmCliError(
      `Invalid --materialize-type "${targetType}"`,
      EXIT_CODE.USAGE,
    );
  }
  const parent = options.materializeParent?.trim() || id;
  const tags = options.materializeTags;

  const planRead = await readPlanItem(ctx, id);
  const steps = (planRead.document.metadata.plan_steps ?? []).slice();
  const { targets, skipped: materializeSkipped } = resolveMaterializeTargets(
    steps,
    stepRefs,
  );
  if (targets.length === 0) {
    if (materializeSkipped.length > 0) {
      return buildMaterializeNoopResult(planRead, materializeSkipped);
    }
    throw new PmCliError(
      "No matching plan steps found for --steps",
      EXIT_CODE.NOT_FOUND,
    );
  }

  const materialized = await createMaterializedStepItems({
    targets,
    parent,
    planItemId: planRead.itemId,
    resolvedTypeName,
    tags,
    options,
    pmRoot: ctx.pmRoot,
  });

  const { document, itemId } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: "plan_materialize",
    message: options.message ?? `plan materialize ${stepRefs.join(",")}`,
    mutator(currentSteps) {
      linkMaterializedStepItems(currentSteps, targets, materialized);
      return { changedSteps: targets.map((entry) => entry.id) };
    },
  });
  const plan = projectPlan(document.metadata, "standard");
  return {
    action: "materialize",
    plan,
    materialized,
    ...(materializeSkipped.length > 0
      ? { materialize_skipped: materializeSkipped }
      : {}),
    next_actions: nextActionsFor(itemId, plan),
    warnings: buildMaterializeSkippedWarnings(materializeSkipped),
    generated_at: nowIso(),
  };
}

/* c8 ignore stop */
/** Documents the plan dispatch input payload exchanged by command, SDK, and package integrations. */
export interface PlanDispatchInput {
  /** Value that configures or reports subcommand for this contract. */
  subcommand: PlanSubcommand;
  /** Stable identifier used to reference this record across commands and storage. */
  id?: string;
  /** Value that configures or reports step ref for this contract. */
  stepRef?: string;
  /** Value that configures or reports reorder to for this contract. */
  reorderTo?: number;
  /** Value that configures or reports options for this contract. */
  options: PlanCommandOptions;
  /** Value that configures or reports global for this contract. */
  global: GlobalOptions;
}

function normalizePlanStepAliasInput(
  input: PlanDispatchInput,
): PlanDispatchInput {
  if (input.subcommand === "create") {
    return input;
  }
  const stepValues = toOrderedStepTitles(input.options.step);
  if (stepValues.length > 1) {
    throw new PmCliError(
      `pm plan ${input.subcommand} accepts a single --step/--step-title value (repeated --step seeds ordered steps only on pm plan create)`,
      EXIT_CODE.USAGE,
    );
  }
  if (stepValues.length === 1 && !input.options.stepTitle?.trim()) {
    return {
      ...input,
      options: { ...input.options, stepTitle: stepValues[0] },
    };
  }
  return input;
}

function requirePlanId(
  input: PlanDispatchInput,
  label: PlanSubcommand,
): string {
  if (!input.id) {
    throw new PmCliError(
      `pm plan ${label} requires a plan id`,
      EXIT_CODE.USAGE,
    );
  }
  return input.id;
}

function requirePlanStepRef(
  input: PlanDispatchInput,
  label: PlanSubcommand,
): { id: string; stepRef: string } {
  const id = requirePlanId(input, label);
  if (!input.stepRef) {
    throw new PmCliError(
      `pm plan ${label} requires <plan-id> <step>`,
      EXIT_CODE.USAGE,
    );
  }
  return { id, stepRef: input.stepRef };
}

function requireReorderTarget(input: PlanDispatchInput): {
  id: string;
  stepRef: string;
  reorderTo: number;
} {
  const target = requirePlanStepRef(input, "reorder-step");
  if (input.reorderTo === undefined) {
    throw new PmCliError(
      "pm plan reorder-step requires <plan-id> <step> <new-order>",
      EXIT_CODE.USAGE,
    );
  }
  return { ...target, reorderTo: input.reorderTo };
}

type PlanDispatcher = (
  input: PlanDispatchInput,
  ctx: PlanWriteContext,
) => Promise<PlanCommandResult>;

const PLAN_DISPATCHERS: Record<PlanSubcommand, PlanDispatcher> = {
  create: (input, ctx) => planCreate(input.options, input.global, ctx),
  show: (input, ctx) =>
    planShow(requirePlanId(input, "show"), input.options, ctx),
  "add-step": (input, ctx) =>
    planAddStep(requirePlanId(input, "add-step"), input.options, ctx),
  "update-step": (input, ctx) => {
    const target = requirePlanStepRef(input, "update-step");
    return planUpdateStep(target.id, input.options, ctx, {
      stepRef: target.stepRef,
      op: "plan_update_step",
    });
  },
  "complete-step": (input, ctx) => {
    const target = requirePlanStepRef(input, "complete-step");
    return planUpdateStep(target.id, input.options, ctx, {
      stepRef: target.stepRef,
      finalStatus: "completed",
      op: "plan_complete_step",
    });
  },
  "block-step": (input, ctx) => {
    const target = requirePlanStepRef(input, "block-step");
    return planUpdateStep(target.id, input.options, ctx, {
      stepRef: target.stepRef,
      finalStatus: "blocked",
      op: "plan_block_step",
    });
  },
  "reorder-step": (input, ctx) => {
    const target = requireReorderTarget(input);
    return planReorderStep(
      target.id,
      input.options,
      ctx,
      target.stepRef,
      target.reorderTo,
    );
  },
  "remove-step": (input, ctx) => {
    const target = requirePlanStepRef(input, "remove-step");
    return planRemoveStep(target.id, input.options, ctx, target.stepRef);
  },
  link: (input, ctx) => {
    const target = requirePlanStepRef(input, "link");
    return planLink(target.id, input.options, ctx, target.stepRef);
  },
  unlink: (input, ctx) => {
    const target = requirePlanStepRef(input, "unlink");
    return planUnlink(target.id, input.options, ctx, target.stepRef);
  },
  decision: (input, ctx) =>
    planAppendLog(
      requirePlanId(input, "decision"),
      input.options,
      ctx,
      "decision",
    ),
  discovery: (input, ctx) =>
    planAppendLog(
      requirePlanId(input, "discovery"),
      input.options,
      ctx,
      "discovery",
    ),
  validation: (input, ctx) =>
    planAppendLog(
      requirePlanId(input, "validation"),
      input.options,
      ctx,
      "validation",
    ),
  resume: (input, ctx) =>
    planResume(requirePlanId(input, "resume"), input.options, ctx),
  approve: (input, ctx) =>
    planApprove(requirePlanId(input, "approve"), input.options, ctx),
  materialize: (input, ctx) =>
    planMaterialize(requirePlanId(input, "materialize"), input.options, ctx),
};

function resolvePlanDispatcher(subcommand: PlanSubcommand): PlanDispatcher {
  const dispatcher = PLAN_DISPATCHERS[subcommand];
  if (!dispatcher) {
    throw new PmCliError(
      `Unknown pm plan subcommand "${subcommand}"`,
      EXIT_CODE.USAGE,
    );
  }
  return dispatcher;
}

/** Implements run plan for the public runtime surface of this module. */
export async function runPlan(
  input: PlanDispatchInput,
): Promise<PlanCommandResult> {
  const ctx = await loadContext(input.global);
  const normalizedInput = normalizePlanStepAliasInput(input);
  return resolvePlanDispatcher(normalizedInput.subcommand)(
    normalizedInput,
    ctx,
  );
}
