/**
 * @module sdk/context-intent-contracts
 *
 * Declares composable, intent-scoped read projections for core commands,
 * workspace configuration, and packages.
 */
import { attachOutputOmissionReceipt } from "./output-projection.js";
import { encodeQueryCursor } from "./pagination.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";

/** Read commands that ship built-in intent projections. */
export type PmContextIntentCommand =
  | "context"
  | "get"
  | "list"
  | "next"
  | "search"
  | (string & {});

/** Origin of a resolved intent projection. */
export type PmContextIntentSource = "core" | "package" | "workspace";

/** One named, bounded projection of a command's context. */
export interface PmContextIntentContract {
  /** Command that accepts the intent. */
  command: PmContextIntentCommand;
  /** Stable intent identifier used by CLI, SDK, and MCP callers. */
  intent: string;
  /** Agent-facing explanation of the projection's purpose. */
  description: string;
  /** Declared output field groups retained by the projection. */
  included_field_groups: string[];
  /** Default maximum estimated tokens before normal degradation applies. */
  token_budget: number;
  /** Layer that supplied the resolved declaration. */
  source?: PmContextIntentSource;
}

/** Machine-readable proof of the intent projection resolved for one read result. */
export interface PmContextIntentReceipt {
  /** Canonical read command that resolved the intent. */
  command: string;
  /** Stable selected intent name. */
  intent: string;
  /** Layer that supplied the resolved declaration. */
  source: PmContextIntentSource;
  /** Field groups the selected intent promises to retain. */
  included_field_groups: string[];
  /** Effective token ceiling after an explicit caller override is applied. */
  token_budget: number;
  /** Deterministic JSON-size estimate for the result including this receipt. */
  estimated_tokens: number;
  /** Whether the measured result fits the declared ceiling. */
  within_budget: boolean;
  /** Projection strategy applied before the result was measured. */
  degradation:
    | "bounded_fields_and_rows"
    | "bounded_ranked_rows"
    | "bounded_sections"
    | "budget_row_compaction"
    | "recursive_budget_compaction"
    | "budget_receipt_only"
    | "standard_item"
    | "none";
  /** Whether the declared ceiling can carry at least one useful result row. */
  declaration_feasible: boolean;
  /** True only when no useful result survived the declared ceiling. */
  result_omitted: boolean;
  /** Row ceiling calculated from the selected intent's effective token budget. */
  budget_derived_limit?: number;
  /** Constraint that selected the effective page size for row-oriented reads. */
  binding_constraint?: "explicit_limit" | "token_budget";
  /** Machine-readable explanation for the selected row ceiling. */
  limit_reason?: string;
}

/** Built-in intent projections shared by CLI, SDK, MCP, and package authors. */
export const PM_CONTEXT_INTENT_CONTRACTS: readonly PmContextIntentContract[] =
  Object.freeze([
    {
      command: "context",
      intent: "orient",
      description:
        "Bounded active hierarchy, ownership, blockers, and recent progress.",
      included_field_groups: [
        "summary",
        "focus",
        "hierarchy",
        "blockers",
        "activity",
      ],
      token_budget: 2400,
      source: "core",
    },
    {
      command: "context",
      intent: "handoff",
      description:
        "Active ownership, evidence, decisions, and immediate continuation context.",
      included_field_groups: [
        "summary",
        "focus",
        "in_progress",
        "decisions",
        "activity",
      ],
      token_budget: 2200,
      source: "core",
    },
    {
      command: "get",
      intent: "inspect",
      description:
        "Standard-depth item metadata, relationships, evidence, and lifecycle state.",
      included_field_groups: ["item", "children", "claim_state", "linked"],
      token_budget: 3200,
      source: "core",
    },
    {
      command: "list",
      intent: "triage",
      description:
        "A budget-derived page of compact governance, ownership, priority, and blocker rows for triage.",
      included_field_groups: [
        "identity",
        "governance",
        "ownership",
        "dependencies",
      ],
      token_budget: 3200,
      source: "core",
    },
    {
      command: "next",
      intent: "execute",
      description:
        "The highest-ranked actionable work with concise ranking evidence.",
      included_field_groups: ["recommended"],
      token_budget: 1200,
      source: "core",
    },
    {
      command: "search",
      intent: "discover",
      description:
        "A budget-derived page of ranked canonical lineage candidates with compact match evidence.",
      included_field_groups: ["identity", "status", "lineage", "match"],
      token_budget: 1800,
      source: "core",
    },
  ]);

