/**
 * @module sdk/read-output-contracts
 *
 * Declares and applies one output-bounding vocabulary to every built-in read
 * surface without coupling package authors to command-specific option names.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import {
  compactReadOutputToBudget,
  estimateReadOutputTokens,
  resolveReadOutputRecoveryBudget,
  updateReadOutputReceiptEstimate,
} from "./read-output-budget.js";
export { resolveReadOutputRecoveryBudget } from "./read-output-budget.js";
export type {
  PmReadOutputRecoveryBudget,
  PmReadOutputRecoveryBudgetInput,
} from "./read-output-budget.js";
import { resolvePmCommandOutputBudget } from "./cli-contracts/agent-output-contracts.js";
import {
  boundReadOutputRows,
  countReadOutputRows,
  mapReadOutputRows,
  readOutputBudgetCollections,
  readOutputContinuationRowCollections,
  readOutputRowPaths,
} from "./read-output-rows.js";
import {
  applyReadOutputContinuation,
  decodeReadOutputContinuationCursor,
  encodeReadOutputContinuationCursor,
  prioritizeAssuranceAssertions,
  readOutputCollectionFingerprint,
} from "./read-output/continuation.js";
export {
  decodeReadOutputContinuationCursor,
  encodeReadOutputContinuationCursor,
  PM_READ_OUTPUT_CONTINUATION_FINGERPRINT_POLICIES,
  readOutputCollectionFingerprint,
} from "./read-output/continuation.js";
export type { PmReadOutputContinuationFingerprintPolicy } from "./read-output/continuation.js";
import {
  applyReadOutputSessionReferences,
  attachReadOutputSessionReceipt,
  parseReadOutputSession,
  readOutputSessionRemainingTokens,
  type PmReadOutputSessionReceipt,
  type PmReadOutputSessionState,
} from "./read-output-session.js";
import { decodeQueryCursorEnvelope, encodeQueryCursor } from "./pagination.js";

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
  "duplicates",
  "package-catalog",
  "package-manage",
  "comments-audit",
  "assurance",
] as const;

/** Built-in read command supported by the universal output contract. */
export type PmReadOutputSurface = (typeof PM_READ_OUTPUT_SURFACES)[number];

/** Canonical output controls accepted by every built-in read action. */
export interface PmReadOutputOptions {
  /** Comma-separated fields or sections retained in the result. */
  outputInclude?: string | string[];
  /** Maximum rows retained, or `unbounded` to disable the shared row ceiling. */
  outputLimit?: string | number | "unbounded";
  /** Maximum estimated result tokens, or `unbounded` to disable the default ceiling. */
  outputBudget?: string | number | "unbounded";
  /** Requested static renderer encoding; streaming remains a command behavior. */
  outputFormat?: "json" | "toon";
  /** Caller-carried cross-call budget and served-fact state. */
  outputSession?: string | PmReadOutputSessionState;
  /** Opaque continuation returned after a budget-compacted declared row path. */
  outputCursor?: string;
  /** Include row selector and encoding discovery metadata. */
  outputRowContract?: boolean;
}

/** Compatibility spelling retained for a command-specific output control. */
export interface PmReadOutputLegacyAlias {
  /** Historical CLI spelling. */
  flag: string;
  /** Strength of the migration promise carried by this alias. */
  semantics?: "replacement" | "behavior_preserving";
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
  /** Stable policy used before budget compaction selects retained rows. */
  budget_retention_policy: "ordered_prefix" | "verdict_priority";
  /** Exact command-local whole-result modes accepted by `outputInclude`. */
  projection_modes?: readonly string[];
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
  /** Requested estimated-token ceiling or explicit opt-out. */
  cost?: PmResolvedReadOutputDimension<number | "unbounded">;
  /** Requested static encoding or a retained legacy streaming behavior. */
  encoding?: PmResolvedReadOutputDimension<"json" | "toon" | "stream">;
  /** Canonical CLI options observed on the invocation. */
  canonical_options_used?: string[];
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
  /** Layer that supplied an automatically applied token ceiling. */
  budget_source?: "default";
  /** Automatically applied token ceiling; explicit/session budgets already disclose their value. */
  budget_tokens?: number;
  /** Deterministic precedence used during resolution. */
  precedence: readonly ["canonical", "legacy", "intent", "default"];
  /** Canonical CLI options observed on the invocation. */
  canonical_options_used?: string[];
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
  /** Declared or nested collection paths reduced by budget degradation. */
  compacted_row_paths?: string[];
  /** Whether the requested cost ceiling forced the useful result to be omitted. */
  result_omitted: boolean;
  /** Estimated tokens in the useful result immediately before whole-result omission. */
  omitted_result_estimated_tokens?: number;
}

/** Machine-readable explanation of budget-driven row degradation. */
export interface PmReadOutputTruncationDisclosure {
  /** Stable reason for dropping rows. */
  reason: "output_budget_reached";
  /** Layer that supplied the binding ceiling. */
  budget_source: PmReadOutputDimensionSource | "session";
  /** Binding estimated-token ceiling. */
  budget_tokens: number;
  /** Explicit dimensions whose unbounded request was overridden by the ceiling. */
  overridden_dimensions: PmReadOutputDimension[];
  /** Declared or nested collection paths reduced by budget degradation. */
  compacted_row_paths: string[];
  /** Whether next_cursor was moved back to the last row that survived compaction. */
  continuation_cursor_rebased: boolean;
  /** Whether at least one declared row collection can be resumed within the budget. */
  continuation_available: boolean;
  /** Maximum next-page useful-result budget relative to the current budget. */
  recovery_budget_multiplier: number | null;
  /** Bounded continuation instructions for every compacted declared row path. */
  continuations: PmReadOutputContinuation[];
  /** Executable recovery instruction for retrieving the complete result. */
  restore_with: string;
  /** Transport-specific machine recovery options. */
  recovery:
    | {
        /** Opaque value supplied through each declared transport binding. */
        cursor: string;
        /** CLI option accepting cursor. */
        cli: "--output-cursor";
        /** SDK option field accepting cursor. */
        sdk: "outputCursor";
        /** MCP input field accepting cursor. */
        mcp: "outputCursor";
      }
    | {
        cli: string;
        sdk: { outputBudget: number | "unbounded" };
        mcp: { outputBudget: number | "unbounded" };
      };
}

