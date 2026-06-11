import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry, resolveTypeName } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { splitCommaList } from "../../core/shared/split-comma-list.js";
import { nowIso } from "../../core/shared/time.js";
import { locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
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
import { runCreate, type CreateCommandOptions, type CreateResult } from "./create.js";

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
export type PlanSubcommand = (typeof PLAN_SUBCOMMANDS)[number];

export const PLAN_SHOW_DEPTH_VALUES = ["brief", "standard", "deep"] as const;
export type PlanShowDepth = (typeof PLAN_SHOW_DEPTH_VALUES)[number];

export interface PlanCommandOptions {
  title?: string;
  description?: string;
  scope?: string;
  parent?: string;
  related?: string | string[];
  blocks?: string | string[];
  blockedBy?: string | string[];
  harness?: string;
  mode?: string;
  resumeContext?: string;
  tags?: string;
  priority?: string;
  body?: string;
  claim?: boolean;
  fromSearch?: string;
  stepTitle?: string;
  /**
   * pm-6mit: repeatable --step values. On create each value seeds one ordered
   * step (argv order; values are never comma-split so titles may contain
   * commas). On other subcommands a single value aliases stepTitle.
   */
  step?: string | string[];
  stepBody?: string;
  stepOwner?: string;
  stepStatus?: string;
  stepEvidence?: string;
  stepBlockedReason?: string;
  stepReplacement?: string;
  dependsOn?: string | string[];
  link?: string | string[];
  linkKind?: string;
  linkNote?: string;
  promoteToItemDep?: boolean;
  allowMultipleActive?: boolean;
  file?: string | string[];
  test?: string | string[];
  doc?: string | string[];
  decisionText?: string;
  decision?: string;
  decisionRationale?: string;
  decisionEvidence?: string;
  discoveryText?: string;
  discovery?: string;
  validationText?: string;
  validation?: string;
  validationCommand?: string;
  validationExpected?: string;
  depth?: string;
  fields?: string;
  steps?: string;
  materializeType?: string;
  materializeParent?: string;
  materializeTags?: string;
  author?: string;
  message?: string;
  force?: boolean;
}

export interface PlanCommandResult {
  action: PlanSubcommand;
  plan: PlanResultPlan;
  step?: PlanStep;
  current_step?: PlanStep | undefined;
  next_actions?: string[];
  materialized?: { id: string; type: string; from_step: string }[];
  // pm-fl0c #10 (2026-05-28): steps that pm plan materialize intentionally
  // skipped (already-completed or already-materialized via an `implements`
  // link). Surfacing these makes `--steps all` idempotent without users
  // having to read history to find out what was done.
  materialize_skipped?: { from_step: string; reason: "already_completed" | "already_materialized"; existing_id?: string }[];
  warnings: string[];
  generated_at: string;
}

export interface PlanResultPlan {
  id: string;
  title: string;
  status: string;
  mode: PlanMode;
  scope?: string;
  harness?: PlanHarness;
  parent?: string;
  resume_context?: string;
  steps_summary: PlanStepSummary;
  current_step?: { id: string; order: number; title: string; status: PlanStepStatus } | undefined;
  blocked_steps?: { id: string; order: number; title: string; blocked_reason?: string }[];
  steps?: PlanStep[];
  decisions?: PlanDecision[];
  discoveries?: PlanDiscovery[];
  validation?: PlanValidationCheck[];
  linked_items?: { id: string; kind: DependencyKind }[];
}

export interface PlanStepSummary {
  total: number;
  pending: number;
  in_progress: number;
  blocked: number;
  completed: number;
  skipped: number;
  superseded: number;
}

const STEP_ID_PREFIX = "plan-step-";
const DEFAULT_PLAN_MODE: PlanMode = "draft";

function resolveAuthor(candidate: string | undefined, fallback: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? fallback;
  const trimmed = resolved.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

/**
 * pm-6mit: ordered step titles from repeated --step values. Unlike toArray
 * this NEVER comma-splits — each --step value is one full step title, so
 * titles containing commas survive intact (also why --step must not be
 * list:true in contracts: the bootstrap coalescer would comma-join values).
 */
function toOrderedStepTitles(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values
    .filter((entry) => entry !== undefined && entry !== null)
    .map((entry) => (typeof entry === "string" ? entry : String(entry)).trim())
    .filter((entry) => entry.length > 0);
}

function toArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => splitCommaList(entry, { unique: false }));
  if (typeof value === "string" && value.trim().length > 0) {
    return splitCommaList(value, { unique: false });
  }
  return [];
}

function toSpecArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((entry) => entry.trim()).filter(Boolean);
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
  return [];
}

function asPlanMode(value: string | undefined, fallback: PlanMode = DEFAULT_PLAN_MODE): PlanMode {
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

function asStepStatus(value: string | undefined, fallback: PlanStepStatus = "pending"): PlanStepStatus {
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

function asLinkKind(value: string | undefined, fallback: PlanStepLinkKind = "related"): PlanStepLinkKind {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  const found = PLAN_STEP_LINK_KIND_VALUES.find((entry) => entry === normalized);
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
    throw new PmCliError("Plan --fields requires a comma-separated list of plan field names", EXIT_CODE.USAGE);
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

function projectPlanForFields(plan: PlanResultPlan, fields: string[]): PlanResultPlan {
  const source = plan as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  const unknownFields: string[] = [];
  for (const field of fields) {
    const normalized = field.startsWith("plan.") ? field.slice("plan.".length) : field;
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
    throw new PmCliError(`Unknown Plan --fields value(s): ${unknownFields.join(", ")}`, EXIT_CODE.USAGE, {
      nextSteps: [
        `Use --fields ${[...PLAN_FIELD_KEYS].join(",")}`,
        "Run pm plan show <id> --depth brief for compact default fields.",
      ],
      recovery: {
        provided_fields: unknownFields,
        suggested_retry: `pm plan show <id> --fields ${[...PLAN_FIELD_KEYS].join(",")}`,
      },
    });
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
      throw new PmCliError(`Invalid ${label} entry "${trimmed}"; expected key=value`, EXIT_CODE.USAGE);
    }
    out[trimmed.slice(0, equalsIndex).trim().toLowerCase()] = trimmed.slice(equalsIndex + 1).trim();
  }
  return out;
}

function parseStepFile(spec: string): PlanStepFile {
  const fields = parsePairList(spec, "--file");
  if (!fields.path) {
    throw new PmCliError("--file requires path=<value>", EXIT_CODE.USAGE);
  }
  const file: PlanStepFile = { path: fields.path };
  if (fields.scope === "global" || fields.scope === "project") file.scope = fields.scope;
  if (fields.note) file.note = fields.note;
  return file;
}

function parseStepTest(spec: string): PlanStepTest {
  const fields = parsePairList(spec, "--test");
  if (!fields.command && !fields.path) {
    throw new PmCliError("--test requires at least command=<value> or path=<value>", EXIT_CODE.USAGE);
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
  if (fields.scope === "global" || fields.scope === "project") doc.scope = fields.scope;
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
  };
  for (const step of steps) {
    summary[step.status] += 1;
  }
  return summary;
}

function newStepId(existing: PlanStep[]): string {
  const used = new Set(existing.map((step) => step.id));
  for (let cursor = existing.length + 1; cursor < existing.length + 1024; cursor += 1) {
    const candidate = `${STEP_ID_PREFIX}${String(cursor).padStart(3, "0")}`;
    if (!used.has(candidate)) return candidate;
  }
  /* c8 ignore next -- step id allocation only fails if 1024 consecutive ids are taken. */
  throw new PmCliError("Could not allocate step id (limit reached)", EXIT_CODE.GENERIC_FAILURE);
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
  skipped: { from_step: string; reason: "already_completed" | "already_materialized"; existing_id?: string }[];
}

// pm-fl0c #10 (2026-05-28): skip steps whose status is "completed" and steps
// that already have an `implements` link from a prior materialize run, so
// `pm plan materialize --steps all` is idempotent and never re-creates fresh
// Tasks for work already tracked. Explicit step refs are still allowed
// through (the user asked by ID) but the skip-reason is recorded.
function classifyMaterializeSkip(
  step: PlanStep,
): { reason: "already_completed" | "already_materialized"; existing_id?: string } | undefined {
  if (step.status === "completed") {
    return { reason: "already_completed" };
  }
  const existingImplements = (step.linked_items ?? []).find((link) => link.kind === "implements");
  if (existingImplements) {
    return { reason: "already_materialized", existing_id: existingImplements.id };
  }
  return undefined;
}

function resolveMaterializeTargets(steps: PlanStep[], refs: string[]): MaterializeTargetResolution {
  const allRefs = refs.filter((ref) => ref.trim().toLowerCase() === "all");
  const targets: PlanStep[] = [];
  const skipped: { from_step: string; reason: "already_completed" | "already_materialized"; existing_id?: string }[] = [];
  if (allRefs.length > 0) {
    if (refs.length > allRefs.length) {
      throw new PmCliError("pm plan materialize --steps all cannot be combined with other step refs", EXIT_CODE.USAGE);
    }
    for (const step of steps.slice().sort((left, right) => left.order - right.order)) {
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

function resolvePlanLogText(kind: "decision" | "discovery" | "validation", options: PlanCommandOptions): string | undefined {
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
  return steps.find((step) => step.status === "in_progress")
    ?? steps.find((step) => step.status === "pending");
}

function blockedSteps(steps: PlanStep[]): { id: string; order: number; title: string; blocked_reason?: string }[] {
  return steps
    .filter((step) => step.status === "blocked")
    .map((step) => ({ id: step.id, order: step.order, title: step.title, blocked_reason: step.blocked_reason }));
}

function projectPlan(item: ItemMetadata, depth: PlanShowDepth = "brief"): PlanResultPlan {
  const steps = (item.plan_steps ?? []).slice().sort((left, right) => left.order - right.order);
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
      ? { id: current.id, order: current.order, title: current.title, status: current.status }
      : undefined,
    blocked_steps: blockedSteps(steps),
    linked_items: (item.dependencies ?? []).map((dep) => ({ id: dep.id, kind: dep.kind })),
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
  if (plan.steps_summary.completed === plan.steps_summary.total && plan.steps_summary.total > 0) {
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
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  return { pmRoot, settings };
}

async function readPlanItem(ctx: PlanWriteContext, id: string): Promise<{ document: ItemDocument; itemId: string }> {
  const typeRegistry = resolveItemTypeRegistry(ctx.settings, getActiveExtensionRegistrations());
  const located = await locateItem(ctx.pmRoot, id, ctx.settings.id_prefix, ctx.settings.item_format, typeRegistry.type_to_folder);
  if (!located) {
    throw new PmCliError(`Plan ${id} not found`, EXIT_CODE.NOT_FOUND);
  }
  const loaded = await readLocatedItem(located, { schema: ctx.settings.schema });
  ensurePlanItem(loaded.document.metadata);
  return { document: loaded.document, itemId: located.id };
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
      examples: ['pm plan create --title "Refactor lock retry" --scope pm-a1b2'],
    });
  }
  const mode = asPlanMode(options.mode, DEFAULT_PLAN_MODE);
  const harness = asHarness(options.harness);
  const fromSearch = options.fromSearch?.trim();

  const related = toArray(options.related);
  const blocks = toArray(options.blocks);
  const blockedBy = toArray(options.blockedBy);

  const deps: string[] = [];
  if (options.parent) {
    deps.push(`id=${options.parent.trim()},kind=parent`);
  }
  for (const ref of related) deps.push(`id=${ref},kind=related`);
  for (const ref of blocks) deps.push(`id=${ref},kind=blocks`);
  for (const ref of blockedBy) deps.push(`id=${ref},kind=blocked_by`);

  const description = options.description?.trim() ?? options.scope?.trim() ?? title;
  const createOptions: CreateCommandOptions = {
    title,
    description,
    type: "Plan",
    body: options.body,
    tags: options.tags,
    priority: options.priority,
    parent: options.parent,
    dep: deps.length > 0 ? deps : undefined,
    author: options.author,
    message: options.message ?? (fromSearch ? `plan create (search: ${fromSearch})` : `plan create`),
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
      const changed: string[] = [];
      doc.metadata.plan_mode = mode;
      changed.push("plan_mode");
      if (harness) {
        doc.metadata.plan_harness = harness;
        changed.push("plan_harness");
      }
      if (options.scope?.trim()) {
        doc.metadata.plan_scope = options.scope.trim();
        changed.push("plan_scope");
      }
      if (options.resumeContext?.trim()) {
        doc.metadata.plan_resume_context = options.resumeContext.trim();
        changed.push("plan_resume_context");
      }
      doc.metadata.plan_steps = doc.metadata.plan_steps ?? [];
      return { changedFields: changed };
    },
  });

  let finalMetadata: ItemMetadata = seedResult.item as unknown as ItemMetadata;
  let initialStep: PlanStep | undefined;
  const initialValidationText = options.validationText?.trim();
  const initialValidationCommand = options.validationCommand?.trim();
  const initialValidationExpected = options.validationExpected?.trim();
  const initialValidation =
    initialValidationText || initialValidationCommand || initialValidationExpected
      ? ({
          text: initialValidationText || initialValidationCommand || "Validation check",
          command: initialValidationCommand || undefined,
          expected: initialValidationExpected || undefined,
        } satisfies PlanValidationCheck)
      : undefined;
  // pm-6mit: collect ordered initial-step titles. Mixed-usage semantics
  // (documented on pm-6mit): --step-title (when present) is the FIRST step,
  // followed by each repeated --step value in argv order.
  const stepTitleFlag = options.stepTitle?.trim();
  const repeatedStepTitles = toOrderedStepTitles(options.step);
  const stepTitles = stepTitleFlag ? [stepTitleFlag, ...repeatedStepTitles] : repeatedStepTitles;
  const hasPerStepDetailOptions =
    Boolean(options.stepBody?.trim()) ||
    Boolean(options.stepOwner?.trim()) ||
    Boolean(options.stepStatus?.trim()) ||
    Boolean(options.stepEvidence?.trim()) ||
    Boolean(options.stepBlockedReason?.trim()) ||
    Boolean(options.stepReplacement?.trim()) ||
    toArray(options.dependsOn).length > 0 ||
    toArray(options.link).length > 0 ||
    toSpecArray(options.file).length > 0 ||
    toSpecArray(options.test).length > 0 ||
    toSpecArray(options.doc).length > 0;
  if (stepTitles.length > 1 && hasPerStepDetailOptions) {
    // Per-step detail flags target exactly one step; silently attaching them to
    // the first (or all) of several seeded steps would be unpredictable.
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
  let initialSteps: PlanStep[] = [];
  if (stepTitles.length === 1) {
    const status = asStepStatus(options.stepStatus, "pending");
    const linkedItems = buildLinkInputs(options, "depends_on");
    const files = toSpecArray(options.file).map(parseStepFile);
    const tests = toSpecArray(options.test).map(parseStepTest);
    const docs = toSpecArray(options.doc).map(parseStepDoc);
    const now = nowIso();
    initialSteps = [{
      id: "plan-step-001",
      order: 1,
      title: stepTitles[0],
      body: options.stepBody?.trim() || undefined,
      status,
      owner: options.stepOwner?.trim() || undefined,
      evidence: options.stepEvidence?.trim() || undefined,
      blocked_reason: status === "blocked" ? options.stepBlockedReason?.trim() || "" : undefined,
      linked_items: linkedItems.length > 0 ? linkedItems : undefined,
      files: files.length > 0 ? files : undefined,
      tests: tests.length > 0 ? tests : undefined,
      docs: docs.length > 0 ? docs : undefined,
      created_at: now,
      updated_at: now,
      completed_at: status === "completed" ? now : undefined,
    }];
  } else if (stepTitles.length > 1) {
    const now = nowIso();
    initialSteps = stepTitles.map((stepTitle, index) => ({
      id: `${STEP_ID_PREFIX}${String(index + 1).padStart(3, "0")}`,
      order: index + 1,
      title: stepTitle,
      status: "pending" as const,
      created_at: now,
      updated_at: now,
    }));
  }
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
        ensurePlanItem(doc.metadata);
        doc.metadata.plan_steps = initialSteps;
        if (initialValidation) {
          doc.metadata.plan_validation = [...(doc.metadata.plan_validation ?? []), initialValidation];
        }
        return { changedFields: initialValidation ? ["plan_steps", "plan_validation"] : ["plan_steps"] };
      },
    });
    finalMetadata = stepped.item as unknown as ItemMetadata;
  } else if (initialValidation) {
    const validated = await mutateItem({
      pmRoot: ctx.pmRoot,
      settings: ctx.settings,
      id: createResult.item.id,
      op: "plan_create_initial_validation",
      author: resolveAuthor(options.author, ctx.settings.author_default),
      message: "plan create initial validation",
      mutate(doc) {
        ensurePlanItem(doc.metadata);
        doc.metadata.plan_validation = [...(doc.metadata.plan_validation ?? []), initialValidation];
        return { changedFields: ["plan_validation"] };
      },
    });
    finalMetadata = validated.item as unknown as ItemMetadata;
  } else if (hasPerStepDetailOptions) {
    throw new PmCliError("pm plan create step options require --step-title (or a single --step)", EXIT_CODE.USAGE, {
      code: "missing_required_option",
      examples: ['pm plan create --title "Execution plan" --step-title "Read the code"'],
    });
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
        doc.metadata.assignee = resolveAuthor(options.author, ctx.settings.author_default);
        return { changedFields: ["assignee"] };
      },
    });
    finalMetadata = claimed.item as unknown as ItemMetadata;
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
  const fullPlan = projectPlan(document.metadata, fields === null ? depth : "deep");
  const plan = fields === null ? fullPlan : projectPlanForFields(fullPlan, fields);
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
  mutator(steps: PlanStep[], doc: ItemDocument): { changedSteps: string[]; current?: PlanStep; resultStep?: PlanStep };
}