function normalizeContextIntentDeclaration(
  declaration: PmContextIntentContract,
  source: PmContextIntentSource,
): PmContextIntentContract {
  const command = declaration.command.trim().toLowerCase();
  const intent = declaration.intent.trim().toLowerCase();
  const key = `${command}:${intent}`;
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(command) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(intent)
  ) {
    throw new TypeError(`Invalid context intent command or name: ${key}`);
  }
  if (declaration.description.trim().length === 0) {
    throw new TypeError(
      `Context intent ${key} requires a non-empty description`,
    );
  }
  if (
    !Number.isSafeInteger(declaration.token_budget) ||
    declaration.token_budget <= 0
  ) {
    throw new TypeError(
      `Context intent ${key} requires a positive integer token_budget`,
    );
  }
  const includedFieldGroups = [
    ...new Set(
      declaration.included_field_groups
        .map((field) => field.trim())
        .filter(Boolean),
    ),
  ];
  if (includedFieldGroups.length === 0) {
    throw new TypeError(`Context intent ${key} requires included_field_groups`);
  }
  return {
    command,
    intent,
    description: declaration.description.trim(),
    included_field_groups: includedFieldGroups,
    token_budget: declaration.token_budget,
    source,
  };
}

/** Validate and compose core, package, and workspace intent declarations. Later layers override earlier layers by command and intent. */
export function composeContextIntentContracts(
  workspaceContracts: readonly PmContextIntentContract[] = [],
  packageContracts: readonly PmContextIntentContract[] = [],
): PmContextIntentContract[] {
  const layers: Array<{
    source: PmContextIntentSource;
    contracts: readonly PmContextIntentContract[];
    allowOverride: boolean;
  }> = [
    {
      source: "core",
      contracts: PM_CONTEXT_INTENT_CONTRACTS,
      allowOverride: false,
    },
    { source: "package", contracts: packageContracts, allowOverride: false },
    { source: "workspace", contracts: workspaceContracts, allowOverride: true },
  ];
  const composed = new Map<string, PmContextIntentContract>();
  const keysSeenWithinLayer = new Set<string>();
  for (const layer of layers) {
    keysSeenWithinLayer.clear();
    for (const declaration of layer.contracts) {
      const normalized = normalizeContextIntentDeclaration(
        declaration,
        layer.source,
      );
      const key = `${normalized.command}:${normalized.intent}`;
      if (keysSeenWithinLayer.has(key)) {
        throw new TypeError(`Duplicate context intent declaration: ${key}`);
      }
      keysSeenWithinLayer.add(key);
      if (!layer.allowOverride && composed.has(key)) {
        throw new TypeError(`Duplicate context intent declaration: ${key}`);
      }
      composed.set(key, normalized);
    }
  }
  return [...composed.values()].sort(
    (left, right) =>
      left.command.localeCompare(right.command) ||
      left.intent.localeCompare(right.intent),
  );
}

