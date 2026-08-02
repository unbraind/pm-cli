/**
 * @module sdk/read-output-contracts
 *
 * Declares and applies one output-bounding vocabulary to every built-in read
 * surface without coupling package authors to command-specific option names.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { compactReadOutputToBudget, updateReadOutputReceiptEstimate } from "./read-output-budget.js";

/** Stable output dimensions shared by every read surface. */
export const PM_READ_OUTPUT_DIMENSIONS = [
  "include",
  "amount",
  "cost",
  "encoding",
] as const;

/** One member of the universal read-output dimension set. */
export type PmReadOutputDimension = (typeof PM_READ_OUTPUT_DIMENSIONS)[number];

/** Built-in command roots whose primary operation is a read. */
export const PM_READ_OUTPUT_SURFACES = [
  "list",
  "context",
  "search",
  "get",
  "next",
  "health",
  "deps",
  "graph",
  "history",
  "activity",
  "validate",
  "events",
  "contracts",
  "comments",
  "notes",
  "files",
  "docs",
  "stats",
  "aggregate",
] as const;

/** Built-in read command supported by the universal output contract. */
export type PmReadOutputSurface = (typeof PM_READ_OUTPUT_SURFACES)[number];

/** Canonical output controls accepted by every built-in read action. */
export interface PmReadOutputOptions {
  /** Comma-separated fields or sections retained in the result. */
  outputInclude?: string | string[];
  /** Maximum rows retained, or `unbounded` to disable the shared row ceiling. */
  outputLimit?: string | number | "unbounded";
  /** Maximum estimated result tokens. */
  outputBudget?: string | number;
  /** Requested static renderer encoding; streaming remains a command behavior. */
  outputFormat?: "json" | "toon";
}

/** Compatibility spelling retained for a command-specific output control. */
export interface PmReadOutputLegacyAlias {
  /** Historical CLI spelling. */
  flag: string;
  /** One-line migration instruction for agents and help generators. */
  migration_hint: string;
  /** Compatibility aliases are accepted but omitted from the canonical vocabulary. */
  visibility: "hidden_alias";
}

/** Contract for one output dimension on one read surface. */
export interface PmReadOutputDimensionContract {
  /** Stable dimension name. */
  dimension: PmReadOutputDimension;
  /** Canonical cross-command CLI option. */
  canonical_option: string;
  /** Whether the dimension has executable behavior on this surface. */
  applicable: boolean;
  /** Explanation used only when the dimension cannot apply. */
  inapplicable_reason: string | null;
  /** Historical command-local options mapped into this dimension. */
  legacy_aliases: PmReadOutputLegacyAlias[];
}

/** Complete four-dimension contract for one read surface. */
export interface PmReadOutputSurfaceContract {
  /** Canonical command root. */
  command: PmReadOutputSurface;
  /** Identical dimension keys shared by every read surface. */
  dimensions: Record<PmReadOutputDimension, PmReadOutputDimensionContract>;
  /** Deterministic precedence from strongest caller declaration to fallback. */
  precedence: readonly ["canonical", "legacy", "intent", "default"];
}

/** Source that selected an effective output dimension. */
export type PmReadOutputDimensionSource =
  | "canonical"
  | "legacy"
  | "intent"
  | "default";

/** Resolved value and provenance for one dimension. */
export interface PmResolvedReadOutputDimension<T> {
  /** Effective value after precedence resolution. */
  value: T;
  /** Layer that supplied the effective value. */
  source: PmReadOutputDimensionSource;
}

/** Fully resolved output controls for one invocation. */
export interface PmResolvedReadOutputDimensions {
  /** Canonical read surface. */
  command: PmReadOutputSurface;
  /** Requested field or section selectors. */
  include?: PmResolvedReadOutputDimension<string[]>;
  /** Requested row ceiling. */
  amount?: PmResolvedReadOutputDimension<number | "unbounded">;
  /** Requested estimated-token ceiling. */
  cost?: PmResolvedReadOutputDimension<number>;
  /** Requested static encoding or a retained legacy streaming behavior. */
  encoding?: PmResolvedReadOutputDimension<"json" | "toon" | "stream">;
  /** Compatibility flags observed on the invocation. */
  legacy_aliases_used: string[];
  /** One-line migration instructions for observed compatibility flags. */
  migration_hints: string[];
  /** Deterministic precedence applied to every dimension. */
  precedence: readonly ["canonical", "legacy", "intent", "default"];
}

