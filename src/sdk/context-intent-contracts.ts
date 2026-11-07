/**
 * @module sdk/context-intent-contracts
 *
 * Declares composable, intent-scoped read projections for core commands,
 * workspace configuration, and packages.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { attachExtensionReadOutputRows } from "./read-output/extension.js";
import { renderPmCommand } from "./command-line.js";
import { attachOutputOmissionReceipt } from "./output-projection.js";
import { encodeQueryCursor } from "./pagination.js";
import {
  applyReadOutputDimensions,
  isReadResultOmittedForBudget,
  stabilizeReadOutputReceiptEstimates,
} from "./read-output-contracts.js";
import {
  estimateReadOutputTokens,
  MAX_ESTIMATE_ITERATIONS,
  readOutputMeasurementFormat,
  resolveReadOutputRecoveryBudget,
} from "./read-output-budget.js";
import { propagateContextUsageServingReceipt } from "./context-usage.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { unicodeSafePrefix } from "../core/shared/text-normalization.js";

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
  /** Ceiling declared by the selected intent before caller overrides. */
  declared_token_budget: number;
  /** Signed difference between the effective and declared ceilings. */
  token_budget_override: number;
  /** Deterministic JSON-size estimate for the useful result before any receipt-only omission. */
  estimated_tokens: number;
  /** Whether the measured result fits the effective ceiling after caller overrides. */
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
  /** Whether the declared ceiling can carry the measured useful projection, independent of an override. */
  declaration_feasible: boolean;
  /** True only when no useful result survived the effective ceiling. */
  result_omitted: boolean;
  /** Row ceiling calculated from the selected intent's effective token budget. */
  budget_derived_limit?: number;
  /** Constraint that selected the effective page size for row-oriented reads. */
  binding_constraint?: "explicit_limit" | "token_budget";
  /** Machine-readable explanation for the selected row ceiling. */
  limit_reason?: string;
  /** Present only when the intent's budget reduced a larger caller-supplied row limit. */
  limit_override?: PmContextIntentLimitOverride;
}

/** Evidence that a declared intent budget reduced an explicit row limit, with the retry that keeps it. */
export interface PmContextIntentLimitOverride {
  /** Flag whose explicit value the intent budget reduced. */
  flag: "--limit";
  /** Row limit the caller supplied. */
  requested: number;
  /** Row limit the intent budget applied. */
  effective: number;
  /** Smallest token budget, never below the current one, whose derived ceiling carries the requested rows; absent when no safe integer budget can. */
  token_budget_for_requested?: number;
  /** Flag to add to (or replace in) the original command so it keeps the requested limit, like an omission receipt's `restore_with`. */
  restore_with?: string;
}

/** Stable warning code emitted when an intent budget reduces an explicit row limit. */
export const CONTEXT_INTENT_LIMIT_OVERRIDE_WARNING = "limit_overridden_by_intent";

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
      token_budget: 3000,
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

const activeContextIntentContracts = new AsyncLocalStorage<
  readonly PmContextIntentContract[]
>();

/** Runtime declaration layers applied to one asynchronous SDK or CLI execution. */
export interface PmContextIntentRuntimeLayers {
  /** Workspace declarations, which may override a core or package declaration. */
  workspaceContracts?: readonly PmContextIntentContract[];
  /** Package declarations, which may add but not replace earlier declarations. */
  packageContracts?: readonly PmContextIntentContract[];
}

/** Return the request-scoped intent registry, or the immutable built-in registry outside a configured scope. */
export function getActiveContextIntentContracts(): readonly PmContextIntentContract[] {
  return activeContextIntentContracts.getStore() ?? PM_CONTEXT_INTENT_CONTRACTS;
}