/** Resolve one intent declaration or fail with the nearest command-local intent. */
export function resolveContextIntentContract(
  command: string,
  intent: string,
  contracts: readonly PmContextIntentContract[] = PM_CONTEXT_INTENT_CONTRACTS,
): PmContextIntentContract | undefined {
  const normalizedCommand = command.trim().toLowerCase();
  const normalizedIntent = intent.trim().toLowerCase();
  const exact = contracts.find(
    (entry) =>
      entry.command === normalizedCommand && entry.intent === normalizedIntent,
  );
  if (exact) return { ...exact, source: exact.source ?? "core" };
  const candidates = contracts
    .filter((entry) => entry.command === normalizedCommand)
    .map((entry) => entry.intent);
  if (candidates.length === 0) return undefined;
  const suggestion = candidates
    .map((candidate) => {
      const rows = Array.from(
        { length: normalizedIntent.length + 1 },
        (_, index) => index,
      );
      for (
        let candidateIndex = 1;
        candidateIndex <= candidate.length;
        candidateIndex += 1
      ) {
        let previous = rows[0]!;
        rows[0] = candidateIndex;
        for (
          let intentIndex = 1;
          intentIndex <= normalizedIntent.length;
          intentIndex += 1
        ) {
          const prior = rows[intentIndex]!;
          rows[intentIndex] = Math.min(
            rows[intentIndex]! + 1,
            rows[intentIndex - 1]! + 1,
            previous +
              (candidate[candidateIndex - 1] ===
              normalizedIntent[intentIndex - 1]
                ? 0
                : 1),
          );
          previous = prior;
        }
      }
      return { candidate, distance: rows[normalizedIntent.length]! };
    })
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.candidate.localeCompare(right.candidate),
    )[0]!.candidate;
  const suggestedCommand = `pm ${normalizedCommand} --for ${suggestion}`;
  throw new PmCliError(
    `Unknown context intent "${normalizedIntent}" for ${normalizedCommand}. Did you mean "${suggestion}"?`,
    EXIT_CODE.USAGE,
    {
      code: "unknown_context_intent",
      reason: "unknown_intent",
      field: "for",
      required: `Use a declared ${normalizedCommand} intent.`,
      why: "Intent names are command-local contracts and cannot be inferred from output section names.",
      nextSteps: [suggestedCommand],
      recovery: {
        recovery_mode: "compact",
        attempted_command: `pm ${normalizedCommand} --for ${normalizedIntent}`,
        suggested_retry: suggestedCommand,
      },
    },
  );
}

type BuiltInContextIntentCommand =
  | "context"
  | "get"
  | "list"
  | "next"
  | "search";

const CONTEXT_INTENT_DEFAULT_APPLIERS: Readonly<
  Record<
    BuiltInContextIntentCommand,
    (
      projected: Record<string, unknown>,
      contract: PmContextIntentContract,
      explicitTokenBudget: boolean,
    ) => void
  >
> = {
  context: (projected, contract, explicitTokenBudget) => {
    if (projected.depth === undefined) {
      projected.depth = contract.intent === "handoff" ? "deep" : "standard";
    }
    if (projected.section === undefined) {
      projected.section =
        contract.intent === "handoff"
          ? ["activity", "progress", "blockers"]
          : ["hierarchy", "blockers", "activity"];
    }
    const tokenBudget = resolveIntentTokenBudget(
      projected.tokenBudget,
      contract.token_budget,
    );
    const calculatedLimit = Math.max(1, Math.floor((tokenBudget - 800) / 500));
    const derivedLimit = String(
      explicitTokenBudget ? calculatedLimit : Math.min(20, calculatedLimit),
    );
    if (projected.limit === undefined) projected.limit = derivedLimit;
    if (projected.activityLimit === undefined) {
      projected.activityLimit = derivedLimit;
    }
  },
  get: (projected) => {
    if (projected.depth === undefined && projected.fields === undefined) {
      projected.depth = "standard";
    }
  },
  list: (projected, contract, explicitTokenBudget) => {
    if (
      projected.brief === undefined &&
      projected.compact === undefined &&
      projected.full === undefined &&
      projected.fields === undefined
    ) {
      projected.fields =
        "id,title,status,type,priority,parent,assignee,risk,blocked_by";
    }
    if (projected.limit === undefined) {
      const tokenBudget = resolveIntentTokenBudget(
        projected.tokenBudget,
        contract.token_budget,
      );
      const calculatedLimit = Math.max(2, Math.floor((tokenBudget - 520) / 16));
      projected.limit = String(
        explicitTokenBudget ? calculatedLimit : Math.min(100, calculatedLimit),
      );
    }
  },
  next: (projected) => {
    if (projected.readyOnly === undefined) projected.readyOnly = true;
  },
  search: (projected, contract, explicitTokenBudget) => {
    if (
      projected.compact === undefined &&
      projected.full === undefined &&
      projected.fields === undefined
    ) {
      projected.compact = true;
    }
    if (projected.limit === undefined) {
      const tokenBudget = resolveIntentTokenBudget(
        projected.tokenBudget,
        contract.token_budget,
      );
      const calculatedLimit = Math.max(2, Math.floor((tokenBudget - 480) / 16));
      projected.limit = String(
        explicitTokenBudget ? calculatedLimit : Math.min(100, calculatedLimit),
      );
    }
  },
};