/** Machine-readable proof of output dimensions applied to one read. */
export interface PmReadOutputReceipt {
  /** Contract format version. */
  contract_version: 1;
  /** Canonical read surface. */
  command: PmReadOutputSurface;
  /** Dimensions explicitly or compatibly requested by the invocation. */
  requested_dimensions: PmReadOutputDimension[];
  /** Deterministic precedence used during resolution. */
  precedence: readonly ["canonical", "legacy", "intent", "default"];
  /** Compatibility options observed on the invocation. */
  legacy_aliases_used: string[];
  /** One-line migration instructions for compatibility options. */
  migration_hints: string[];
  /** Exact deterministic estimate of the JSON-shaped result carrying this receipt. */
  estimated_tokens: number;
  /** Whether the final result fits the requested cost ceiling. */
  within_budget: boolean;
  /** Whether long string values were shortened while satisfying the cost ceiling. */
  strings_compacted: boolean;
  /** Whether row collections were reduced while satisfying the cost ceiling. */
  rows_compacted: boolean;
  /** Whether the requested cost ceiling forced the useful result to be omitted. */
  result_omitted: boolean;
}

/** Result returned when the requested cost ceiling cannot fit useful content. */
export interface PmReadOutputBudgetExceeded {
  /** Stable omission marker and recovery instruction. */
  output_budget_exceeded: {
    /** Confirms that the useful result was deliberately omitted. */
    omitted_result: true;
    /** Stable reason for machine-readable recovery. */
    reason: "requested_budget_infeasible";
    /** Human- and agent-readable recovery instruction. */
    restore_with: string;
  };
  /** Exact receipt for the bounded omission envelope. */
  read_output: PmReadOutputReceipt;
}

/** Read result with an optional shaping receipt or a discriminated omission. */
export type PmReadOutputResult<Result> =
  | (Result & { read_output?: PmReadOutputReceipt })
  | PmReadOutputBudgetExceeded;

/** Select the omission-aware result type when an option shape can request a budget. */
export type PmReadOutputResultFor<Result, Options> =
  "outputBudget" extends keyof Options ? PmReadOutputResult<Result> : Result;

const READ_OUTPUT_PRECEDENCE = [
  "canonical",
  "legacy",
  "intent",
  "default",
] as const;

const CANONICAL_OPTIONS: Record<PmReadOutputDimension, string> = {
  include: "--output-include",
  amount: "--output-limit",
  cost: "--output-budget",
  encoding: "--output-format",
};

/** Canonical CLI flags that opt a read invocation into universal output shaping. */
export const PM_READ_OUTPUT_OPTION_FLAGS: readonly string[] = Object.freeze(
  PM_READ_OUTPUT_DIMENSIONS.map((dimension) => CANONICAL_OPTIONS[dimension]),
);

const LEGACY_FLAGS_BY_COMMAND: Readonly<
  Record<PmReadOutputSurface, Partial<Record<PmReadOutputDimension, string[]>>>
