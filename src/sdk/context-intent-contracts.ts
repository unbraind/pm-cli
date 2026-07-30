/**
 * @module sdk/context-intent-contracts
 *
 * Declares composable, intent-scoped read projections for core commands,
 * workspace configuration, and packages.
 */
import { attachOutputOmissionReceipt } from "./output-projection.js";
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
    | "recursive_budget_compaction"
    | "budget_receipt_only"
    | "standard_item"
    | "none";
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
        "The first two compact governance, ownership, priority, and blocker rows for triage.",
      included_field_groups: [
        "identity",
        "governance",
        "ownership",
        "dependencies",
      ],
      token_budget: 1800,
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
        "The first fifteen ranked canonical lineage candidates with compact match evidence.",
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
  if (exact) return exact;
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
    ) => void
  >
> = {
  context: (projected, contract) => {
    if (projected.depth === undefined) {
      projected.depth = contract.intent === "handoff" ? "deep" : "standard";
    }
    if (projected.section === undefined) {
      projected.section =
        contract.intent === "handoff"
          ? ["activity", "progress", "blockers"]
          : ["hierarchy", "blockers", "activity"];
    }
  },
  get: (projected) => {
    if (projected.depth === undefined && projected.fields === undefined) {
      projected.depth = "standard";
    }
  },
  list: (projected) => {
    if (
      projected.brief === undefined &&
      projected.compact === undefined &&
      projected.full === undefined &&
      projected.fields === undefined
    ) {
      projected.fields =
        "id,title,status,type,priority,parent,assignee,reviewer,risk,confidence,sprint,release,blocked_by,blocked_reason,dependencies,updated_at";
    }
    if (projected.limit === undefined) projected.limit = "2";
  },
  next: (projected) => {
    if (projected.readyOnly === undefined) projected.readyOnly = true;
  },
  search: (projected) => {
    if (
      projected.compact === undefined &&
      projected.full === undefined &&
      projected.fields === undefined
    ) {
      projected.compact = true;
    }
    if (projected.limit === undefined) projected.limit = "15";
  },
};

/** Apply one declared read intent's defaults while preserving explicit caller options. */
export function applyContextIntentProjection(
  command: "context" | "get" | "list" | "next" | "search",
  options: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof options.for !== "string") return options;
  const contract = resolveContextIntentContract(command, options.for)!;
  const projected = { ...options };
  if (projected.tokenBudget === undefined) {
    projected.tokenBudget = String(contract.token_budget);
  }
  CONTEXT_INTENT_DEFAULT_APPLIERS[command](projected, contract);
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
    source: contract.source ?? "core",
    included_field_groups: [...contract.included_field_groups],
    token_budget: resolveIntentTokenBudget(
      options.tokenBudget,
      contract.token_budget,
    ),
    estimated_tokens: 0,
    within_budget: true,
    degradation: CONTEXT_INTENT_DEGRADATIONS[builtInCommand],
  };
  let projected: Record<string, unknown> = {
    ...result,
    context_intent: receipt,
  };
  updateContextIntentEstimate(projected, receipt);
  if (receipt.estimated_tokens > receipt.token_budget) {
    receipt.degradation = "recursive_budget_compaction";
    projected = {
      ...(compactContextIntentValue(result) as Record<string, unknown>),
      context_intent: receipt,
    };
    updateContextIntentEstimate(projected, receipt);
  }
  if (receipt.estimated_tokens > receipt.token_budget) {
    receipt.degradation = "budget_receipt_only";
    projected = {
      budget_exceeded: {
        omitted_result: true,
        restore_with: "Repeat the original command without --for.",
      },
      context_intent: receipt,
    };
    updateContextIntentEstimate(projected, receipt);
  }
  receipt.within_budget = receipt.estimated_tokens <= receipt.token_budget;
  updateContextIntentEstimate(projected, receipt);
  receipt.within_budget = receipt.estimated_tokens <= receipt.token_budget;
  return projected as Result & { context_intent: PmContextIntentReceipt };
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
    ? attachContextIntentReceipt(
        command ?? "",
        options,
        disclosedResult as Record<string, unknown>,
      )
    : disclosedResult;
}