/** Apply one declared read intent's defaults while preserving explicit caller options. */
export function applyContextIntentProjection(
  command: "context" | "get" | "list" | "next" | "search",
  options: Record<string, unknown>,
): Record<string, unknown> {
  const tokenBudget = options.tokenBudget ?? options.token_budget;
  const explicitTokenBudget = tokenBudget !== undefined;
  if (typeof options.for !== "string") {
    if (
      tokenBudget !== undefined &&
      (command === "get" || command === "list" || command === "search")
    ) {
      throw new PmCliError(
        "--token-budget requires a declared context intent selected with --for",
        EXIT_CODE.USAGE,
        {
          code: "missing_required_option",
          field: "for",
          required:
            "Select a context intent with --for when setting --token-budget.",
          why: "A token-budget override has no projection contract to constrain without a selected intent.",
          nextSteps: [
            "Retry with --for <intent> --token-budget <n>, or omit --token-budget.",
          ],
        },
      );
    }
    if (
      options.tokenBudget !== undefined ||
      options.token_budget === undefined
    ) {
      return options;
    }
    const projected: Record<string, unknown> = { ...options, tokenBudget };
    delete projected.token_budget;
    return projected;
  }
  const contract = resolveContextIntentContract(command, options.for)!;
  const projected = { ...options };
  if (projected.tokenBudget === undefined && tokenBudget !== undefined) {
    projected.tokenBudget = tokenBudget;
  }
  delete projected.token_budget;
  if (projected.tokenBudget === undefined) {
    projected.tokenBudget = String(contract.token_budget);
  }
  CONTEXT_INTENT_DEFAULT_APPLIERS[command](
    projected,
    contract,
    explicitTokenBudget,
  );
  return projected;
}

const CONTEXT_INTENT_DEGRADATIONS: Readonly<
  Record<BuiltInContextIntentCommand, PmContextIntentReceipt["degradation"]>
> = {
  context: "bounded_sections",
  get: "standard_item",
  list: "bounded_fields_and_rows",
  next: "bounded_ranked_rows",
  search: "bounded_ranked_rows",
};

const MINIMUM_CONTEXT_INTENT_TOKEN_BUDGET = 256;

/** Bound explanatory strings without dropping rows or invalidating pagination metadata. */
function compactContextIntentValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactContextIntentValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        compactContextIntentValue(entry),
      ]),
    );
  }
  return typeof value === "string" && value.length > 240
    ? `${value.slice(0, 240)}…`
    : value;
}

function resolveIntentTokenBudget(
  value: unknown,
  declaredBudget: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return declaredBudget;
  if (parsed < MINIMUM_CONTEXT_INTENT_TOKEN_BUDGET) {
    throw new PmCliError(
      `Context intent token budget must be at least ${MINIMUM_CONTEXT_INTENT_TOKEN_BUDGET}`,
      EXIT_CODE.USAGE,
      {
        code: "invalid_argument_value",
        reason: "below_minimum",
        field: "tokenBudget",
        required: `Use an integer token budget of at least ${MINIMUM_CONTEXT_INTENT_TOKEN_BUDGET}.`,
        why: "Smaller ceilings cannot contain the minimum machine-readable intent receipt.",
        nextSteps: [
          `Retry with --token-budget ${MINIMUM_CONTEXT_INTENT_TOKEN_BUDGET} or omit the override.`,
        ],
      },
    );
  }
  return parsed;
}