> = {
  list: {
    include: ["--brief", "--compact", "--fields", "--full"],
    amount: ["--after", "--limit", "--no-truncate"],
    cost: ["--token-budget"],
    encoding: ["--format", "--stream"],
  },
  context: {
    include: ["--fields", "--section"],
    amount: ["--after", "--depth", "--limit"],
    cost: ["--token-budget"],
    encoding: ["--format"],
  },
  search: {
    include: ["--compact", "--fields", "--full"],
    amount: ["--after", "--limit"],
    cost: ["--token-budget"],
    encoding: ["--format"],
  },
  get: {
    include: ["--fields", "--full"],
    amount: ["--depth"],
    cost: ["--token-budget"],
    encoding: ["--format"],
  },
  next: {
    amount: ["--blocked-limit", "--limit"],
    cost: ["--token-budget"],
    encoding: ["--format"],
  },
  health: {
    include: ["--brief", "--check-only", "--full", "--summary", "--verbose"],
  },
  deps: {
    include: ["--collapse", "--full", "--summary"],
    amount: ["--edge-limit", "--max-depth", "--node-limit"],
    cost: ["--token-budget"],
    encoding: ["--format"],
  },
  graph: {
    include: ["--full", "--summary"],
    amount: ["--after", "--limit", "--max-depth", "--max-paths"],
  },
  history: {
    include: ["--compact", "--full"],
    amount: ["--limit"],
    encoding: ["--format"],
  },
  activity: {
    include: ["--compact", "--full"],
    amount: ["--limit", "--unbounded"],
    encoding: ["--stream"],
  },
  validate: { include: ["--counts", "--full", "--verbose"] },
  events: {
    include: ["--full"],
    amount: ["--limit"],
    encoding: ["--follow"],
  },
  contracts: { include: ["--full", "--summary"] },
  comments: { amount: ["--limit"] },
  notes: { amount: ["--limit"] },
  files: {
    amount: ["--limit", "--no-truncate", "--offset"],
  },
  docs: {},
  stats: {},
  aggregate: {},
};

const VALUE_BEARING_INCLUDE_ALIASES = new Set(["--fields", "--section"]);

const BEHAVIOR_PRESERVING_MIGRATION_HINTS: Readonly<Record<string, string>> =
  Object.freeze({
    "--after":
      "--after retains cursor-position semantics; use --output-limit <n> separately to bound returned rows.",
    "--check-only":
      "--check-only retains health side-effect semantics; --output-include does not suppress vector refresh.",
    "--depth":
      "--depth retains traversal or detail-depth semantics; --output-limit does not replace it.",
    "--follow":
      "--follow retains event-tail semantics; --output-format does not enable following.",
    "--max-depth":
      "--max-depth retains graph traversal-depth semantics; --output-limit does not replace it.",
    "--max-paths":
      "--max-paths retains graph path-search semantics; use --output-limit separately to bound returned rows.",
    "--offset":
      "--offset retains positional pagination semantics; use --output-limit separately to bound returned rows.",
    "--stream":
      "--stream retains command streaming semantics; --output-format selects only static result encoding.",
  });

function flagSelector(flag: string): string {
  return flag.slice(2).replaceAll("-", "_");
}

function migrationHint(flag: string, dimension: PmReadOutputDimension): string {
  const behaviorHint = BEHAVIOR_PRESERVING_MIGRATION_HINTS[flag];
  if (behaviorHint !== undefined) return behaviorHint;
  const suffix =
    dimension === "include"
      ? VALUE_BEARING_INCLUDE_ALIASES.has(flag)
        ? "<csv>"
        : flagSelector(flag)
      : dimension === "amount"
        ? "<n>"
        : dimension === "cost"
          ? "<tokens>"
          : "<toon|json>";
  return `${flag} is a compatibility alias; prefer ${CANONICAL_OPTIONS[dimension]} ${suffix}.`;
}

function buildSurfaceContract(
  command: PmReadOutputSurface,
): PmReadOutputSurfaceContract {
  const legacy = LEGACY_FLAGS_BY_COMMAND[command];
  const dimensions = Object.freeze(
    Object.fromEntries(
      PM_READ_OUTPUT_DIMENSIONS.map((dimension) => [
        dimension,
        Object.freeze({
          dimension,
          canonical_option: CANONICAL_OPTIONS[dimension],
          applicable: true,
          inapplicable_reason: null,
          legacy_aliases: Object.freeze(
            (legacy[dimension] ?? []).map((flag) =>
              Object.freeze({
                flag,
                migration_hint: migrationHint(flag, dimension),
                visibility: "hidden_alias" as const,
              }),
            ),
          ) as PmReadOutputLegacyAlias[],
        }),
      ]),
    ),
  ) as Record<PmReadOutputDimension, PmReadOutputDimensionContract>;
  return Object.freeze({ command, dimensions, precedence: READ_OUTPUT_PRECEDENCE });
}