/** One resumable declared-row collection withheld by budget compaction. */
export interface PmReadOutputContinuation {
  /** Dot-delimited declared row path being resumed. */
  path: string;
  /** Opaque cursor accepted by CLI, SDK, and MCP outputCursor inputs. */
  cursor: string;
  /** Rows retained from this path in the current response. */
  retained_rows: number;
  /** Rows remaining after the current response. */
  remaining_rows: number;
  /** Total rows in the stable collection snapshot. */
  total_rows: number;
}

/** Versioned, command-bound cursor payload for one stable declared row collection. */
export interface PmReadOutputCursorEnvelope {
  /** Serialized cursor format version. */
  version: 1;
  /** Canonical read surface that produced the cursor. */
  command: PmReadOutputSurface;
  /** Dot-delimited declared row path being continued. */
  path: string;
  /** Zero-based index of the first withheld row. */
  offset: number;
  /** Stable pre-projection denominator for the row collection. */
  total_rows: number;
  /** Stable identity fingerprint used to refuse stale continuation. */
  fingerprint: string;
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
    /** Transport-specific machine recovery options. */
    recovery: { outputBudget: "unbounded" };
  };
  /** Exact receipt for the bounded omission envelope. */
  read_output: PmReadOutputReceipt;
}

/** Read result with an optional shaping receipt or a discriminated omission. */
export type PmReadOutputResult<Result> =
  | (Result & {
      read_output?: PmReadOutputReceipt;
      read_session?: PmReadOutputSessionReceipt;
      output_budget_truncation?: PmReadOutputTruncationDisclosure;
    })
  | (PmReadOutputBudgetExceeded & {
      read_session?: PmReadOutputSessionReceipt;
    });

/** Select the omission-aware result type when an option shape can request a budget. */
export type PmReadOutputResultFor<Result, Options> =
  "outputBudget" extends keyof Options
    ? PmReadOutputResult<Result>
    : "outputSession" extends keyof Options
      ? PmReadOutputResult<Result>
      : "outputCursor" extends keyof Options
        ? PmReadOutputResult<Result>
        : Result;

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

const READ_OUTPUT_INVOCATION_PROVENANCE = Symbol.for(
  "pm.readOutputInvocationProvenance",
);

interface PmReadOutputInvocationProvenance {
  /** Canonical include modes forwarded through command-local option keys. */
  canonical_include_modes: string[];
  /** Compatibility aliases observed before defaults or canonical forwarding. */
  explicit_legacy_aliases: string[];
  /** Whether the CLI captured the complete set of caller-supplied aliases. */
  cli_invocation_observed?: boolean;
}

type PmReadOutputOptionsWithProvenance = Record<string, unknown> & {
  [READ_OUTPUT_INVOCATION_PROVENANCE]?: PmReadOutputInvocationProvenance;
};

/** Canonical CLI flags that opt a read invocation into universal output shaping. */
export const PM_READ_OUTPUT_OPTION_FLAGS: readonly string[] = Object.freeze(
  PM_READ_OUTPUT_DIMENSIONS.map((dimension) => CANONICAL_OPTIONS[dimension]),
);

/** Canonical control that composes the four per-call dimensions across reads. */
export const PM_READ_OUTPUT_COMPOSITION_OPTION_FLAGS = Object.freeze([
  "--output-session",
  "--output-cursor",
  "--output-row-contract",
] as const);

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
    include: ["--brief", "--check-only", "--full", "--summary"],
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
  validate: { include: ["--counts", "--full"] },
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
  duplicates: { amount: ["--limit"] },
  "package-catalog": {},
  "package-manage": {},
  "comments-audit": {},
  assurance: {},
};

const VALUE_BEARING_INCLUDE_ALIASES = new Set([
  "--collapse",
  "--fields",
  "--section",
]);

const BEHAVIOR_PRESERVING_MIGRATION_HINTS: Readonly<Record<string, string>> =
  Object.freeze({
    "--after":
      "--after retains cursor-position semantics; use --output-limit <n> separately to bound returned rows.",
    "--check-only":
      "--check-only retains health side-effect semantics; --output-include does not suppress vector refresh.",
    "--collapse":
      "--collapse retains dependency grouping semantics; --output-include does not replace it.",
    "--depth":
      "--depth retains traversal or detail-depth semantics; --output-limit does not replace it.",
    "--follow":
      "--follow retains event-tail semantics; --output-format does not enable following.",
    "--max-depth":
      "--max-depth retains graph traversal-depth semantics; --output-limit does not replace it.",
    "--max-paths":
      "--max-paths retains graph path-search semantics; use --output-limit separately to bound returned rows.",
    "--no-truncate":
      "--no-truncate is a compatibility alias; prefer --output-limit unbounded.",
    "--offset":
      "--offset retains positional pagination semantics; use --output-limit separately to bound returned rows.",
    "--stream":
      "--stream retains command streaming semantics; --output-format selects only static result encoding.",
    "--unbounded":
      "--unbounded is a compatibility alias; prefer --output-limit unbounded.",
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
                semantics:
                  BEHAVIOR_PRESERVING_MIGRATION_HINTS[flag] === undefined
                    ? ("replacement" as const)
                    : ("behavior_preserving" as const),
                migration_hint: migrationHint(flag, dimension),
                visibility: "hidden_alias" as const,
              }),
            ),
          ) as PmReadOutputLegacyAlias[],
        }),
      ]),
    ),
  ) as Record<PmReadOutputDimension, PmReadOutputDimensionContract>;
  return Object.freeze({
    command,
    dimensions,
    precedence: READ_OUTPUT_PRECEDENCE,
    budget_retention_policy:
      command === "assurance" ? "verdict_priority" : "ordered_prefix",
    projection_modes: Object.freeze([
      ...readOutputIncludeModeOptions(command).keys(),
    ]),
  });
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
  options: Record<string, unknown> = {},
): PmReadOutputSurface | undefined {
  const normalizedCommand = command
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/gu, " ");
  const packageMode =
    normalizedCommand === "package catalog" ||
    normalizedCommand === "packages catalog" ||
    normalizedCommand === "package-catalog" ||
    ((normalizedCommand === "package" ||
      normalizedCommand === "packages" ||
      normalizedCommand === "extension") &&
      (options.catalog === true ||
        options.target === "catalog" ||
        options.action === "catalog"));
  const root = packageMode
    ? "package-catalog"
    : normalizedCommand === "package manage" ||
        normalizedCommand === "package-manage"
      ? "package-manage"
      : normalizedCommand.split(" ")[0]!;
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
  "outputSession",
  "output_session",
  "outputCursor",
  "output_cursor",
  "outputRowContract",
  "output_row_contract",
] as const;