/** Update a receipt until its estimate matches the serialized projection that contains it. */
function updateContextIntentEstimate(
  projected: Record<string, unknown>,
  receipt: PmContextIntentReceipt,
): void {
  let measuredTokens = receipt.estimated_tokens;
  for (;;) {
    receipt.estimated_tokens = measuredTokens;
    const nextMeasurement = Math.ceil(
      Buffer.byteLength(JSON.stringify(projected), "utf8") / 4,
    );
    if (nextMeasurement === measuredTokens) return;
    measuredTokens = nextMeasurement;
  }
}

const CONTEXT_INTENT_ROW_KEYS: Readonly<
  Record<BuiltInContextIntentCommand, readonly string[]>
> = {
  context: [
    "high_level",
    "low_level",
    "blocked_fallback",
    "recently_created",
    "unparented",
    "hierarchy",
    "activity",
    "blockers",
  ],
  get: ["children"],
  list: ["items"],
  next: ["ready", "decision_needed", "blocked", "held_by_others"],
  search: ["items"],
};

interface ContextIntentCursorEnvelope {
  fingerprint: string;
  after_index: number;
  snapshot?: string;
}

/** Decode the cursor fields required to preserve a row-compacted continuation. */
export function decodeContextIntentCursor(
  cursor: string,
): ContextIntentCursorEnvelope | undefined {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed.fingerprint !== "string" ||
      !Number.isSafeInteger(parsed.after_index)
    ) {
      return undefined;
    }
    return {
      fingerprint: parsed.fingerprint,
      after_index: parsed.after_index as number,
      ...(typeof parsed.snapshot === "string"
        ? { snapshot: parsed.snapshot }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** Resolve the stable item id carried by list rows and nested search hits. */
export function contextIntentRowId(row: unknown): string | undefined {
  if (row === null || typeof row !== "object") return undefined;
  if (typeof (row as Record<string, unknown>).id === "string") {
    return (row as Record<string, unknown>).id as string;
  }
  const nestedId = (row as { item?: { id?: unknown } }).item?.id;
  return typeof nestedId === "string" ? nestedId : undefined;
}

function shrinkContextIntentRowsToBudget(
  projected: Record<string, unknown>,
  receipt: PmContextIntentReceipt,
  rows: unknown[],
): boolean {
  let compacted = false;
  for (;;) {
    updateContextIntentEstimate(projected, receipt);
    if (receipt.estimated_tokens <= receipt.token_budget || rows.length <= 1) {
      return compacted;
    }
    const rowBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
    const excessBytes = (receipt.estimated_tokens - receipt.token_budget) * 4;
    rows.splice(
      -Math.min(
        rows.length - 1,
        Math.max(
          1,
          Math.ceil(
            excessBytes / Math.max(1, Math.ceil(rowBytes / rows.length)),
          ),
        ),
      ),
    );
    compacted = true;
  }
}

function compactPaginatedContextIntentRows(
  projected: Record<string, unknown>,
  receipt: PmContextIntentReceipt,
  options: Record<string, unknown>,
): boolean {
  const rows = projected.items;
  const cursorContinuesExistingPage = typeof projected.next_cursor === "string";
  const cursorSource = cursorContinuesExistingPage
    ? projected.next_cursor
    : options.after;
  if (!Array.isArray(rows) || typeof cursorSource !== "string") return false;
  const cursorEnvelope = decodeContextIntentCursor(cursorSource);
  if (cursorEnvelope === undefined) return false;
  const originalRowCount = rows.length;
  const originalRows = [...rows];
  let compacted = false;
  for (;;) {
    compacted =
      shrinkContextIntentRowsToBudget(projected, receipt, rows) || compacted;
    if (!compacted) return false;
    const lastId = contextIntentRowId(rows.at(-1));
    if (lastId === undefined) {
      rows.splice(0, rows.length, ...originalRows);
      updateContextIntentEstimate(projected, receipt);
      return false;
    }
    projected.next_cursor = encodeQueryCursor(
      cursorEnvelope.fingerprint,
      lastId,
      cursorContinuesExistingPage
        ? cursorEnvelope.after_index - (originalRowCount - rows.length)
        : cursorEnvelope.after_index + rows.length,
      cursorEnvelope.snapshot,
    );
    updateContextIntentEstimate(projected, receipt);
    if (receipt.estimated_tokens <= receipt.token_budget || rows.length <= 1) {
      break;
    }
  }
  if (typeof projected.count === "number") projected.count = rows.length;
  if (typeof projected.applied_limit === "number") {
    projected.applied_limit = rows.length;
  }
  return true;
}

/** Reduce root row collections deterministically while retaining at least one useful row. */
function compactContextIntentRows(
  command: BuiltInContextIntentCommand,
  projected: Record<string, unknown>,
  receipt: PmContextIntentReceipt,
  options: Record<string, unknown>,
): boolean {
  if (command === "list" || command === "search") {
    return compactPaginatedContextIntentRows(projected, receipt, options);
  }
  if (command !== "next" || typeof projected.next_cursor === "string") {
    return false;
  }
  let compacted = false;
  for (;;) {
    updateContextIntentEstimate(projected, receipt);
    if (receipt.estimated_tokens <= receipt.token_budget) return compacted;
    const candidate = CONTEXT_INTENT_ROW_KEYS[command]
      .map((key) => ({
        key,
        rows: Array.isArray(projected[key]) ? projected[key] : [],
      }))
      .filter(({ rows }) => rows.length > 0)
      .sort(
        (left, right) =>
          right.rows.length - left.rows.length ||
          left.key.localeCompare(right.key),
      )[0];
    if (candidate === undefined) return compacted;
    const retainedTotal = CONTEXT_INTENT_ROW_KEYS[command].reduce(
      (total, key) =>
        total + (Array.isArray(projected[key]) ? projected[key].length : 0),
      0,
    );
    if (retainedTotal <= 1) return compacted;
    const removableRows = Math.min(candidate.rows.length, retainedTotal - 1);
    const candidateBytes = Buffer.byteLength(
      JSON.stringify(candidate.rows),
      "utf8",
    );
    const estimatedBytesPerRow = Math.max(
      1,
      Math.ceil(candidateBytes / candidate.rows.length),
    );
    const excessBytes = (receipt.estimated_tokens - receipt.token_budget) * 4;
    const removalCount = Math.min(
      removableRows,
      Math.max(1, Math.ceil(excessBytes / estimatedBytesPerRow)),
    );
    candidate.rows.splice(-removalCount, removalCount);
    compacted = true;
  }
}

/** Attach budget and degradation evidence for a selected built-in read intent. */
export function attachContextIntentReceipt<
  Result extends Record<string, unknown>,
>(
  command: string,
  options: Record<string, unknown>,
  result: Result,
): Result & { context_intent?: PmContextIntentReceipt } {
  if (typeof options.for !== "string") return result;
  const normalizedCommand = command.startsWith("list-") ? "list" : command;
  if (!(normalizedCommand in CONTEXT_INTENT_DEFAULT_APPLIERS)) return result;
  const builtInCommand = normalizedCommand as BuiltInContextIntentCommand;
  const contract = resolveContextIntentContract(builtInCommand, options.for)!;
  const receipt: PmContextIntentReceipt = {
    command: builtInCommand,
    intent: contract.intent,
    source: contract.source!,
    included_field_groups: [...contract.included_field_groups],
    token_budget: resolveIntentTokenBudget(
      options.tokenBudget ?? options.token_budget,
      contract.token_budget,
    ),
    estimated_tokens: 0,
    within_budget: true,
    degradation: CONTEXT_INTENT_DEGRADATIONS[builtInCommand],
    declaration_feasible: true,
    result_omitted: false,
  };
  const resultWithDiagnostics: Record<string, unknown> = { ...result };
  if (builtInCommand === "list" || builtInCommand === "search") {
    const overhead = builtInCommand === "list" ? 520 : 480;
    const calculatedLimit = Math.max(
      2,
      Math.floor((receipt.token_budget - overhead) / 16),
    );
    const explicitTokenBudget =
      options.tokenBudget !== undefined || options.token_budget !== undefined;
    const budgetDerivedLimit = explicitTokenBudget
      ? calculatedLimit
      : Math.min(100, calculatedLimit);
    const hasExplicitLimit = options.limit !== undefined;
    receipt.budget_derived_limit = budgetDerivedLimit;
    receipt.binding_constraint = hasExplicitLimit
      ? "explicit_limit"
      : "token_budget";
    receipt.limit_reason = hasExplicitLimit
      ? "The caller supplied an explicit row limit; the budget-derived limit remains diagnostic."
      : "The selected intent token budget determines the row ceiling.";
    resultWithDiagnostics.budget_derived_limit = budgetDerivedLimit;
  }
  let projected: Record<string, unknown> = {
    ...resultWithDiagnostics,
    context_intent: receipt,
  };
  updateContextIntentEstimate(projected, receipt);
  if (receipt.estimated_tokens > receipt.token_budget) {
    receipt.degradation = "recursive_budget_compaction";
    projected = {
      ...(compactContextIntentValue(resultWithDiagnostics) as Record<
        string,
        unknown
      >),
      context_intent: receipt,
    };
    updateContextIntentEstimate(projected, receipt);
  }
  if (
    receipt.estimated_tokens > receipt.token_budget &&
    compactContextIntentRows(builtInCommand, projected, receipt, options)
  ) {
    receipt.degradation = "budget_row_compaction";
    updateContextIntentEstimate(projected, receipt);
  }
  if (receipt.estimated_tokens > receipt.token_budget) {
    receipt.degradation = "budget_receipt_only";
    receipt.declaration_feasible = false;
    receipt.result_omitted = true;
    receipt.within_budget = false;
    projected = {
      budget_exceeded: {
        omitted_result: true,
        reason: "declared_budget_infeasible",
        restore_with:
          "Increase --token-budget or narrow the request; the unprojected command may be larger.",
      },
      context_intent: receipt,
    };
    updateContextIntentEstimate(projected, receipt);
  }
  return projected as Result & { context_intent: PmContextIntentReceipt };
}

function collapseContinuationMetadata(
  options: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof options.after !== "string" || options.after.length === 0) {
    return result;
  }
  const fingerprint =
    decodeContextIntentCursor(options.after)?.fingerprint ?? "opaque_cursor";
  const projected = { ...result };
  for (const key of [
    "applied_limit",
    "completeness",
    "context_intent",
    "count",
    "filters",
    "has_more",
    "now",
    "omission_receipt",
    "projection",
    "row_contract",
    "sorting",
    "total",
    "truncated",
  ]) {
    delete projected[key];
  }
  projected.continuation_contract = {
    fingerprint,
    metadata: "reference",
    restore_with: "omit --after",
  };
  return projected;
}

/** Attach universal row, omission, and optional intent-budget contracts in rendering order. */
export function attachReadOutputContracts(
  command: string | undefined,
  options: Record<string, unknown>,
  result: unknown,
): unknown {
  const disclosedResult = attachOutputOmissionReceipt(command, result);
  return typeof disclosedResult === "object" &&
    disclosedResult !== null &&
    !Array.isArray(disclosedResult)
    ? collapseContinuationMetadata(
        options,
        attachContextIntentReceipt(
          command ?? "",
          options,
          disclosedResult as Record<string, unknown>,
        ),
      )
    : disclosedResult;
}