/** Universal output contract for every built-in read surface. */
export const PM_READ_OUTPUT_SURFACE_CONTRACTS: readonly PmReadOutputSurfaceContract[] =
  Object.freeze(PM_READ_OUTPUT_SURFACES.map(buildSurfaceContract));

const SURFACE_CONTRACT_BY_COMMAND = new Map(
  PM_READ_OUTPUT_SURFACE_CONTRACTS.map((contract) => [
    contract.command,
    contract,
  ]),
);

/** Resolve a command or list/context alias to its canonical read-output surface. */
export function resolveReadOutputSurface(
  command: string,
): PmReadOutputSurface | undefined {
  const root = command.trim().toLowerCase().split(/\s+/u)[0]!;
  const normalized = root.startsWith("list-")
    ? "list"
    : root === "ctx"
      ? "context"
      : root;
  return PM_READ_OUTPUT_SURFACES.includes(normalized as PmReadOutputSurface)
    ? (normalized as PmReadOutputSurface)
    : undefined;
}

const CANONICAL_OPTION_KEYS = [
  "outputInclude",
  "output_include",
  "outputLimit",
  "output_limit",
  "outputBudget",
  "output_budget",
  "outputFormat",
  "output_format",
] as const;

const HYBRID_READ_MUTATION_KEYS: Readonly<
  Partial<Record<PmReadOutputSurface, readonly string[]>>
> = {
  comments: ["add", "body", "stdin", "file", "edit", "delete"],
  notes: ["add", "addJson", "stdin", "file", "edit", "delete"],
  files: ["add", "addGlob", "remove", "migrate", "apply", "note"],
  docs: ["add", "addGlob", "remove", "migrate", "note"],
};

function hasCanonicalReadOutputOptions(
  options: Record<string, unknown>,
): boolean {
  return CANONICAL_OPTION_KEYS.some((key) => options[key] !== undefined);
}

const READ_OUTPUT_VALUE_VALIDATORS = [
  {
    keys: ["outputInclude", "output_include"],
    valid: (value: unknown): boolean => stringList(value) !== undefined,
    message:
      "--output-include requires at least one comma-separated field or section.",
  },
  {
    keys: ["outputLimit", "output_limit"],
    valid: (value: unknown): boolean =>
      value === "unbounded" || positiveInteger(value) !== undefined,
    message: "--output-limit must be a positive integer or unbounded.",
  },
  {
    keys: ["outputBudget", "output_budget"],
    valid: (value: unknown): boolean => positiveInteger(value) !== undefined,
    message: "--output-budget must be a positive integer.",
  },
  {
    keys: ["outputFormat", "output_format"],
    valid: (value: unknown): boolean => value === "toon" || value === "json",
    message: "--output-format must be toon or json.",
  },
] as const;

/** Reject malformed or mutation-scoped universal output controls before command execution. */
export function validateReadOutputOptions(
  command: string,
  options: Record<string, unknown>,
): void {
  if (!hasCanonicalReadOutputOptions(options)) return;
  const normalizedCommand = resolveReadOutputSurface(command);
  if (!normalizedCommand) {
    throw new PmCliError(
      `Universal output controls apply only to read commands; ${command || "this command"} is not a read surface.`,
      EXIT_CODE.USAGE,
    );
  }
  if (
    (HYBRID_READ_MUTATION_KEYS[normalizedCommand] ?? []).some(
      (key) => options[key] !== undefined && options[key] !== false,
    )
  ) {
    throw new PmCliError(
      `Universal output controls cannot be combined with a ${normalizedCommand} mutation.`,
      EXIT_CODE.USAGE,
    );
  }
  for (const validator of READ_OUTPUT_VALUE_VALIDATORS) {
    const value = validator.keys
      .map((key) => options[key])
      .find((entry) => entry !== undefined);
    if (value !== undefined && !validator.valid(value)) {
      throw new PmCliError(validator.message, EXIT_CODE.USAGE);
    }
  }
}

function optionKey(flag: string): string {
  return flag
    .slice(2)
    .replace(/-([a-z])/gu, (_, character: string) => character.toUpperCase());
}