const HYBRID_READ_MUTATION_KEYS: Readonly<
  Partial<Record<PmReadOutputSurface, readonly string[]>>
> = {
  comments: ["add", "body", "stdin", "file", "edit", "delete"],
  notes: ["add", "addJson", "stdin", "file", "edit", "delete"],
  files: ["add", "addGlob", "remove", "migrate", "apply", "note"],
  docs: ["add", "addGlob", "remove", "migrate", "note"],
  "package-catalog": [
    "activate",
    "adopt",
    "adoptAll",
    "deactivate",
    "doctor",
    "init",
    "install",
    "manage",
    "migrate",
    "reload",
    "scaffold",
    "uninstall",
  ],
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
    valid: (value: unknown): boolean =>
      value === "unbounded" || positiveInteger(value) !== undefined,
    message: "--output-budget must be a positive integer or unbounded.",
  },
  {
    keys: ["outputFormat", "output_format"],
    valid: (value: unknown): boolean => value === "toon" || value === "json",
    message: "--output-format must be toon or json.",
  },
  {
    keys: ["outputSession", "output_session"],
    valid: (value: unknown): boolean => {
      parseReadOutputSession(value);
      return true;
    },
    message: "--output-session must be a valid session-state object.",
  },
  {
    keys: ["outputCursor", "output_cursor"],
    valid: (value: unknown): boolean =>
      typeof value === "string" && value.trim().length > 0,
    message: "--output-cursor requires a non-empty continuation cursor.",
  },
] as const;