async function mutatePlanSteps(args: MutateStepArgs): Promise<{ document: ItemDocument; resultStep?: PlanStep; itemId: string }> {
  const author = resolveAuthor(args.options.author, args.ctx.settings.author_default);
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
      return { changedFields: changedFields.length > 0 ? changedFields : ["plan_steps"] };
    },
  });
  return {
    document: { metadata: result.item as unknown as ItemMetadata, body: result.body },
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
    throw new PmCliError("pm plan add-step requires --step-title", EXIT_CODE.USAGE);
  }
  const status = asStepStatus(options.stepStatus, "pending");
  const allowMultipleActive = options.allowMultipleActive === true;

  const linkedItems = buildLinkInputs(options, "depends_on");

  const files = toSpecArray(options.file).map(parseStepFile);
  const tests = toSpecArray(options.test).map(parseStepTest);
  const docs = toSpecArray(options.doc).map(parseStepDoc);

  const { document, resultStep, itemId } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: "plan_add_step",
    message: `plan add-step "${title}"`,
    mutator(steps) {
      const order = steps.length + 1;
      if (status === "in_progress" && !allowMultipleActive) {
        for (const step of steps) {
          if (step.status === "in_progress") {
            throw new PmCliError(
              `Plan already has step ${step.id} in_progress. Pass --allow-multiple-active or update that step first.`,
              EXIT_CODE.CONFLICT,
            );
          }
        }
      }
      const now = nowIso();
      const step: PlanStep = {
        id: newStepId(steps),
        order,
        title,
        body: options.stepBody?.trim() || undefined,
        status,
        owner: options.stepOwner?.trim() || undefined,
        evidence: options.stepEvidence?.trim() || undefined,
        blocked_reason: status === "blocked" ? options.stepBlockedReason?.trim() || "" : undefined,
        linked_items: linkedItems.length > 0 ? linkedItems : undefined,
        files: files.length > 0 ? files : undefined,
        tests: tests.length > 0 ? tests : undefined,
        docs: docs.length > 0 ? docs : undefined,
        created_at: now,
        updated_at: now,
        completed_at: status === "completed" ? now : undefined,
      };
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

function buildLinkInputs(options: PlanCommandOptions, fallbackKind: PlanStepLinkKind): PlanStepLink[] {
  const dependsOn = toArray(options.dependsOn).map((id) => ({ id, kind: fallbackKind } as PlanStepLink));
  const related = toArray(options.related).map((id) => ({ id, kind: "related" } as PlanStepLink));
  const blocks = toArray(options.blocks).map((id) => ({ id, kind: "blocks" } as PlanStepLink));
  const blockedBy = toArray(options.blockedBy).map((id) => ({ id, kind: "blocked_by" } as PlanStepLink));
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
  args: { stepRef: string; finalStatus?: PlanStepStatus; op: string; allowMultipleActive?: boolean },
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
      const desiredStatus = args.finalStatus ?? asStepStatus(options.stepStatus, step.status);
      if (desiredStatus === "in_progress" && step.status !== "in_progress" && !options.allowMultipleActive && !args.allowMultipleActive) {
        for (const other of steps) {
          if (other.id !== step.id && other.status === "in_progress") {
            throw new PmCliError(
              `Plan already has step ${other.id} in_progress. Pass --allow-multiple-active or update that step first.`,
              EXIT_CODE.CONFLICT,
            );
          }
        }
      }
      if (desiredStatus === "blocked" && !options.stepBlockedReason?.trim() && !step.blocked_reason) {
        throw new PmCliError(
          "Blocking a step requires --step-blocked-reason or an already-recorded blocked_reason.",
          EXIT_CODE.USAGE,
        );
      }
      if (options.stepTitle?.trim()) step.title = options.stepTitle.trim();
      if (options.stepBody !== undefined) step.body = options.stepBody.trim() || undefined;
      if (options.stepOwner !== undefined) step.owner = options.stepOwner.trim() || undefined;
      if (options.stepEvidence !== undefined) step.evidence = options.stepEvidence.trim() || undefined;
      if (options.stepBlockedReason !== undefined) step.blocked_reason = options.stepBlockedReason.trim() || undefined;
      if (options.stepReplacement !== undefined) step.superseded_by = options.stepReplacement.trim() || undefined;
      step.status = desiredStatus;
      step.updated_at = now;
      if (desiredStatus === "completed" && !step.completed_at) {
        step.completed_at = now;
      } else if (desiredStatus !== "completed") {
        step.completed_at = undefined;
      }
      doc.metadata.updated_at = now;
      return { changedSteps: [step.id], resultStep: step };
    },
  });
  const plan = projectPlan(document.metadata, "standard");
  return {
    action: args.op === "plan_complete_step" ? "complete-step" : args.op === "plan_block_step" ? "block-step" : "update-step",
    plan,
    step: resultStep,
    next_actions: nextActionsFor(itemId, plan),
    warnings: [],
    generated_at: nowIso(),
  };
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
  const newLinks = buildLinkInputs(options, asLinkKind(options.linkKind, "related"));
  if (newLinks.length === 0) {
    throw new PmCliError("pm plan link requires at least one --link/--related/--blocks/--blocked-by/--depends-on id", EXIT_CODE.USAGE);
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
        const depKey = (dep: { id: string; kind: string }) => `${dep.kind}:${dep.id}`;
        const seenDeps = new Set(deps.map(depKey));
        for (const link of newLinks) {
          const candidate = {
            id: link.id,
            kind: link.kind as DependencyKind,
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
    throw new PmCliError("pm plan unlink requires --link <id> to remove", EXIT_CODE.USAGE);
  }
  const { document, itemId, resultStep } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: "plan_unlink_step",
    message: options.message ?? `plan unlink ${stepRef}`,
    mutator(steps) {
      const step = resolveStepRef(steps, stepRef);
      const filtered = (step.linked_items ?? []).filter((link) => !removeIds.includes(link.id));
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
    throw new PmCliError(`pm plan ${kind} requires ${canonical}`, EXIT_CODE.USAGE, {
      code: "missing_required_option",
      examples: [
        `pm plan ${kind} <plan-id> ${canonical} "..."`,
        `pm plan ${kind} <plan-id> ${shorthand} "..."`,
      ],
      recovery: {
        suggested_retry: `pm plan ${kind} <plan-id> ${canonical} <value>`,
      },
    });
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
    throw new PmCliError("pm plan resume requires --resume-context <text>", EXIT_CODE.USAGE);
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

async function planMaterialize(
  id: string,
  options: PlanCommandOptions,
  ctx: PlanWriteContext,
): Promise<PlanCommandResult> {
  const stepRefs = toArray(options.steps);
  if (stepRefs.length === 0) {
    throw new PmCliError("pm plan materialize requires --steps <ids|orders|all>", EXIT_CODE.USAGE);
  }
  const targetType = options.materializeType?.trim() || "Task";
  const typeRegistry = resolveItemTypeRegistry(ctx.settings, getActiveExtensionRegistrations());
  const resolvedTypeName = resolveTypeName(targetType, typeRegistry);
  if (!resolvedTypeName) {
    throw new PmCliError(`Invalid --materialize-type "${targetType}"`, EXIT_CODE.USAGE);
  }
  const parent = options.materializeParent?.trim() || id;
  const tags = options.materializeTags;

  const planRead = await readPlanItem(ctx, id);
  const steps = (planRead.document.metadata.plan_steps ?? []).slice();
  const { targets, skipped: materializeSkipped } = resolveMaterializeTargets(steps, stepRefs);
  if (targets.length === 0) {
    if (materializeSkipped.length > 0) {
      // PR #78 / Gemini medium follow-up: when every selected step was
      // already materialized or completed, return a successful no-op
      // result (exit 0) instead of throwing NOT_FOUND. This makes
      // `pm plan materialize --steps all` truly idempotent for CI/agent
      // workflows; the skip reasons + warnings still surface what was
      // intentionally not redone.
      const plan = projectPlan(planRead.document.metadata, "standard");
      return {
        action: "materialize",
        plan,
        materialized: [],
        materialize_skipped: materializeSkipped,
        next_actions: nextActionsFor(planRead.itemId, plan),
        warnings: materializeSkipped.map(
          (entry) =>
            `plan_materialize_skipped:${entry.from_step}:${entry.reason}${entry.existing_id ? `:${entry.existing_id}` : ""}`,
        ),
        generated_at: nowIso(),
      };
    }
    throw new PmCliError("No matching plan steps found for --steps", EXIT_CODE.NOT_FOUND);
  }

  const materialized: { id: string; type: string; from_step: string }[] = [];
  for (const step of targets) {
    const deps = [
      `id=${parent},kind=parent`,
      `id=${planRead.itemId},kind=discovered_from`,
    ];
    for (const link of step.linked_items ?? []) {
      const realKind: DependencyKind =
        link.kind === "blocked_by" || link.kind === "blocks" || link.kind === "related" || link.kind === "discovered_from"
          ? link.kind
          : "related";
      deps.push(`id=${link.id},kind=${realKind}`);
    }
    const created = await runCreate(
      {
        title: step.title,
        description: step.body?.trim() || step.title,
        type: resolvedTypeName,
        parent,
        tags,
        author: options.author,
        message: options.message ?? `materialized from plan ${planRead.itemId} step ${step.id}`,
        dep: deps,
      },
      ctx.settings ? { ...({} as GlobalOptions), path: ctx.pmRoot } as GlobalOptions : ({} as GlobalOptions),
    );
    materialized.push({ id: created.item.id, type: resolvedTypeName, from_step: step.id });
  }

  const { document, itemId } = await mutatePlanSteps({
    id,
    options,
    ctx,
    op: "plan_materialize",
    message: options.message ?? `plan materialize ${stepRefs.join(",")}`,
    mutator(currentSteps, doc) {
      for (const target of targets) {
        const matched = materialized.find((entry) => entry.from_step === target.id);
        if (!matched) continue;
        const step = currentSteps.find((entry) => entry.id === target.id);
        if (!step) continue;
        const links = step.linked_items ?? [];
        links.push({ id: matched.id, kind: "implements", note: `materialized as ${matched.type}` });
        step.linked_items = links;
        step.updated_at = nowIso();
      }
      return { changedSteps: targets.map((entry) => entry.id) };
    },
  });
  const plan = projectPlan(document.metadata, "standard");
  return {
    action: "materialize",
    plan,
    materialized,
    ...(materializeSkipped.length > 0 ? { materialize_skipped: materializeSkipped } : {}),
    next_actions: nextActionsFor(itemId, plan),
    warnings: materializeSkipped.map(
      (entry) =>
        `plan_materialize_skipped:${entry.from_step}:${entry.reason}${entry.existing_id ? `:${entry.existing_id}` : ""}`,
    ),
    generated_at: nowIso(),
  };
}

export interface PlanDispatchInput {
  subcommand: PlanSubcommand;
  id?: string;
  stepRef?: string;
  reorderTo?: number;
  options: PlanCommandOptions;
  global: GlobalOptions;
}

export async function runPlan(input: PlanDispatchInput): Promise<PlanCommandResult> {
  const ctx = await loadContext(input.global);
  // pm-6mit: --step accumulates ordered step titles on create. For every other
  // subcommand a single --step value keeps its historical alias-of---step-title
  // behavior; multiple values would be ambiguous there (one step is targeted),
  // so they are rejected instead of silently dropping all but the last.
  if (input.subcommand !== "create") {
    const stepValues = toOrderedStepTitles(input.options.step);
    if (stepValues.length > 1) {
      throw new PmCliError(
        `pm plan ${input.subcommand} accepts a single --step/--step-title value (repeated --step seeds ordered steps only on pm plan create)`,
        EXIT_CODE.USAGE,
      );
    }
    if (stepValues.length === 1 && !input.options.stepTitle?.trim()) {
      input = { ...input, options: { ...input.options, stepTitle: stepValues[0] } };
    }
  }
  switch (input.subcommand) {
    case "create":
      return planCreate(input.options, input.global, ctx);
    case "show":
      if (!input.id) throw new PmCliError("pm plan show requires a plan id", EXIT_CODE.USAGE);
      return planShow(input.id, input.options, ctx);
    case "add-step":
      if (!input.id) throw new PmCliError("pm plan add-step requires a plan id", EXIT_CODE.USAGE);
      return planAddStep(input.id, input.options, ctx);
    case "update-step":
      if (!input.id || !input.stepRef) throw new PmCliError("pm plan update-step requires <plan-id> <step>", EXIT_CODE.USAGE);
      return planUpdateStep(input.id, input.options, ctx, { stepRef: input.stepRef, op: "plan_update_step" });
    case "complete-step":
      if (!input.id || !input.stepRef) throw new PmCliError("pm plan complete-step requires <plan-id> <step>", EXIT_CODE.USAGE);
      return planUpdateStep(input.id, input.options, ctx, { stepRef: input.stepRef, finalStatus: "completed", op: "plan_complete_step" });
    case "block-step":
      if (!input.id || !input.stepRef) throw new PmCliError("pm plan block-step requires <plan-id> <step>", EXIT_CODE.USAGE);
      return planUpdateStep(input.id, input.options, ctx, { stepRef: input.stepRef, finalStatus: "blocked", op: "plan_block_step" });
    case "reorder-step":
      if (!input.id || !input.stepRef || input.reorderTo === undefined)
        throw new PmCliError("pm plan reorder-step requires <plan-id> <step> <new-order>", EXIT_CODE.USAGE);
      return planReorderStep(input.id, input.options, ctx, input.stepRef, input.reorderTo);
    case "remove-step":
      if (!input.id || !input.stepRef) throw new PmCliError("pm plan remove-step requires <plan-id> <step>", EXIT_CODE.USAGE);
      return planRemoveStep(input.id, input.options, ctx, input.stepRef);
    case "link":
      if (!input.id || !input.stepRef) throw new PmCliError("pm plan link requires <plan-id> <step>", EXIT_CODE.USAGE);
      return planLink(input.id, input.options, ctx, input.stepRef);
    case "unlink":
      if (!input.id || !input.stepRef) throw new PmCliError("pm plan unlink requires <plan-id> <step>", EXIT_CODE.USAGE);
      return planUnlink(input.id, input.options, ctx, input.stepRef);
    case "decision":
      if (!input.id) throw new PmCliError("pm plan decision requires a plan id", EXIT_CODE.USAGE);
      return planAppendLog(input.id, input.options, ctx, "decision");
    case "discovery":
      if (!input.id) throw new PmCliError("pm plan discovery requires a plan id", EXIT_CODE.USAGE);
      return planAppendLog(input.id, input.options, ctx, "discovery");
    case "validation":
      if (!input.id) throw new PmCliError("pm plan validation requires a plan id", EXIT_CODE.USAGE);
      return planAppendLog(input.id, input.options, ctx, "validation");
    case "resume":
      if (!input.id) throw new PmCliError("pm plan resume requires a plan id", EXIT_CODE.USAGE);
      return planResume(input.id, input.options, ctx);
    case "approve":
      if (!input.id) throw new PmCliError("pm plan approve requires a plan id", EXIT_CODE.USAGE);
      return planApprove(input.id, input.options, ctx);
    case "materialize":
      if (!input.id) throw new PmCliError("pm plan materialize requires a plan id", EXIT_CODE.USAGE);
      return planMaterialize(input.id, input.options, ctx);
    default:
      throw new PmCliError(`Unknown pm plan subcommand "${input.subcommand}"`, EXIT_CODE.USAGE);
  }
}