/** Execute asynchronous work with isolated workspace and package intent declarations. */
export function runWithContextIntentContracts<T>(
  layers: PmContextIntentRuntimeLayers,
  run: () => T,
): T {
  return activeContextIntentContracts.run(
    composeContextIntentContracts(
      layers.workspaceContracts,
      layers.packageContracts,
    ),
    run,
  );
}

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
  contracts: readonly PmContextIntentContract[] = getActiveContextIntentContracts(),
  positionalArguments: readonly string[] = [],
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
  const attemptedArguments = [
    normalizedCommand,
    ...positionalArguments,
    "--for",
    normalizedIntent,
  ];
  const suggestedRetryArguments = [
    normalizedCommand,
    ...positionalArguments,
    "--for",
    suggestion,
  ];
  const suggestedCommand = renderPmCommand(suggestedRetryArguments);
  throw new PmCliError(
    `Unknown context intent "${normalizedIntent}" for ${normalizedCommand}. Did you mean "${suggestion}"?`,
    EXIT_CODE.USAGE,
    {
      code: "unknown_context_intent",
      reason: "unknown_intent",
      field: "for",
      flag: "--for",
      value: normalizedIntent,
      required: `Use a declared ${normalizedCommand} intent.`,
      why: "Intent names are command-local contracts and cannot be inferred from output section names.",
      nextSteps: [suggestedCommand],
      recovery: {
        recovery_mode: "compact",
        attempted_command: renderPmCommand(attemptedArguments),
        allowed_values: [...candidates].sort(),
        suggested_retry: suggestedCommand,
        suggested_retry_args: suggestedRetryArguments,
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

/** Bound an explicit or absent row limit by the intent's budget-derived ceiling. */
function applyIntentRowLimit(
  projected: Record<string, unknown>,
  budgetDerivedLimit: number,
): string {
  const requestedLimit = parsePositiveIntentTokenBudget(projected.limit);
  const effectiveLimit = String(
    requestedLimit === undefined
      ? budgetDerivedLimit
      : Math.min(requestedLimit, budgetDerivedLimit),
  );
  if (projected.limit === undefined || requestedLimit !== undefined) {
    projected.limit = effectiveLimit;
  }
  return effectiveLimit;
}

const CONTEXT_INTENT_DEFAULT_APPLIERS: Readonly<
  Record<
    BuiltInContextIntentCommand,
    (
      projected: Record<string, unknown>,
      contract: PmContextIntentContract,
      explicitTokenBudget: boolean,
      canonical: number | "unbounded" | undefined,
    ) => void
  >
> = {
  /** Apply intent defaults only to unspecified context sections/depth and bound row limits by the declared budget. */
  context: (projected, contract, explicitTokenBudget, canonical) => {
    if (projected.section === undefined && projected.depth === undefined) {
      projected.section =
        contract.intent === "handoff"
          ? ["activity", "progress", "blockers"]
          : ["hierarchy", "blockers", "activity"];
    }
    if (projected.depth === undefined) {
      projected.depth = contract.intent === "handoff" ? "deep" : "standard";
    }
    const tokenBudget = resolveEffectiveIntentTokenBudget(
      canonical,
      projected.tokenBudget,
      contract.token_budget,
    );
    const budgetDerivedLimit = resolveIntentRowBudget(
      "context",
      contract.intent,
      tokenBudget,
      explicitTokenBudget,
    )!;
    const derivedLimit = applyIntentRowLimit(projected, budgetDerivedLimit);
    if (projected.activityLimit === undefined) {
      projected.activityLimit = derivedLimit;
    }
  },
  get: (projected) => {
    if (projected.depth === undefined && projected.fields === undefined) {
      projected.depth = "standard";
    }
  },
  list: (projected, contract, explicitTokenBudget, canonical) => {
    if (
      projected.brief === undefined &&
      projected.compact === undefined &&
      projected.full === undefined &&
      projected.fields === undefined
    ) {
      projected.fields =
        "id,title,status,type,priority,parent,assignee,risk,blocked_by";
    }
    const tokenBudget = resolveEffectiveIntentTokenBudget(
      canonical,
      projected.tokenBudget,
      contract.token_budget,
    );
    const budgetDerivedLimit = resolveIntentRowBudget(
      "list",
      contract.intent,
      tokenBudget,
      explicitTokenBudget,
    )!;
    applyIntentRowLimit(projected, budgetDerivedLimit);
  },
  next: (projected) => {
    if (projected.readyOnly === undefined) projected.readyOnly = true;
  },
  search: (projected, contract, explicitTokenBudget, canonical) => {
    if (
      projected.compact === undefined &&
      projected.full === undefined &&
      projected.fields === undefined
    ) {
      projected.compact = true;
    }
    const tokenBudget = resolveEffectiveIntentTokenBudget(
      canonical,
      projected.tokenBudget,
      contract.token_budget,
    );
    const budgetDerivedLimit = resolveIntentRowBudget(
      "search",
      contract.intent,
      tokenBudget,
      explicitTokenBudget,
    )!;
    applyIntentRowLimit(projected, budgetDerivedLimit);
  },
};

/** Apply one declared read intent's defaults while preserving explicit caller options. */
export function applyContextIntentProjection(
  command: "context" | "get" | "list" | "next" | "search",
  options: Record<string, unknown>,
  positionalArguments: readonly string[] = [],
): Record<string, unknown> {
  const tokenBudget = options.tokenBudget ?? options.token_budget;
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
  const contract = resolveContextIntentContract(
    command,
    options.for,
    undefined,
    positionalArguments,
  )!;
  const canonical = canonicalIntentOutputBudget(options);
  const explicitTokenBudget =
    parsePositiveIntentTokenBudget(tokenBudget) !== undefined ||
    typeof canonical === "number";
  const projected = { ...options };
  if (projected.tokenBudget === undefined && tokenBudget !== undefined) {
    projected.tokenBudget = tokenBudget;
  }
  delete projected.token_budget;
  if (typeof canonical === "number") {
    // The canonical budget is the effective intent budget, so the command and its echo carry it too.
    projected.tokenBudget = String(canonical);
  } else if (projected.tokenBudget === undefined) {
    projected.tokenBudget = String(contract.token_budget);
  }
  CONTEXT_INTENT_DEFAULT_APPLIERS[command](
    projected,
    contract,
    explicitTokenBudget,
    canonical,
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
    ? `${unicodeSafePrefix(value, 240)}…`
    : value;
}

function parsePositiveIntentTokenBudget(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The canonical `--output-budget` an intent read was invoked with: a positive
 * integer binds the intent's token budget exactly like the legacy
 * `--token-budget` spelling (GH-1662), `"unbounded"` lifts the intent ceiling,
 * and `undefined` leaves the legacy or declared budget in force.
 */
function canonicalIntentOutputBudget(
  options: Record<string, unknown>,
): number | "unbounded" | undefined {
  const value = options.outputBudget ?? options.output_budget;
  return value === "unbounded" ? value : parsePositiveIntentTokenBudget(value);
}

/** The flag a caller's own spelling uses to retry with another budget. */
function intentBudgetFlag(options: Record<string, unknown>): string {
  return canonicalIntentOutputBudget(options) === undefined
    ? "--token-budget"
    : "--output-budget";
}

/**
 * Resolve the intent's effective token budget: a numeric canonical budget,
 * else the legacy override (refused below the receipt minimum), else the
 * declaration.
 */
function resolveEffectiveIntentTokenBudget(
  canonical: number | "unbounded" | undefined,
  legacy: unknown,
  declaredBudget: number,
): number {
  return typeof canonical === "number"
    ? canonical
    : resolveIntentTokenBudget(legacy, declaredBudget);
}

/** Reject budgets below the intent receipt minimum while preserving the caller's value as typed error-context text. */
function resolveIntentTokenBudget(
  value: unknown,
  declaredBudget: number,
): number {
  const parsed = parsePositiveIntentTokenBudget(value);
  if (parsed === undefined) return declaredBudget;
  if (parsed < MINIMUM_CONTEXT_INTENT_TOKEN_BUDGET) {
    throw new PmCliError(
      `Context intent token budget must be at least ${MINIMUM_CONTEXT_INTENT_TOKEN_BUDGET}`,
      EXIT_CODE.USAGE,
      {
        code: "invalid_argument_value",
        reason: "below_minimum",
        field: "tokenBudget",
        value: String(value),
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

/** Fixed overhead and per-row token cost each row-bounded intent reserves when deriving its page size. */
function resolveIntentRowCost(
  command: BuiltInContextIntentCommand,
  intent: string,
): { overhead: number; rowCost: number } {
  const contextOrient = command === "context" && intent === "orient";
  if (command === "context") {
    return contextOrient
      ? { overhead: 1200, rowCost: 600 }
      : { overhead: 800, rowCost: 500 };
  }
  return { overhead: command === "list" ? 520 : 480, rowCost: 16 };
}

function resolveIntentRowBudget(
  command: BuiltInContextIntentCommand,
  intent: string,
  tokenBudget: number,
  explicitTokenBudget: boolean,
): number | undefined {
  if (command === "get" || command === "next") return undefined;
  const { overhead, rowCost } = resolveIntentRowCost(command, intent);
  const calculatedLimit = Math.max(
    command === "context" ? 1 : 2,
    Math.floor((tokenBudget - overhead) / rowCost),
  );
  return explicitTokenBudget
    ? calculatedLimit
    : Math.min(command === "context" ? 20 : 100, calculatedLimit);
}

/**
 * Update a receipt until its estimate matches the serialized projection that contains it.
 * A custom renderer can make the rendering depend on the estimate and oscillate, so the
 * fixpoint is bounded and falls back to the largest estimate it observed.
 */
function updateContextIntentEstimate(
  projected: Record<string, unknown>,
  receipt: PmContextIntentReceipt,
  options: Record<string, unknown>,
): void {
  // Measure the encoding the caller receives (GH-1662): a compact-JSON
  // estimate undercounts pretty JSON and overcounts TOON, so the same budget
  // value would succeed under one spelling and omit under the other.
  const format = readOutputMeasurementFormat(options);
  // The host suppresses discovery-only row contracts the caller did not request,
  // so they are not part of the delivered envelope either.
  const rowContractDelivered =
    options.outputRowContract === true || options.output_row_contract === true;
  let measuredTokens = receipt.estimated_tokens;
  let largestTokens = measuredTokens;
  for (let iteration = 0; iteration < MAX_ESTIMATE_ITERATIONS; iteration += 1) {
    receipt.estimated_tokens = measuredTokens;
    const nextMeasurement = estimateReadOutputTokens(
      rowContractDelivered || !Object.hasOwn(projected, "row_contract")
        ? projected
        : Object.fromEntries(
            Object.entries(projected).filter(([key]) => key !== "row_contract"),
          ),
      format,
    );
    if (nextMeasurement === measuredTokens) return;
    measuredTokens = nextMeasurement;
    largestTokens = Math.max(largestTokens, measuredTokens);
  }
  receipt.estimated_tokens = largestTokens;
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
  next: ["ready", "decision_needed", "gate_needed", "containers", "blocked", "held_by_others"],
  search: ["items"],
};

/** Decoded continuation cursor of a row-compacted context intent read. */
export interface ContextIntentCursorEnvelope {
  /** Fingerprint of the request the cursor continues, so a changed request is refused. */
  fingerprint: string;
  /** Index of the last row already delivered. */
  after_index: number;
  /** Snapshot identity the continuation reads from, when the producer pinned one. */
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
  options: Record<string, unknown>,
): boolean {
  let compacted = false;
  for (;;) {
    updateContextIntentEstimate(projected, receipt, options);
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
      shrinkContextIntentRowsToBudget(projected, receipt, rows, options) || compacted;
    if (!compacted) return false;
    const lastId = contextIntentRowId(rows.at(-1));
    if (lastId === undefined) {
      rows.splice(0, rows.length, ...originalRows);
      updateContextIntentEstimate(projected, receipt, options);
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
    updateContextIntentEstimate(projected, receipt, options);
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
    updateContextIntentEstimate(projected, receipt, options);
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
  const canonicalBudget = canonicalIntentOutputBudget(options);
  const effectiveTokenBudget = resolveEffectiveIntentTokenBudget(
    canonicalBudget,
    options.tokenBudget ?? options.token_budget,
    contract.token_budget,
  );
  const receipt: PmContextIntentReceipt = {
    command: builtInCommand,
    intent: contract.intent,
    source: contract.source!,
    included_field_groups: [...contract.included_field_groups],
    token_budget: effectiveTokenBudget,
    declared_token_budget: contract.token_budget,
    token_budget_override: effectiveTokenBudget - contract.token_budget,
    estimated_tokens: 0,
    within_budget: true,
    degradation: CONTEXT_INTENT_DEGRADATIONS[builtInCommand],
    declaration_feasible: true,
    result_omitted: false,
  };
  const resultWithDiagnostics: Record<string, unknown> = { ...result };
  const budgetDerivedLimit = resolveIntentRowBudget(
    builtInCommand,
    contract.intent,
    receipt.token_budget,
    parsePositiveIntentTokenBudget(
      options.tokenBudget ?? options.token_budget,
    ) !== undefined || typeof canonicalBudget === "number",
  );
  if (budgetDerivedLimit !== undefined) {
    const effectiveLimit = parsePositiveIntentTokenBudget(options.limit);
    const explicitLimitBinds =
      effectiveLimit !== undefined && effectiveLimit < budgetDerivedLimit;
    receipt.budget_derived_limit = budgetDerivedLimit;
    receipt.binding_constraint = explicitLimitBinds
      ? "explicit_limit"
      : "token_budget";
    receipt.limit_reason = explicitLimitBinds
      ? "The caller supplied a smaller row limit than the budget-derived ceiling."
      : "The selected intent token budget constrains the effective row ceiling.";
    resultWithDiagnostics.budget_derived_limit = budgetDerivedLimit;
    discloseIntentLimitOverride(
      { builtInCommand, intent: contract.intent },
      receipt,
      resultWithDiagnostics,
      options,
    );
  }
  // A settled second pass charges the envelope the read-output stage adds (its
  // receipts and any requested row contract) against the intent budget, so row
  // compaction leaves that room; the receipt still reports the caller's budget.
  const envelopeOverhead = intentEnvelopeOverheads.get(options) ?? 0;
  const reportedBudget = receipt.token_budget;
  receipt.token_budget = reportedBudget - envelopeOverhead;
  // An explicitly unbounded read keeps everything it asked for: no string or row compaction.
  const projected = canonicalBudget === "unbounded"
    ? estimatedIntentProjection(resultWithDiagnostics, receipt, options)
    : compactIntentProjection(builtInCommand, resultWithDiagnostics, receipt, options);
  receipt.declaration_feasible =
    receipt.estimated_tokens <= receipt.declared_token_budget;
  const outcome = intentBudgetOutcome(canonicalBudget, receipt, projected, () =>
    buildContextIntentRecoveryCommand(
      command,
      builtInCommand,
      contract.intent,
      // The retry must fit the complete envelope, not only the intent projection.
      { ...receipt, token_budget: reportedBudget, estimated_tokens: receipt.estimated_tokens + envelopeOverhead },
      resultWithDiagnostics,
      options,
    ),
  );
  // An omitted result's estimate covers the envelope it would have delivered,
  // including the overhead this pass reserved, so it exceeds the budget it reports.
  if (receipt.result_omitted) {
    receipt.estimated_tokens += envelopeOverhead;
    receipt.declaration_feasible = receipt.estimated_tokens <= receipt.declared_token_budget;
  }
  receipt.token_budget = reportedBudget;
  return outcome as Result & { context_intent: PmContextIntentReceipt };
}

/** Project an intent result with its receipt and settle the receipt's estimate over it. */
function estimatedIntentProjection(
  result: Record<string, unknown>,
  receipt: PmContextIntentReceipt,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = { ...result, context_intent: receipt };
  updateContextIntentEstimate(projected, receipt, options);
  return projected;
}

/** Compact strings, then rows, until an intent projection fits its fit ceiling or nothing more can be removed. */
function compactIntentProjection(
  builtInCommand: BuiltInContextIntentCommand,
  result: Record<string, unknown>,
  receipt: PmContextIntentReceipt,
  options: Record<string, unknown>,
): Record<string, unknown> {
  let projected = estimatedIntentProjection(result, receipt, options);
  if (receipt.estimated_tokens > receipt.token_budget) {
    receipt.degradation = "recursive_budget_compaction";
    projected = estimatedIntentProjection(compactContextIntentValue(result) as Record<string, unknown>, receipt, options);
  }
  if (
    receipt.estimated_tokens > receipt.token_budget &&
    compactContextIntentRows(builtInCommand, projected, receipt, options)
  ) {
    receipt.degradation = "budget_row_compaction";
    updateContextIntentEstimate(projected, receipt, options);
  }
  return projected;
}

/** Envelope overhead a settled second pass charges against an intent budget, keyed by that pass's options. */
const intentEnvelopeOverheads = new WeakMap<Record<string, unknown>, number>();

/**
 * Decide what an intent read delivers once its estimate is final. A result
 * that fits is delivered. An explicitly unbounded read keeps its result, and
 * the receipt reports the declared ceiling it exceeds instead of omitting what
 * was asked for. A numeric canonical budget keeps the shared universal refusal
 * that callers detect with isReadOutputBudgetExceeded. The legacy spelling
 * keeps its budget_exceeded branch with a replayable restore_with. Every
 * receipt of an omission agrees that it omitted.
 */
function intentBudgetOutcome(
  canonicalBudget: ReturnType<typeof canonicalIntentOutputBudget>,
  receipt: PmContextIntentReceipt,
  projected: Record<string, unknown>,
  restoreWith: () => string,
): Record<string, unknown> {
  if (receipt.estimated_tokens <= receipt.token_budget) return projected;
  receipt.within_budget = false;
  if (canonicalBudget === "unbounded") return projected;
  receipt.degradation = "budget_receipt_only";
  receipt.result_omitted = true;
  if (typeof canonicalBudget === "number") {
    return {
      output_budget_exceeded: {
        omitted_result: true,
        reason: "requested_budget_infeasible",
        restore_with: "Unbounded",
        recovery: { outputBudget: "unbounded" },
      },
      context_intent: receipt,
    };
  }
  return {
    budget_exceeded: {
      omitted_result: true,
      reason:
        receipt.token_budget_override === 0
          ? "declared_budget_infeasible"
          : "effective_budget_infeasible",
      restore_with: restoreWith(),
    },
    context_intent: receipt,
  };
}

const CONTINUATION_METADATA_KEYS = [
  "applied_limit", "completeness", "context_intent", "count", "filters",
  "has_more", "now", "omission_receipt", "projection", "row_contract",
  "sorting", "total", "truncated",
] as const;

/** Producer page whose repeated metadata is referenced from the original page. */
export type PmReadOutputProducerContinuation<Result> = Result extends unknown
  ? Omit<Result, (typeof CONTINUATION_METADATA_KEYS)[number]> &
      Partial<Pick<Result, Extract<keyof Result, (typeof CONTINUATION_METADATA_KEYS)[number]>>> & {
        /** Identity and recovery for metadata served by the initial producer page. */
        continuation_contract: {
          /** Query identity carried by the producer cursor. */
          fingerprint: string;
          /** Repeated metadata remains in the caller's original page. */
          metadata: "reference";
          /** Reissue the initial query to restore its metadata. */
          restore_with: "omit --after";
        };
      }
  : never;

/** Replace repeated metadata with a cursor-bound reference on resumed producer pages. */
function collapseContinuationMetadata(
  options: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> {
  // A budget omission is not a continuation page: its receipts stay whole.
  if (typeof options.after !== "string" || options.after.length === 0 || isReadResultOmittedForBudget(result)) {
    return result;
  }
  const fingerprint =
    decodeContextIntentCursor(options.after)?.fingerprint ?? "opaque_cursor";
  const projected = { ...result };
  for (const key of CONTINUATION_METADATA_KEYS) {
    delete projected[key];
  }
  projected.continuation_contract = {
    fingerprint,
    metadata: "reference",
    restore_with: "omit --after",
  };
  return projected;
}

/** Return whether one projected value is a mutable output record. */
function isOutputRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return the shell-quoted read positional (item id or search query) a retry must repeat. */
function contextIntentRecoveryPositional(
  builtInCommand: BuiltInContextIntentCommand,
  result: Record<string, unknown>,
): string {
  const recoveryTarget =
    builtInCommand === "get" &&
    isOutputRecord(result.item) &&
    typeof result.item.id === "string"
      ? result.item.id
      : builtInCommand === "search" && typeof result.query === "string"
        ? result.query
        : undefined;
  return recoveryTarget === undefined ? "" : ` ${shellQuote(recoveryTarget)}`;
}

/** POSIX single-quote one recovery operand. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The caller's field projection, which the budget a retry names was sized against. */
function contextIntentRecoveryProjection(options: Record<string, unknown>): string {
  return typeof options.fields === "string" && options.fields.trim() !== "" ? ` --fields ${shellQuote(options.fields)}` : "";
}

/** Record a reduced explicit row limit in the receipt, warnings and filters, with the budget that keeps it. */
function discloseIntentLimitOverride(
  identity: {
    builtInCommand: BuiltInContextIntentCommand;
    intent: string;
  },
  receipt: PmContextIntentReceipt,
  result: Record<string, unknown>,
  options: Record<string, unknown>,
): void {
  // Hosts attach receipts with the caller's own options, which still carry the requested limit.
  const requested = parsePositiveIntentTokenBudget(options.limit);
  const effective = receipt.budget_derived_limit!;
  if (requested === undefined || requested <= effective) return;
  const { overhead, rowCost } = resolveIntentRowCost(
    identity.builtInCommand,
    identity.intent,
  );
  const sufficientBudget = Math.max(
    receipt.token_budget,
    overhead + rowCost * requested,
  );
  receipt.limit_reason = `The ${receipt.token_budget}-token ${identity.intent} budget carries ${effective} rows, so it reduced the caller's --limit ${requested}.`;
  // A flag fragment keeps every original positional, inline filter and option; an unparseable budget is not offered.
  receipt.limit_override = {
    flag: "--limit",
    requested,
    effective,
    ...(Number.isSafeInteger(sufficientBudget)
      ? {
          token_budget_for_requested: sufficientBudget,
          restore_with: `${intentBudgetFlag(options)} ${sufficientBudget}`,
        }
      : {}),
  };
  const warning = `${CONTEXT_INTENT_LIMIT_OVERRIDE_WARNING}:--limit ${requested}->${effective}`;
  result.warnings = Array.isArray(result.warnings)
    ? [...(result.warnings as unknown[]), warning]
    : [warning];
  if (isOutputRecord(result.filters)) {
    result.filters = { ...result.filters, requested_limit: String(requested) };
  }
}

/** Build a shell-safe bounded retry while retaining required read positionals. */
function buildContextIntentRecoveryCommand(
  command: string,
  builtInCommand: BuiltInContextIntentCommand,
  intent: string,
  receipt: PmContextIntentReceipt,
  result: Record<string, unknown>,
  options: Record<string, unknown>,
): string {
  const recoveryPositional = contextIntentRecoveryPositional(
    builtInCommand,
    result,
  );
  const boundedRowLimit =
    builtInCommand === "get"
      ? ""
      : ` --limit ${receipt.budget_derived_limit ?? 1}`;
  // The retry renders a slightly different envelope (its own budget digits and
  // limit disclosure), so it carries the universal 25% recovery margin rather
  // than the bare estimate it would sit exactly at (GH-1662).
  const { output_budget: retryBudget } = resolveReadOutputRecoveryBudget({
    effective_budget_tokens: receipt.token_budget,
    measured_result_tokens: receipt.estimated_tokens,
  });
  // The retry keeps the projection the budget was sized against; without it
  // the retry would request more data than the named budget allows.
  return `pm ${command}${recoveryPositional}${contextIntentRecoveryProjection(options)} --for ${intent} --token-budget ${retryBudget}${boundedRowLimit}`;
}

/** Read one numeric fixed-point estimate from an optional receipt. */
function receiptEstimate(value: unknown, field: string): number | undefined {
  if (!isOutputRecord(value)) return undefined;
  return typeof value[field] === "number" ? value[field] : undefined;
}

/** Stabilize every token receipt over the delivered envelope (after any discovery-only metadata is suppressed). */
function stabilizeSuppressedRowContractReceipts(
  result: Record<string, unknown>,
  options: Record<string, unknown>,
): Record<string, unknown> {
  let finalized = result;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    // The fit flag is part of the measured envelope, so it settles with the estimates.
    reconcileIntentFit(finalized);
    const previousContextEstimate = receiptEstimate(
      finalized.context_intent,
      "estimated_tokens",
    );
    const previousReadEstimate = receiptEstimate(
      finalized.read_output,
      "estimated_tokens",
    );
    const previousSessionEstimate = receiptEstimate(
      finalized.read_session,
      "spent_this_call_tokens",
    );
    // An omitted result's intent receipt keeps describing the result it omitted.
    if (isOutputRecord(finalized.context_intent) && finalized.context_intent.result_omitted !== true) {
      updateContextIntentEstimate(
        finalized,
        finalized.context_intent as unknown as PmContextIntentReceipt,
        options,
      );
    }
    finalized = stabilizeReadOutputReceiptEstimates(finalized, options);
    if (
      receiptEstimate(finalized.context_intent, "estimated_tokens") ===
        previousContextEstimate &&
      receiptEstimate(finalized.read_output, "estimated_tokens") ===
        previousReadEstimate &&
      receiptEstimate(finalized.read_session, "spent_this_call_tokens") ===
        previousSessionEstimate
    ) {
      break;
    }
  }
  return finalized;
}

/** A settled intent estimate above its budget never claims a fit. */
function reconcileIntentFit(result: Record<string, unknown>): void {
  const intent = result.context_intent;
  if (isOutputRecord(intent) && Number(intent.estimated_tokens) > Number(intent.token_budget)) intent.within_budget = false;
}

/** Attach universal row, omission, and optional intent-budget contracts in rendering order. */
export function attachReadOutputContracts(
  command: string | undefined,
  options: Record<string, unknown>,
  result: unknown,
): unknown {
  const disclosedResult = attachOutputOmissionReceipt(command, attachExtensionReadOutputRows(command ?? "", result));
  if (typeof disclosedResult !== "object" || disclosedResult === null || Array.isArray(disclosedResult)) {
    propagateContextUsageServingReceipt(result, disclosedResult);
    return disclosedResult;
  }
  const surface = command ?? "";
  const source = disclosedResult as Record<string, unknown>;
  const intentProjected = attachContextIntentReceipt(surface, options, source);
  const intentEstimate = receiptEstimate(intentProjected.context_intent, "estimated_tokens");
  const finalized = finalizeReadOutputEnvelope(surface, options, result, intentProjected);
  // The intent decision saw the projection before the read-output receipt and any
  // requested row contract joined it. A settled envelope over the intent budget is
  // decided again with that measured overhead charged, so both budget spellings
  // bound the bytes actually delivered.
  const settled = settledIntentOverBudget(options, finalized, intentProjected.context_intent);
  if (settled === undefined) return finalized;
  const charged = { ...options };
  intentEnvelopeOverheads.set(charged, settled.estimated - Number(intentEstimate));
  const rechargedIntent = attachContextIntentReceipt(surface, charged, source);
  const recharged = finalizeReadOutputEnvelope(surface, charged, result, rechargedIntent);
  // Reserving the measured overhead does not guarantee that the re-settled
  // envelope fits; a read still over its intent budget is omitted.
  const residual = settledIntentOverBudget(options, recharged, rechargedIntent.context_intent);
  if (residual === undefined) return recharged;
  const receipt = { ...residual.receipt, estimated_tokens: residual.estimated };
  return finalizeReadOutputEnvelope(
    surface,
    options,
    result,
    intentBudgetOutcome(canonicalIntentOutputBudget(options), receipt, recharged, () =>
      buildContextIntentRecoveryCommand(surface, receipt.command as BuiltInContextIntentCommand, receipt.intent, receipt, source, options),
    ),
  );
}

/**
 * The intent receipt and delivered estimate of a budget-bound result whose
 * settled envelope exceeds its intent budget. An include projection can drop
 * the intent receipt from a delivered envelope; its budget still binds the
 * delivered bytes, measured over that envelope.
 */
function settledIntentOverBudget(
  options: Record<string, unknown>,
  finalized: Record<string, unknown>,
  intentReceipt: unknown,
): { receipt: PmContextIntentReceipt; estimated: number } | undefined {
  const delivered = isOutputRecord(finalized.context_intent);
  const settled = delivered ? finalized.context_intent : intentReceipt;
  // A result already omitted by either budget branch is never decided twice.
  if (!isOutputRecord(settled) || settled.result_omitted === true || Object.hasOwn(finalized, "output_budget_exceeded")) return undefined;
  const receipt = settled as unknown as PmContextIntentReceipt;
  const estimated = delivered
    ? receipt.estimated_tokens
    : estimateReadOutputTokens(finalized, readOutputMeasurementFormat(options));
  return canonicalIntentOutputBudget(options) === "unbounded" || estimated <= receipt.token_budget
    ? undefined
    : { receipt, estimated };
}

/** Apply read-output dimensions to an intent projection and settle every receipt over the delivered envelope. */
function finalizeReadOutputEnvelope(
  command: string,
  options: Record<string, unknown>,
  result: unknown,
  intentProjected: Record<string, unknown>,
): Record<string, unknown> {
  const projected = applyReadOutputDimensions(
    command,
    { ...options, outputRowContract: options.outputRowContract === true || options.output_row_contract === true },
    collapseContinuationMetadata(options, intentProjected),
  ) as Record<string, unknown>;
  propagateContextUsageServingReceipt(result, projected);
  if (
    options.outputRowContract === true ||
    options.output_row_contract === true ||
    !Object.hasOwn(projected, "row_contract")
  ) {
    // The intent receipt was estimated before the read-output receipt and any
    // requested row contract joined the envelope: settle it over what is delivered.
    return isOutputRecord(projected.context_intent)
      ? stabilizeSuppressedRowContractReceipts(projected, options)
      : projected;
  }
  const withoutDiscoveryMetadata = Object.fromEntries(
    Object.entries(projected).filter(([key]) => key !== "row_contract"),
  );
  // Session accounting still needs nested row selectors even though the
  // declaration is not part of the serialized response.
  Object.defineProperty(withoutDiscoveryMetadata, "row_contract", {
    value: projected.row_contract,
    enumerable: false,
    configurable: true,
  });
  const suppressed = stabilizeSuppressedRowContractReceipts(withoutDiscoveryMetadata, options);
  delete suppressed.row_contract;
  propagateContextUsageServingReceipt(projected, suppressed);
  return suppressed;
}