/** Reject malformed or mutation-scoped universal output controls before command execution. */
export function validateReadOutputOptions(
  command: string,
  options: Record<string, unknown>,
): void {
  if (!hasCanonicalReadOutputOptions(options)) return;
  const normalizedCommand = resolveReadOutputSurface(command, options);
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

/**
 * Map every canonical `--output-include` token that names a projection mode
 * rather than a row field onto the command-local option that mode already owns.
 *
 * The include dimension folds two kinds of legacy alias into one canonical
 * spelling: value-bearing selectors (`--fields`, `--section`) that name row
 * fields, and mode flags (`--brief`, `--full`, `--summary`, ...) that select a
 * whole declared projection. Only the first kind can be honoured by projecting
 * an already-computed result, so mode tokens have to reach the command itself.
 */
export function readOutputIncludeModeOptions(
  command: string,
): ReadonlyMap<string, string> {
  const surface = resolveReadOutputSurface(command);
  if (!surface) return new Map();
  return new Map(
    (LEGACY_FLAGS_BY_COMMAND[surface].include ?? [])
      .filter(
        (flag) =>
          !VALUE_BEARING_INCLUDE_ALIASES.has(flag) &&
          BEHAVIOR_PRESERVING_MIGRATION_HINTS[flag] === undefined,
      )
      .map((flag) => [flagSelector(flag), optionKey(flag)] as const),
  );
}

/**
 * Translate canonical projection-mode tokens into the command-local options
 * they alias, so the spelling the migration hints recommend is behaviour
 * identical to the legacy flag it replaces, and return the field selectors that
 * remain for post-execution projection.
 */
export function applyReadOutputIncludeModes(
  command: string,
  includeValue: unknown,
  commandOptions: Record<string, unknown>,
): { selectors: string[]; modes: string[] } {
  const requested = stringList(includeValue) ?? [];
  const modeOptions = readOutputIncludeModeOptions(command);
  const selectors: string[] = [];
  const modes: string[] = [];
  const optionsWithProvenance = commandOptions as PmReadOutputOptionsWithProvenance;
  const existingProvenance = optionsWithProvenance[
    READ_OUTPUT_INVOCATION_PROVENANCE
  ];
  const canonicalModes = new Set(
    existingProvenance?.canonical_include_modes ?? [],
  );
  const explicitLegacyAliases = new Set(
    existingProvenance?.explicit_legacy_aliases ?? [],
  );
  for (const token of requested) {
    const option = modeOptions.get(token);
    if (option === undefined) {
      selectors.push(token);
      continue;
    }
    const legacyFlag = `--${token.replaceAll("_", "-")}`;
    if (isRequestedOption(readOption(commandOptions, legacyFlag))) {
      explicitLegacyAliases.add(legacyFlag);
    }
    commandOptions[option] = true;
    modes.push(token);
    canonicalModes.add(token);
  }
  if (modes.length > 0) {
    optionsWithProvenance[READ_OUTPUT_INVOCATION_PROVENANCE] = {
      canonical_include_modes: [...canonicalModes],
      explicit_legacy_aliases: [...explicitLegacyAliases],
      ...(existingProvenance?.cli_invocation_observed === true
        ? { cli_invocation_observed: true }
        : {}),
    };
  }
  return { selectors, modes };
}

/**
 * Resolve canonical include modes against one combined options bag, rewriting
 * the include value in place to the selectors that remain.
 *
 * Used by dispatch paths that carry command options and universal output
 * controls in a single record, so an action honours a mode token exactly as the
 * CLI does.
 */
export function normalizeReadOutputIncludeModeOptions(
  command: string,
  options: Record<string, unknown>,
): void {
  const include = options.outputInclude ?? options.output_include;
  if (include === undefined) return;
  const { selectors, modes } = applyReadOutputIncludeModes(
    command,
    include,
    options,
  );
  if (modes.length === 0) return;
  const residual = selectors.length > 0 ? selectors.join(",") : undefined;
  options.outputInclude = residual;
  if (Object.hasOwn(options, "output_include")) {
    options.output_include = residual;
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
  ignore: (flag: string) => boolean,
): { value: unknown; flag: string } | undefined {
  for (const alias of contract.legacy_aliases) {
    if (ignore(alias.flag)) continue;
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
): PmResolvedReadOutputDimension<number | "unbounded"> | undefined {
  if (canonical === "unbounded") {
    return { source: "canonical", value: "unbounded" };
  }
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

function shouldIgnoreReadOutputLegacyAlias(
  provenance: PmReadOutputInvocationProvenance | undefined,
  dimension: PmReadOutputDimension,
  flag: string,
): boolean {
  if (!provenance) return false;
  const explicitLegacyAliases = new Set(provenance.explicit_legacy_aliases);
  if (provenance.cli_invocation_observed === true) {
    return !explicitLegacyAliases.has(flag);
  }
  const forwardedIncludeAliases = new Set(
    provenance.canonical_include_modes.map(
      (mode) => `--${mode.replaceAll("_", "-")}`,
    ),
  );
  return (
    dimension === "include" &&
    forwardedIncludeAliases.has(flag) &&
    !explicitLegacyAliases.has(flag)
  );
}

function hasCompleteReadOutputIntent(
  command: string,
  legacyByDimension: Record<
    PmReadOutputDimension,
    { value: unknown; flag: string } | undefined
  >,
  provenance: PmReadOutputInvocationProvenance | undefined,
): boolean {
  const root = command
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/gu, " ")
    .split(" ")[0];
  return (
    root === "list-all" ||
    legacyByDimension.amount?.flag === "--no-truncate" ||
    legacyByDimension.include?.flag === "--full" ||
    provenance?.canonical_include_modes.includes("full") === true
  );
}

function canonicalReadOutputOptionsUsed(
  resolvedByDimension: Record<
    PmReadOutputDimension,
    PmResolvedReadOutputDimension<unknown> | undefined
  >,
  provenance: PmReadOutputInvocationProvenance | undefined,
): string[] {
  return PM_READ_OUTPUT_DIMENSIONS.flatMap((dimension) =>
    resolvedByDimension[dimension]?.source === "canonical" ||
    (dimension === "include" &&
      (provenance?.canonical_include_modes.length ?? 0) > 0)
      ? [CANONICAL_OPTIONS[dimension]]
      : [],
  );
}

/** Resolve canonical and compatibility controls into the universal dimension set. */
export function resolveReadOutputDimensions(
  command: string,
  options: Record<string, unknown>,
): PmResolvedReadOutputDimensions | undefined {
  const normalizedCommand = resolveReadOutputSurface(command, options);
  if (!normalizedCommand) return undefined;
  const contract = SURFACE_CONTRACT_BY_COMMAND.get(normalizedCommand)!;
  const invocationProvenance = (options as PmReadOutputOptionsWithProvenance)[
    READ_OUTPUT_INVOCATION_PROVENANCE
  ];
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
        (flag) =>
          shouldIgnoreReadOutputLegacyAlias(
            invocationProvenance,
            dimension,
            flag,
          ),
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
  const encoding = resolveEncodingValue(
    options.outputFormat ?? options.output_format,
    legacyByDimension.encoding,
  );
  const include = resolveIncludeValue(
    options.outputInclude ?? options.output_include,
    legacyByDimension.include,
  );
  const amount = resolveAmountValue(
    options.outputLimit ?? options.output_limit,
    legacyByDimension.amount,
  );
  const explicitCost = resolveCostValue(
    options.outputBudget ?? options.output_budget,
    legacyByDimension.cost,
  );
  const completeResultIntent = hasCompleteReadOutputIntent(
    command,
    legacyByDimension,
    invocationProvenance,
  );
  const budget = resolvePmCommandOutputBudget(command, {
    generateFallback: true,
  });
  const resolvedOutputFormat =
    encoding?.value === "json" || options.resolvedOutputFormat === "json"
      ? "json"
      : "toon";
  const cost =
    explicitCost ??
    (completeResultIntent
      ? { source: "intent" as const, value: "unbounded" as const }
      : {
          source: "default" as const,
          value:
            budget.default_max_estimated_tokens_by_format[
              resolvedOutputFormat
            ],
        });
  const resolvedByDimension = { include, amount, cost, encoding };
  return {
    command: normalizedCommand,
    include,
    amount,
    cost,
    encoding,
    canonical_options_used: canonicalReadOutputOptionsUsed(
      resolvedByDimension,
      invocationProvenance,
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
  "continuation_kind",
  "continuation_path",
  "continuation_contract",
  "count",
  "filters",
  "has_more",
  "next_cursor",
  "now",
  "omission_receipt",
  "projection",
  "budget_retention_policy",
  "row_contract",
  "sorting",
  "total",
  "truncated",
]);

const GET_STABLE_DERIVED_ITEM_SELECTORS = [
  "collection_counts",
  "notes_count",
  "tests_count",
] as const;

function projectRecordFields(
  value: Record<string, unknown>,
  selectors: readonly string[],
): Record<string, unknown> {
  const selected = new Set(selectors.map((selector) => selector.split(".")[0]));
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => selected.has(key)),
  );
}

function getProjectionVocabulary(result: Record<string, unknown>): {
  item: Record<string, unknown>;
  itemFields: string[];
  sections: string[];
  valid: string[];
} {
  const item = isRecord(result.item) ? result.item : {};
  const itemFields = [
    ...new Set([
      ...Object.keys(item),
      ...GET_STABLE_DERIVED_ITEM_SELECTORS.filter((key) =>
        Object.hasOwn(item, key),
      ),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  const sections = Object.keys(result)
    .filter(
      (key) =>
        key !== "item" && key !== "read_output" && !ENVELOPE_KEYS.has(key),
    )
    .sort((left, right) => left.localeCompare(right));
  return {
    item,
    itemFields,
    sections,
    valid: [
      ...itemFields,
      "item",
      ...itemFields.map((field) => `item.${field}`),
      ...sections,
    ],
  };
}

function applyGetIncludeProjection(
  result: Record<string, unknown>,
  selectors: readonly string[],
): Record<string, unknown> {
  const vocabulary = getProjectionVocabulary(result);
  const unknown = selectors.filter(
    (selector) => !vocabulary.valid.includes(selector),
  );
  if (unknown.length > 0) {
    throw new PmCliError(
      `Unknown --output-include selector(s) for get: ${unknown.join(", ")}. Valid selectors: ${vocabulary.valid.join(", ")}.`,
      EXIT_CODE.USAGE,
    );
  }
  const fullItem = selectors.includes("item");
  const itemSelectors = selectors
    .flatMap((selector) =>
      selector.startsWith("item.")
        ? [selector.slice("item.".length)]
        : vocabulary.itemFields.includes(selector)
          ? [selector]
          : [],
    )
    .filter((selector, index, values) => values.indexOf(selector) === index);
  if (fullItem && itemSelectors.length > 0) {
    throw new PmCliError(
      "--output-include cannot mix a full item with projected item fields; use item or item.<field>, not both.",
      EXIT_CODE.USAGE,
    );
  }
  const selectedSections = new Set(
    selectors.filter((selector) => vocabulary.sections.includes(selector)),
  );
  const projected = Object.fromEntries(
    Object.entries(result).filter(
      ([key]) => ENVELOPE_KEYS.has(key) || selectedSections.has(key),
    ),
  );
  if (fullItem) {
    projected.item = vocabulary.item;
  } else if (itemSelectors.length > 0) {
    projected.item = projectRecordFields(vocabulary.item, itemSelectors);
  }
  const omittedFieldGroups = [
    ...(fullItem
      ? []
      : itemSelectors.length > 0
        ? vocabulary.itemFields
            .filter((field) => !itemSelectors.includes(field))
            .map((field) => ({
              name: `item.${field}`,
              restore_with: `--output-include item.${field}`,
            }))
        : [{ name: "item", restore_with: "--output-include item" }]),
    ...vocabulary.sections
      .filter((section) => !selectedSections.has(section))
      .map((section) => ({
        name: section,
        restore_with: `--output-include ${section}`,
      })),
  ];
  const inheritedOmittedFieldGroups =
    isRecord(projected.omission_receipt) &&
    Array.isArray(projected.omission_receipt.omitted_field_groups)
      ? projected.omission_receipt.omitted_field_groups
      : [];
  const combinedOmittedFieldGroups = [
    ...inheritedOmittedFieldGroups,
    ...omittedFieldGroups,
  ];
  projected.omission_receipt = {
    has_omissions: combinedOmittedFieldGroups.length > 0,
    omitted_field_group_count: combinedOmittedFieldGroups.length,
    omitted_field_groups: combinedOmittedFieldGroups,
  };
  return projected;
}

/** Count row objects that still carry at least one field. */
function countPopulatedRows(result: Record<string, unknown>): number {
  let populated = 0;
  mapReadOutputRows({ ...result }, (entry) => {
    if (isRecord(entry) && Object.keys(entry).length > 0) populated += 1;
    return entry;
  });
  return populated;
}

/**
 * Refuse an include projection that strips every field from every row.
 *
 * Selectors that match no field are not a narrower answer, they are no answer:
 * without this the surface returns the requested row count as empty objects and
 * exits 0, so a mistyped or mode-shaped selector is indistinguishable from a
 * workspace that genuinely holds nothing.
 */
function rejectEmptyIncludeProjection(
  command: PmReadOutputSurface,
  original: Record<string, unknown>,
  shaped: Record<string, unknown>,
  selectors: readonly string[],
): void {
  if (countPopulatedRows(original) === 0 || countPopulatedRows(shaped) > 0) {
    return;
  }
  const modes = [...readOutputIncludeModeOptions(command).keys()];
  const domain =
    modes.length > 0
      ? ` Declared ${command} projection modes: ${modes.join(", ")}.`
      : ` The ${command} surface declares no projection modes; name row fields instead.`;
  throw new PmCliError(
    `Unknown --output-include selector(s) for ${command}: ${selectors.join(", ")}. No selector matched any returned row field.${domain}`,
    EXIT_CODE.USAGE,
  );
}

function applyIncludeProjection(
  command: PmReadOutputSurface,
  result: Record<string, unknown>,
  selectors: readonly string[],
): Record<string, unknown> {
  if (command === "get") {
    return applyGetIncludeProjection(result, selectors);
  }
  const rows = readOutputRowPaths(result);
  const qualifiedRowSelectors = selectors.flatMap((selector) =>
    rows.flatMap((rowPath) =>
      selector.startsWith(`${rowPath}.`)
        ? [selector.slice(rowPath.length + 1)]
        : [],
    ),
  );
  const selectedRoot = selectors.some(
    (selector) =>
      Object.hasOwn(result, selector.split(".")[0]!) &&
      !rows.some((rowPath) => selector.startsWith(`${rowPath}.`)),
  );
  if (rows.length > 0 && (!selectedRoot || qualifiedRowSelectors.length > 0)) {
    const projected = { ...result };
    const rowSelectors =
      qualifiedRowSelectors.length > 0 ? qualifiedRowSelectors : selectors;
    const shaped = mapReadOutputRows(projected, (entry) =>
      isRecord(entry) ? projectRecordFields(entry, rowSelectors) : entry,
    );
    rejectEmptyIncludeProjection(command, result, shaped, rowSelectors);
    return shaped;
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
  const { result: bounded, truncated } = boundReadOutputRows(result, amount);
  if (!truncated) return bounded;
  bounded.has_more = true;
  bounded.truncated = true;
  if (typeof bounded.count === "number") {
    bounded.count = countReadOutputRows(bounded);
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
    (dimension) =>
      (resolved[dimension] !== undefined &&
        resolved[dimension]?.source !== "default") ||
      resolved.canonical_options_used!.includes(
        CANONICAL_OPTIONS[dimension],
      ),
  );
}

/** Stabilize the per-call and cross-call receipts in one complete envelope. */
function attachReadOutputSessionContracts(
  result: Record<string, unknown>,
  state: PmReadOutputSessionState,
  receipt: PmReadOutputReceipt,
): Record<string, unknown> {
  let withSession = attachReadOutputSessionReceipt(result, state);
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const previousReadEstimate = receipt.estimated_tokens;
    const previousSessionEstimate = (
      withSession.read_session as PmReadOutputSessionReceipt
    ).spent_this_call_tokens;
    updateReadOutputReceiptEstimate(withSession, receipt);
    withSession = attachReadOutputSessionReceipt(withSession, state);
    const sessionEstimate = (
      withSession.read_session as PmReadOutputSessionReceipt
    ).spent_this_call_tokens;
    if (
      receipt.estimated_tokens === previousReadEstimate &&
      sessionEstimate === previousSessionEstimate
    ) {
      return withSession;
    }
  }
  return withSession;
}

/** Recompute read and optional session receipts after a final envelope projection. */
export function stabilizeReadOutputReceiptEstimates(
  result: Record<string, unknown>,
  options: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(result.read_output)) return result;
  const receipt = result.read_output as unknown as PmReadOutputReceipt;
  const session = parseReadOutputSession(
    options.outputSession ?? options.output_session,
  );
  if (session === undefined) {
    updateReadOutputReceiptEstimate(result, receipt);
    return result;
  }
  return attachReadOutputSessionContracts(result, session, receipt);
}

/** Declare independently resumable validate diagnostic arrays on rich results. */
function attachValidateDiagnosticRowContract(
  command: PmReadOutputSurface,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (command !== "validate") return result;
  const projection = isRecord(result.projection)
    ? result.projection
    : undefined;
  const declaredFieldGroups = Array.isArray(projection?.declared_field_groups)
    ? projection.declared_field_groups
    : [];
  if (
    !declaredFieldGroups.some(
      (group) => isRecord(group) && group.name === "diagnostic_rows",
    )
  ) {
    return result;
  }
  const diagnosticCollectionPaths = [
    ...new Set(
      readOutputBudgetCollections(result)
        .map(({ path }) => path)
        .filter((path) => /^checks\.\d+\.details\./u.test(path)),
    ),
  ];
  const diagnosticRowKeys = diagnosticCollectionPaths.filter(
    (path) =>
      !diagnosticCollectionPaths.some(
        (candidate) => candidate !== path && path.startsWith(`${candidate}.`),
      ),
  );
  if (diagnosticRowKeys.length === 0) return result;
  const existingContract = isRecord(result.row_contract)
    ? result.row_contract
    : {};
  const existingRowKeys = Array.isArray(existingContract.row_keys)
    ? existingContract.row_keys.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const existingContinuationRowKeys = Array.isArray(
    existingContract.continuation_row_keys,
  )
    ? existingContract.continuation_row_keys.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const rowKeys =
    existingRowKeys.length > 0 ? existingRowKeys : diagnosticRowKeys;
  const continuationRowKeys = [...new Set(diagnosticRowKeys)];
  return JSON.stringify(rowKeys) === JSON.stringify(existingRowKeys) &&
    JSON.stringify(continuationRowKeys) ===
      JSON.stringify(existingContinuationRowKeys)
    ? result
    : {
        ...result,
        row_contract: {
          ...existingContract,
          row_keys: rowKeys,
          continuation_row_keys: continuationRowKeys,
          jq_selector:
            typeof existingContract.jq_selector === "string"
              ? existingContract.jq_selector
              : ".checks[].details",
        },
      };
}

/** Apply field, amount, and repeat projections to every declared row path. */
function projectReadOutputRows(
  result: Record<string, unknown>,
  resolved: PmResolvedReadOutputDimensions,
  session: PmReadOutputSessionState | undefined,
  cursor: PmReadOutputCursorEnvelope | undefined,
): Record<string, unknown> {
  let projected = { ...result };
  if (resolved.include?.source === "canonical") {
    projected = applyIncludeProjection(
      resolved.command,
      projected,
      resolved.include.value,
    );
  }
  if (resolved.command === "assurance") {
    projected = prioritizeAssuranceAssertions(projected);
  }
  projected = applyReadOutputContinuation(projected, resolved.command, cursor);
  if (resolved.amount?.source === "canonical") {
    projected = applyAmountBound(projected, resolved.amount.value);
  }
  return session === undefined
    ? projected
    : applyReadOutputSessionReferences(projected, session);
}

/** Resolve the smallest binding per-call or remaining cross-call ceiling. */
function resolveBindingReadOutputBudget(
  resolved: PmResolvedReadOutputDimensions,
  session: PmReadOutputSessionState | undefined,
):
  | {
      source: PmReadOutputDimensionSource | "session";
      tokens: number;
    }
  | undefined {
  const budgets: Array<{
    source: PmReadOutputDimensionSource | "session";
    tokens: number;
  }> = [
    ...(resolved.cost !== undefined &&
    resolved.cost.value !== "unbounded" &&
    (resolved.cost.source === "canonical" || resolved.cost.source === "default")
      ? [{ source: resolved.cost.source, tokens: resolved.cost.value }]
      : []),
    ...(session === undefined
      ? []
      : [
          {
            source: "session" as const,
            tokens: readOutputSessionRemainingTokens(session),
          },
        ]),
  ];
  return budgets.sort((left, right) => left.tokens - right.tokens)[0];
}

function canonicalReadOutputReceiptFields(
  resolved: PmResolvedReadOutputDimensions,
): Pick<PmReadOutputReceipt, "canonical_options_used"> {
  const canonicalOptions = resolved.canonical_options_used;
  return canonicalOptions && canonicalOptions.length > 0
    ? { canonical_options_used: canonicalOptions }
    : {};
}

/** Build the smallest truthful omission envelope or reject an exhausted session. */
function omitReadOutputForBudget(
  resolved: PmResolvedReadOutputDimensions,
  requested: PmReadOutputDimension[],
  session: PmReadOutputSessionState | undefined,
  bindingBudget: {
    source: PmReadOutputDimensionSource | "session";
    tokens: number;
  },
  omittedResultEstimatedTokens: number,
): Record<string, unknown> {
  const minimalReceipt: PmReadOutputReceipt = {
    contract_version: 1,
    command: resolved.command,
    requested_dimensions: requested,
    ...(bindingBudget.source === "default"
      ? {
          budget_source: bindingBudget.source,
          budget_tokens: bindingBudget.tokens,
        }
      : {}),
    precedence: resolved.precedence,
    ...canonicalReadOutputReceiptFields(resolved),
    legacy_aliases_used: [],
    migration_hints: [],
    estimated_tokens: 0,
    within_budget: false,
    strings_compacted: false,
    rows_compacted: false,
    result_omitted: true,
    ...(session === undefined
      ? { omitted_result_estimated_tokens: omittedResultEstimatedTokens }
      : {}),
  };
  const omitted: PmReadOutputBudgetExceeded = {
    output_budget_exceeded: {
      omitted_result: true,
      reason: "requested_budget_infeasible",
      restore_with: "Unbounded",
      recovery: { outputBudget: "unbounded" },
    },
    read_output: minimalReceipt,
  };
  const boundedOmission =
    session === undefined
      ? (omitted as unknown as Record<string, unknown>)
      : attachReadOutputSessionContracts(
          omitted as unknown as Record<string, unknown>,
          session,
          minimalReceipt,
        );
  if (session === undefined) {
    updateReadOutputReceiptEstimate(boundedOmission, minimalReceipt);
  }
  if (
    session !== undefined &&
    minimalReceipt.estimated_tokens > bindingBudget.tokens
  ) {
    throw new PmCliError(
      "The remaining output-session budget cannot fit its mandatory receipts; start a new session with a larger token_budget.",
      EXIT_CODE.USAGE,
    );
  }
  return boundedOmission;
}

/** Decide whether shaping would add no value to an already-bounded result. */
function canReturnReadOutputUnchanged(
  resolved: PmResolvedReadOutputDimensions,
  session: PmReadOutputSessionState | undefined,
  result: Record<string, unknown>,
): boolean {
  if (session !== undefined) return false;
  const canonicalRequestedCount = resolved.canonical_options_used!.length;
  if (resolved.cost?.value === "unbounded") {
    return (
      canonicalRequestedCount === (resolved.cost.source === "canonical" ? 1 : 0)
    );
  }
  if (resolved.cost?.source === "legacy" && canonicalRequestedCount === 0) {
    return true;
  }
  return (
    canonicalRequestedCount === 0 &&
    (resolved.cost === undefined ||
      estimateReadOutputTokens(result) <= resolved.cost.value)
  );
}

/**
 * Disclose a budget-driven row drop in the envelope that carries it.
 *
 * `has_more` and `truncated` say that rows were withheld but not why, by what,
 * or how to get them: the row-compaction path emits no continuation cursor, so
 * without this an explicitly requested unbounded read is silently downgraded and
 * the only working recovery is never named.
 */
function attachReadOutputTruncationDisclosure(
  projected: Record<string, unknown>,
  resolved: PmResolvedReadOutputDimensions,
  receipt: PmReadOutputReceipt,
  bindingBudget: {
    source: PmReadOutputDimensionSource | "session";
    tokens: number;
  },
  continuationCursorRebased: boolean,
  measuredResultTokens: number,
  collectionsBeforeBudget: ReadonlyMap<
    string,
    { rows: number; totalRows: number; baseOffset: number; fingerprint: string }
  >,
): void {
  if (!receipt.rows_compacted) return;
  const overridden =
    resolved.amount?.value === "unbounded" ? (["amount"] as const) : [];
  const afterByPath = new Map(
    readOutputContinuationRowCollections(projected).map((collection) => [
      collection.path,
      Array.isArray(collection.value)
        ? collection.value.length
        : Object.keys(collection.value).length,
    ]),
  );
  const continuations = [...collectionsBeforeBudget.entries()].flatMap(
    ([path, before]) => {
      // Budget compaction preserves every declared collection and shortens its
      // contents, so each pre-budget path has a post-budget cardinality.
      const retainedRows = afterByPath.get(path)!;
      if (retainedRows >= before.rows) return [];
      const offset = before.baseOffset + retainedRows;
      return [
        {
          path,
          cursor: encodeReadOutputContinuationCursor({
            command: resolved.command,
            path,
            offset,
            total_rows: before.totalRows,
            fingerprint: before.fingerprint,
          }),
          retained_rows: retainedRows,
          remaining_rows: before.totalRows - offset,
          total_rows: before.totalRows,
        },
      ];
    },
  );
  const primary = continuations[0];
  const recoveryBudget = resolveReadOutputRecoveryBudget({
    effective_budget_tokens: bindingBudget.tokens,
    measured_result_tokens: measuredResultTokens,
  });
  if (primary && typeof projected.next_cursor !== "string") {
    projected.next_cursor = primary.cursor;
  }
  projected.continuation_kind = continuationCursorRebased
    ? "producer_cursor"
    : primary
      ? "output_cursor"
      : "none";
  projected.output_budget_truncation = {
    reason: "output_budget_reached",
    budget_source: bindingBudget.source,
    budget_tokens: bindingBudget.tokens,
    overridden_dimensions: overridden,
    compacted_row_paths: receipt.compacted_row_paths!,
    continuation_cursor_rebased: continuationCursorRebased,
    continuation_available: continuations.length > 0,
    recovery_budget_multiplier: primary
      ? 1
      : recoveryBudget.recovery_budget_multiplier,
    continuations,
    restore_with: primary
      ? "Use recovery binding."
      : `Retry with --output-budget ${recoveryBudget.output_budget} because no declared row collection can be continued.`,
    recovery: primary
      ? {
          cursor: primary.cursor,
          cli: "--output-cursor",
          sdk: "outputCursor",
          mcp: "outputCursor",
        }
      : {
          cli: `--output-budget ${recoveryBudget.output_budget}`,
          sdk: { outputBudget: recoveryBudget.output_budget },
          mcp: { outputBudget: recoveryBudget.output_budget },
        },
  };
}

/** Rebase a producer cursor when budget compaction removes rows from its page. */
function rebaseBudgetCompactedCursor(
  projected: Record<string, unknown>,
  originalItemCount: number,
  cursorSource: unknown,
  cursorContinuesExistingPage: boolean,
): boolean {
  if (typeof cursorSource !== "string" || !Array.isArray(projected.items)) {
    return false;
  }
  const retainedCount = projected.items.length;
  if (retainedCount === 0 || retainedCount >= originalItemCount) {
    return false;
  }
  let cursor;
  try {
    cursor = decodeQueryCursorEnvelope(cursorSource);
  } catch {
    return false;
  }
  const sourceIndex = cursor.after_index;
  if (sourceIndex === undefined) return false;
  const last = projected.items.at(-1);
  if (Object.prototype.toString.call(last) !== "[object Object]") {
    return false;
  }
  const lastId = Reflect.get(last as object, "id") as unknown;
  if (typeof lastId !== "string" || lastId.length === 0) return false;
  const afterIndex = cursorContinuesExistingPage
    ? sourceIndex - (originalItemCount - retainedCount)
    : sourceIndex + retainedCount;
  if (afterIndex < 0) return false;
  projected.next_cursor = encodeQueryCursor(
    cursor.fingerprint,
    lastId,
    afterIndex,
    cursor.snapshot,
  );
  if (typeof projected.applied_limit === "number") {
    projected.applied_limit = retainedCount;
  }
  return true;
}

interface ReadOutputContinuationState {
  collectionsBeforeBudget: ReadonlyMap<
    string,
    { rows: number; totalRows: number; baseOffset: number; fingerprint: string }
  >;
  originalItemCount: number;
  cursorContinuesExistingPage: boolean;
  cursorSource: unknown;
}

function captureReadOutputContinuationState(
  projected: Record<string, unknown>,
  command: PmReadOutputSurface,
  cursor: PmReadOutputCursorEnvelope | undefined,
  options: Record<string, unknown>,
): ReadOutputContinuationState {
  const collectionsBeforeBudget = new Map(
    readOutputContinuationRowCollections(projected).map((collection) => {
      const rows = Array.isArray(collection.value)
        ? collection.value.length
        : Object.keys(collection.value).length;
      const continued = cursor?.path === collection.path;
      return [
        collection.path,
        {
          rows,
          totalRows: continued ? cursor.total_rows : rows,
          baseOffset: continued ? cursor.offset : 0,
          fingerprint: continued
            ? cursor.fingerprint
            : readOutputCollectionFingerprint(
                collection.path,
                collection.value,
                command,
              ),
        },
      ];
    }),
  );
  const cursorContinuesExistingPage = typeof projected.next_cursor === "string";
  return {
    collectionsBeforeBudget,
    originalItemCount: Array.isArray(projected.items)
      ? projected.items.length
      : 0,
    cursorContinuesExistingPage,
    cursorSource: cursorContinuesExistingPage
      ? projected.next_cursor
      : options.after,
  };
}

function compactReadOutputProjection(
  projected: Record<string, unknown>,
  resolved: PmResolvedReadOutputDimensions,
  receipt: PmReadOutputReceipt,
  bindingBudget: {
    source: PmReadOutputDimensionSource | "session";
    tokens: number;
  },
  session: PmReadOutputSessionState | undefined,
  continuationState: ReadOutputContinuationState,
  measuredResultTokens: number,
): Record<string, unknown> {
  const assuranceMinimumRows =
    resolved.command === "assurance" && Array.isArray(projected.assertions)
      ? projected.assertions.filter(
          (row) => isRecord(row) && row.verdict !== "pass",
        ).length
      : 0;
  let compacted = compactReadOutputToBudget(
    projected,
    receipt,
    bindingBudget.tokens,
    assuranceMinimumRows > 0
      ? new Map([["assertions", assuranceMinimumRows]])
      : new Map(),
  );
  const continuationCursorRebased = rebaseBudgetCompactedCursor(
    compacted,
    continuationState.originalItemCount,
    continuationState.cursorSource,
    continuationState.cursorContinuesExistingPage,
  );
  attachReadOutputTruncationDisclosure(
    compacted,
    resolved,
    receipt,
    bindingBudget,
    continuationCursorRebased,
    measuredResultTokens,
    continuationState.collectionsBeforeBudget,
  );
  if (session !== undefined) {
    compacted = attachReadOutputSessionContracts(compacted, session, receipt);
  }
  return compacted;
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
  const session = parseReadOutputSession(
    options.outputSession ?? options.output_session,
  );
  const rawCursor = options.outputCursor ?? options.output_cursor;
  const cursor =
    typeof rawCursor === "string"
      ? decodeReadOutputContinuationCursor(rawCursor)
      : undefined;
  const requested = requestedDimensions(resolved);
  if (
    cursor === undefined &&
    canReturnReadOutputUnchanged(resolved, session, result)
  ) {
    return result;
  }
  const continuationReadyResult = attachValidateDiagnosticRowContract(
    resolved.command,
    result,
  );
  const bindingBudget = resolveBindingReadOutputBudget(resolved, session);
  let projected = projectReadOutputRows(
    continuationReadyResult,
    resolved,
    session,
    cursor,
  );
  const continuationState = captureReadOutputContinuationState(
    projected,
    resolved.command,
    cursor,
    options,
  );
  const receipt: PmReadOutputReceipt = {
    contract_version: 1,
    command: resolved.command,
    requested_dimensions: requested,
    ...(bindingBudget?.source === "default"
      ? {
          budget_source: bindingBudget.source,
          budget_tokens: bindingBudget.tokens,
        }
      : {}),
    precedence: resolved.precedence,
    ...canonicalReadOutputReceiptFields(resolved),
    legacy_aliases_used: resolved.legacy_aliases_used,
    migration_hints: resolved.migration_hints,
    estimated_tokens: 0,
    within_budget: true,
    strings_compacted: false,
    rows_compacted: false,
    result_omitted: false,
  };
  projected.read_output = receipt;
  projected =
    session === undefined
      ? projected
      : attachReadOutputSessionContracts(projected, session, receipt);
  updateReadOutputReceiptEstimate(projected, receipt);
  if (
    bindingBudget !== undefined &&
    receipt.estimated_tokens > bindingBudget.tokens
  ) {
    const measuredResultTokens = receipt.estimated_tokens;
    projected = compactReadOutputProjection(
      projected,
      resolved,
      receipt,
      bindingBudget,
      session,
      continuationState,
      measuredResultTokens,
    );
  }
  if (
    bindingBudget !== undefined &&
    receipt.estimated_tokens > bindingBudget.tokens
  ) {
    return omitReadOutputForBudget(
      resolved,
      requested,
      session,
      bindingBudget,
      receipt.estimated_tokens,
    ) as PmReadOutputResult<Result>;
  }
  return projected as Result & {
    read_output: PmReadOutputReceipt;
  };
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