function readOption(options: Record<string, unknown>, flag: string): unknown {
  const key = optionKey(flag);
  if (Object.hasOwn(options, key)) return options[key];
  const snakeKey = flag.slice(2).replaceAll("-", "_");
  if (Object.hasOwn(options, snakeKey)) return options[snakeKey];
  if (flag === "--no-truncate" && options.truncate === false) return true;
  return undefined;
}

function isRequestedOption(value: unknown): boolean {
  return value !== undefined && value !== false && value !== null;
}

function stringList(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : [value];
  const normalized = values
    .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveLegacyDimension(
  contract: PmReadOutputDimensionContract,
  options: Record<string, unknown>,
  usable: (candidate: { value: unknown; flag: string }) => boolean,
): { value: unknown; flag: string } | undefined {
  for (const alias of contract.legacy_aliases) {
    const value = readOption(options, alias.flag);
    const candidate = { value, flag: alias.flag };
    if (isRequestedOption(value) && usable(candidate)) return candidate;
  }
  return undefined;
}

function resolveIncludeValue(
  canonical: unknown,
  legacy: { value: unknown; flag: string } | undefined,
): PmResolvedReadOutputDimension<string[]> | undefined {
  const canonicalList = stringList(canonical);
  if (canonicalList) return { source: "canonical", value: canonicalList };
  if (!legacy) return undefined;
  return {
    source: "legacy",
    value: stringList(legacy.value) ?? [flagSelector(legacy.flag)],
  };
}

function resolveAmountValue(
  canonical: unknown,
  legacy: { value: unknown; flag: string } | undefined,
): PmResolvedReadOutputDimension<number | "unbounded"> | undefined {
  if (canonical === "unbounded") {
    return { source: "canonical", value: "unbounded" };
  }
  const canonicalLimit = positiveInteger(canonical);
  if (canonicalLimit !== undefined) {
    return { source: "canonical", value: canonicalLimit };
  }
  if (!legacy) return undefined;
  if (legacy.flag === "--no-truncate" || legacy.flag === "--unbounded") {
    return { source: "legacy", value: "unbounded" };
  }
  const legacyLimit = positiveInteger(legacy.value);
  return legacyLimit === undefined
    ? undefined
    : { source: "legacy", value: legacyLimit };
}

function resolveCostValue(
  canonical: unknown,
  legacy: { value: unknown; flag: string } | undefined,
): PmResolvedReadOutputDimension<number> | undefined {
  const canonicalBudget = positiveInteger(canonical);
  if (canonicalBudget !== undefined) {
    return { source: "canonical", value: canonicalBudget };
  }
  if (!legacy) return undefined;
  const legacyBudget = positiveInteger(legacy.value);
  return legacyBudget === undefined
    ? undefined
    : { source: "legacy", value: legacyBudget };
}

function resolveEncodingValue(
  canonical: unknown,
  legacy: { value: unknown; flag: string } | undefined,
): PmResolvedReadOutputDimension<"json" | "toon" | "stream"> | undefined {
  if (canonical === "json" || canonical === "toon") {
    return { source: "canonical", value: canonical };
  }
  if (!legacy) return undefined;
  if (legacy.flag === "--stream" || legacy.flag === "--follow") {
    return { source: "legacy", value: "stream" };
  }
  return legacy.value === "json" || legacy.value === "toon"
    ? { source: "legacy", value: legacy.value }
    : undefined;
}

/** Resolve canonical and compatibility controls into the universal dimension set. */
export function resolveReadOutputDimensions(
  command: string,
  options: Record<string, unknown>,
): PmResolvedReadOutputDimensions | undefined {
  const normalizedCommand = resolveReadOutputSurface(command);
  if (!normalizedCommand) return undefined;
  const contract = SURFACE_CONTRACT_BY_COMMAND.get(normalizedCommand)!;
  const legacyResolvers = {
    include: (candidate: { value: unknown; flag: string }) =>
      resolveIncludeValue(undefined, candidate),
    amount: (candidate: { value: unknown; flag: string }) =>
      resolveAmountValue(undefined, candidate),
    cost: (candidate: { value: unknown; flag: string }) =>
      resolveCostValue(undefined, candidate),
    encoding: (candidate: { value: unknown; flag: string }) =>
      resolveEncodingValue(undefined, candidate),
  } satisfies Record<
    PmReadOutputDimension,
    (candidate: { value: unknown; flag: string }) => unknown
  >;
  const legacyByDimension = Object.fromEntries(
    PM_READ_OUTPUT_DIMENSIONS.map((dimension) => [
      dimension,
      resolveLegacyDimension(
        contract.dimensions[dimension],
        options,
        (candidate) => legacyResolvers[dimension](candidate) !== undefined,
      ),
    ]),
  ) as Record<
    PmReadOutputDimension,
    { value: unknown; flag: string } | undefined
  >;
  const legacyAliasesUsed = PM_READ_OUTPUT_DIMENSIONS.flatMap((dimension) => {
    const resolved = legacyByDimension[dimension];
    return resolved ? [resolved.flag] : [];
  });
  const migrationHints = PM_READ_OUTPUT_DIMENSIONS.flatMap((dimension) => {
    const resolved = legacyByDimension[dimension];
    if (!resolved) return [];
    const alias = contract.dimensions[dimension].legacy_aliases.find(
      (entry) => entry.flag === resolved.flag,
    )!;
    return [alias.migration_hint];
  });
  return {
    command: normalizedCommand,
    include: resolveIncludeValue(
      options.outputInclude ?? options.output_include,
      legacyByDimension.include,
    ),
    amount: resolveAmountValue(
      options.outputLimit ?? options.output_limit,
      legacyByDimension.amount,
    ),
    cost: resolveCostValue(
      options.outputBudget ?? options.output_budget,
      legacyByDimension.cost,
    ),
    encoding: resolveEncodingValue(
      options.outputFormat ?? options.output_format,
      legacyByDimension.encoding,
    ),
    legacy_aliases_used: legacyAliasesUsed,
    migration_hints: migrationHints,
    precedence: READ_OUTPUT_PRECEDENCE,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ENVELOPE_KEYS = new Set([
  "applied_bound",
  "applied_limit",
  "completeness",
  "continuation_contract",
  "count",
  "filters",
  "has_more",
  "next_cursor",
  "now",
  "omission_receipt",
  "projection",
  "row_contract",
  "sorting",
  "total",
  "truncated",
]);

function rowKeys(result: Record<string, unknown>): string[] {
  const contract = result.row_contract;
  if (isRecord(contract) && Array.isArray(contract.row_keys)) {
    return contract.row_keys.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return Object.entries(result)
    .filter(([, value]) => Array.isArray(value))
    .map(([key]) => key);
}

function projectRecordFields(
  value: Record<string, unknown>,
  selectors: readonly string[],
): Record<string, unknown> {
  const selected = new Set(selectors.map((selector) => selector.split(".")[0]));
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => selected.has(key)),
  );
}

function applyIncludeProjection(
  result: Record<string, unknown>,
  selectors: readonly string[],
): Record<string, unknown> {
  const rows = rowKeys(result);
  const selectedRoot = selectors.some((selector) =>
    Object.hasOwn(result, selector.split(".")[0]!),
  );
  if (rows.length > 0 && !selectedRoot) {
    return Object.fromEntries(
      Object.entries(result).map(([key, value]) => [
        key,
        rows.includes(key) && Array.isArray(value)
          ? value.map((entry) =>
              isRecord(entry) ? projectRecordFields(entry, selectors) : entry,
            )
          : value,
      ]),
    );
  }
  return Object.fromEntries(
    Object.entries(result).filter(
      ([key]) =>
        selectors.some((selector) => selector.split(".")[0] === key) ||
        ENVELOPE_KEYS.has(key),
    ),
  );
}

function applyAmountBound(
  result: Record<string, unknown>,
  amount: number | "unbounded",
): Record<string, unknown> {
  if (amount === "unbounded") return result;
  let truncated = false;
  const rowKeyList = rowKeys(result);
  const rows = new Set(rowKeyList);
  const bounded = Object.fromEntries(
    Object.entries(result).map(([key, value]) => {
      if (!rows.has(key) || !Array.isArray(value) || value.length <= amount) {
        return [key, value];
      }
      truncated = true;
      return [key, value.slice(0, amount)];
    }),
  );
  if (!truncated) return bounded;
  bounded.has_more = true;
  bounded.truncated = true;
  if (typeof bounded.count === "number") {
    bounded.count = rowKeyList.reduce(
      (total, key) =>
        total + (Array.isArray(bounded[key]) ? bounded[key].length : 0),
      0,
    );
  }
  bounded.applied_bound = {
    kind: "output_limit",
    source: "explicit",
    value: amount,
  };
  return bounded;
}

function requestedDimensions(
  resolved: PmResolvedReadOutputDimensions,
): PmReadOutputDimension[] {
  return PM_READ_OUTPUT_DIMENSIONS.filter(
    (dimension) => resolved[dimension] !== undefined,
  );
}

/** Apply universal field, row, and token bounds and attach an exact receipt. */
export function applyReadOutputDimensions<
  Result extends Record<string, unknown>,
>(
  command: string,
  options: Record<string, unknown>,
  result: Result,
): PmReadOutputResult<Result> {
  const resolved = resolveReadOutputDimensions(command, options);
  if (!resolved) return result;
  const requested = requestedDimensions(resolved);
  const canonicalRequested = requested.filter(
    (dimension) => resolved[dimension]?.source === "canonical",
  );
  if (canonicalRequested.length === 0) {
    return result;
  }
  let projected: Record<string, unknown> = { ...result };
  if (resolved.include?.source === "canonical") {
    projected = applyIncludeProjection(projected, resolved.include.value);
  }
  if (resolved.amount?.source === "canonical") {
    projected = applyAmountBound(projected, resolved.amount.value);
  }
  const receipt: PmReadOutputReceipt = {
    contract_version: 1,
    command: resolved.command,
    requested_dimensions: requested,
    precedence: resolved.precedence,
    legacy_aliases_used: resolved.legacy_aliases_used,
    migration_hints: resolved.migration_hints,
    estimated_tokens: 0,
    within_budget: true,
    strings_compacted: false,
    rows_compacted: false,
    result_omitted: false,
  };
  projected.read_output = receipt;
  updateReadOutputReceiptEstimate(projected, receipt);
  const budget =
    resolved.cost?.source === "canonical" ? resolved.cost.value : undefined;
  if (budget !== undefined && receipt.estimated_tokens > budget) {
    projected = compactReadOutputToBudget(projected, receipt, budget);
  }
  if (budget !== undefined && receipt.estimated_tokens > budget) {
    const minimalReceipt: PmReadOutputReceipt = {
      contract_version: 1,
      command: resolved.command,
      requested_dimensions: requested,
      precedence: resolved.precedence,
      legacy_aliases_used: [],
      migration_hints: [],
      estimated_tokens: 0,
      within_budget: false,
      strings_compacted: false,
      rows_compacted: false,
      result_omitted: true,
    };
    const omitted: PmReadOutputBudgetExceeded = {
      output_budget_exceeded: {
        omitted_result: true,
        reason: "requested_budget_infeasible",
        restore_with: "Increase --output-budget or narrow the read.",
      },
      read_output: minimalReceipt,
    };
    updateReadOutputReceiptEstimate(
      omitted as unknown as Record<string, unknown>,
      minimalReceipt,
    );
    return omitted;
  }
  return projected as Result & { read_output: PmReadOutputReceipt };
}

/** Narrow a universal read result to its budget-omission branch. */
export function isReadOutputBudgetExceeded(
  result: unknown,
): result is PmReadOutputBudgetExceeded {
  return (
    isRecord(result) &&
    isRecord(result.output_budget_exceeded) &&
    result.output_budget_exceeded.omitted_result === true &&
    result.output_budget_exceeded.reason === "requested_budget_infeasible"
  );
}

/** Resolve only the canonical renderer override for shared CLI output code. */
export function resolveReadOutputEncoding(
  command: string,
  options: Record<string, unknown>,
): "json" | "toon" | undefined {
  const encoding = resolveReadOutputDimensions(command, options)?.encoding;
  return encoding?.value === "json" || encoding?.value === "toon"
    ? encoding.value
    : undefined;
}
