/**
 * @module sdk/cli-contracts/agent-output-contracts
 *
 * Declares the agent-facing output budget vocabulary shared by CLI, SDK,
 * packages, contract discovery, and regression gates. The contracts describe
 * output policy without coupling package authors to pm's renderer.
 */
import { PM_CORE_COMMAND_NAMES } from "./enum-contracts.js";

/** Stable degradation stages applied when an output exceeds its token budget. */
export const PM_OUTPUT_DEGRADATION_STEPS = [
  "full",
  "compact",
  "brief",
  "summary",
  "counts",
] as const;

/** Restricts deterministic output degradation stages. */
export type PmOutputDegradationStep =
  (typeof PM_OUTPUT_DEGRADATION_STEPS)[number];

/** Stable command-output classes used to assign conservative default budgets. */
export const PM_OUTPUT_BUDGET_CLASSES = [
  "mutation",
  "read",
  "discovery",
  "governance",
] as const;

/** Restricts command-output budget classes. */
export type PmOutputBudgetClass = (typeof PM_OUTPUT_BUDGET_CLASSES)[number];

/** Stable diagnostic families that require independent output ceilings. */
export const PM_DIAGNOSTIC_OUTPUT_CLASSES = [
  "error",
  "warning",
  "validation_summary",
  "recovery_bundle",
] as const;

/** Restricts diagnostic budget selection to declared families. */
export type PmDiagnosticOutputClass =
  (typeof PM_DIAGNOSTIC_OUTPUT_CLASSES)[number];

/** Deterministic diagnostic degradation stages, from richest to smallest. */
export const PM_DIAGNOSTIC_DEGRADATION_STEPS = [
  "full",
  "omit_explanation",
  "limit_collections",
  "compact_recovery",
  "action_only",
] as const;

/** Restricts diagnostic degradation receipts to declared stages. */
export type PmDiagnosticDegradationStep =
  (typeof PM_DIAGNOSTIC_DEGRADATION_STEPS)[number];

/** Declares one diagnostic family's text and JSON token ceilings. */
export interface PmDiagnosticOutputBudgetContract {
  /** Diagnostic family governed by this contract. */
  diagnostic_class: PmDiagnosticOutputClass;
  /** Default ceiling by rendered transport. */
  default_max_estimated_tokens_by_format: Readonly<{
    text: number;
    json: number;
  }>;
  /** Smallest explicit ceiling accepted by the projector. */
  minimum_max_estimated_tokens: number;
  /** Ordered degradation policy applied when the ceiling binds. */
  degradation_ladder: readonly PmDiagnosticDegradationStep[];
  /** Paths whose first actionable value must survive degradation. */
  corrective_action_paths: readonly string[];
  /** Stable estimate used by gates and SDK consumers. */
  token_estimate: "ceil(utf8_bytes / 4)";
}

/** Machine-readable disclosure attached to a projected diagnostic. */
export interface PmDiagnosticOutputReceipt {
  /** Diagnostic family whose contract bound the output. */
  diagnostic_class: PmDiagnosticOutputClass;
  /** Rendered transport measured by the projector. */
  format: "json" | "text";
  /** Effective estimated-token ceiling. */
  budget: number;
  /** Whether the caller supplied the ceiling or used the declaration. */
  budget_source: "default" | "explicit";
  /** Estimate before diagnostic degradation. */
  original_estimated_tokens: number;
  /** Exact estimate of the returned projection. */
  estimated_tokens: number;
  /** Whether one or more fields were removed or compacted. */
  truncated: boolean;
  /** Applied stages in contract order. */
  degradation_steps: PmDiagnosticDegradationStep[];
  /** Top-level fields removed from the original diagnostic. */
  omitted_fields: string[];
  /** Additional omitted fields not named individually in a bounded receipt. */
  omitted_fields_overflow_count?: number;
}

/** JSON diagnostic after binding it to a declared output contract. */
export type PmProjectedDiagnostic<TDiagnostic extends object> =
  Partial<TDiagnostic> &
    Pick<TDiagnostic, Extract<keyof TDiagnostic, "code" | "required">> & {
      diagnostic_output?: PmDiagnosticOutputReceipt;
    };

/** Describes one command's default agent-output budget and degradation policy. */
export interface PmCommandOutputBudgetContract {
  /** Canonical or compatibility command name. */
  command: string;
  /** Workload class that selected the default ceiling. */
  budget_class: PmOutputBudgetClass;
  /** Default estimated-token ceiling for representative output. */
  default_max_estimated_tokens: number;
  /** Encoding-specific ceilings generated from the workload-class default. */
  default_max_estimated_tokens_by_format: Readonly<{
    toon: number;
    json: number;
  }>;
  /** Ordered fallback projections, from richest to smallest. */
  degradation_ladder: readonly PmOutputDegradationStep[];
  /** Whether callers may explicitly request an unbounded result. */
  allows_unbounded_opt_out: boolean;
  /** Stable estimate used by gates and SDK consumers. */
  token_estimate: "ceil(utf8_bytes / 4)";
}

const MUTATION_COMMANDS = new Set<string>([
  "append",
  "claim",
  "close",
  "close-many",
  "close-task",
  "comments",
  "config",
  "copy",
  "create",
  "delete",
  "docs",
  "event",
  "files",
  "focus",
  "history-author-acknowledge",
  "history-compact",
  "history-redact",
  "history-repair",
  "init",
  "item",
  "learnings",
  "meet",
  "notes",
  "pause-task",
  "release",
  "remind",
  "restore",
  "schema",
  "start-task",
  "update",
  "update-many",
]);

const DISCOVERY_COMMANDS = new Set<string>([
  "contracts",
  "extension",
  "help",
  "install",
  "package",
  "packages",
  "profile",
  "upgrade",
]);

const GOVERNANCE_COMMANDS = new Set<string>([
  "gc",
  "health",
  "merge",
  "stats",
  "telemetry",
  "test",
  "test-all",
  "validate",
]);

const DEFAULT_MAX_ESTIMATED_TOKENS: Record<PmOutputBudgetClass, number> = {
  mutation: 2_000,
  read: 4_000,
  discovery: 3_000,
  governance: 6_000,
};

const JSON_BUDGET_NUMERATOR = 3;
const JSON_BUDGET_DENOMINATOR = 2;
const MINIMUM_DIAGNOSTIC_BUDGET = 192;

const DIAGNOSTIC_DEFAULT_BUDGETS: Record<
  PmDiagnosticOutputClass,
  Readonly<{ text: number; json: number }>
> = {
  error: { text: 768, json: 2_000 },
  warning: { text: 768, json: 2_000 },
  validation_summary: { text: 1_500, json: 3_000 },
  recovery_bundle: { text: 768, json: 2_000 },
};

/** Public default contract for every diagnostic family. */
export const PM_DIAGNOSTIC_OUTPUT_BUDGET_CONTRACTS =
  PM_DIAGNOSTIC_OUTPUT_CLASSES.map(
    (diagnosticClass): PmDiagnosticOutputBudgetContract => ({
      diagnostic_class: diagnosticClass,
      default_max_estimated_tokens_by_format:
        DIAGNOSTIC_DEFAULT_BUDGETS[diagnosticClass],
      minimum_max_estimated_tokens: MINIMUM_DIAGNOSTIC_BUDGET,
      degradation_ladder: PM_DIAGNOSTIC_DEGRADATION_STEPS,
      corrective_action_paths: [
        "required",
        "recovery.suggested_retry",
        "recovery.suggested_retry_args",
        "recovery.next_best_command",
        "next_steps[0]",
      ],
      token_estimate: "ceil(utf8_bytes / 4)",
    }),
  );

const DIAGNOSTIC_BUDGET_BY_CLASS = new Map(
  PM_DIAGNOSTIC_OUTPUT_BUDGET_CONTRACTS.map(
    (contract) => [contract.diagnostic_class, contract] as const,
  ),
);

/** Infer the conservative workload class for a core or package command. */
export function inferPmOutputBudgetClass(command: string): PmOutputBudgetClass {
  const [rootCommand = ""] = command.trim().split(/\s+/u);
  return MUTATION_COMMANDS.has(rootCommand)
    ? "mutation"
    : DISCOVERY_COMMANDS.has(rootCommand)
      ? "discovery"
      : GOVERNANCE_COMMANDS.has(rootCommand)
        ? "governance"
        : "read";
}

/** Build the generated default budget for a core or package command. */
export function createPmCommandOutputBudget(
  command: string,
  budgetClass: PmOutputBudgetClass = inferPmOutputBudgetClass(command),
): PmCommandOutputBudgetContract {
  const normalizedCommand = command.trim().replace(/\s+/gu, " ");
  if (normalizedCommand.length === 0) {
    throw new TypeError("command must be a non-empty command path");
  }
  const toonBudget = DEFAULT_MAX_ESTIMATED_TOKENS[budgetClass];
  return definePmCommandOutputBudget({
    command: normalizedCommand,
    budget_class: budgetClass,
    default_max_estimated_tokens: toonBudget,
    default_max_estimated_tokens_by_format: {
      toon: toonBudget,
      json: Math.ceil(
        (toonBudget * JSON_BUDGET_NUMERATOR) / JSON_BUDGET_DENOMINATOR,
      ),
    },
    degradation_ladder: PM_OUTPUT_DEGRADATION_STEPS,
    allows_unbounded_opt_out: true,
    token_estimate: "ceil(utf8_bytes / 4)",
  });
}

/**
 * Declares one budget contract while preserving literal command metadata for
 * package-authored registries and test fixtures. Rejects ceilings that cannot
 * represent a positive, deterministic token allowance.
 */
export function definePmCommandOutputBudget<
  TContract extends PmCommandOutputBudgetContract,
>(contract: TContract): TContract {
  if (
    !Number.isSafeInteger(contract.default_max_estimated_tokens) ||
    contract.default_max_estimated_tokens <= 0
  ) {
    throw new RangeError(
      "default_max_estimated_tokens must be a positive safe integer",
    );
  }
  for (const [format, ceiling] of Object.entries(
    contract.default_max_estimated_tokens_by_format,
  )) {
    if (!Number.isSafeInteger(ceiling) || ceiling <= 0) {
      throw new RangeError(
        `default_max_estimated_tokens_by_format.${format} must be a positive safe integer`,
      );
    }
  }
  return contract;
}

/** Public default budget contract for every built-in pm command. */
export const PM_COMMAND_OUTPUT_BUDGET_CONTRACTS = PM_CORE_COMMAND_NAMES.map(
  (command) => createPmCommandOutputBudget(command),
);

const OUTPUT_BUDGET_BY_COMMAND = new Map(
  PM_COMMAND_OUTPUT_BUDGET_CONTRACTS.map(
    (contract) => [contract.command, contract] as const,
  ),
);

/** Resolve the declared output budget for one built-in command. */
export function resolvePmCommandOutputBudget(
  command: string,
  options: { generateFallback: true },
): PmCommandOutputBudgetContract;
/** Resolve a declared output budget without generating a package fallback. */
export function resolvePmCommandOutputBudget(
  command: string,
  options?: { generateFallback?: false },
): PmCommandOutputBudgetContract | null;
/** Implement built-in lookup with an opt-in generated package fallback. */
export function resolvePmCommandOutputBudget(
  command: string,
  options: { generateFallback?: boolean } = {},
): PmCommandOutputBudgetContract | null {
  const normalizedCommand = command.trim().replace(/\s+/gu, " ");
  const [rootCommand] = normalizedCommand.split(" ");
  const declared = OUTPUT_BUDGET_BY_COMMAND.get(
    rootCommand as (typeof PM_CORE_COMMAND_NAMES)[number],
  );
  if (declared) return { ...declared, command: normalizedCommand };
  return options.generateFallback
    ? createPmCommandOutputBudget(normalizedCommand)
    : null;
}

/** Estimate conservative token usage from UTF-8 output bytes. */
export function estimatePmOutputTokens(utf8Bytes: number): number {
  return Math.ceil(Math.max(0, utf8Bytes) / 4);
}

/** Resolve the binding output contract for one diagnostic family. */
export function resolvePmDiagnosticOutputBudget(
  diagnosticClass: PmDiagnosticOutputClass,
): PmDiagnosticOutputBudgetContract {
  const contract = DIAGNOSTIC_BUDGET_BY_CLASS.get(diagnosticClass);
  if (contract === undefined) {
    throw new TypeError(
      `diagnosticClass must be one of: ${PM_DIAGNOSTIC_OUTPUT_CLASSES.join(", ")}`,
    );
  }
  return contract;
}

function estimateJsonDiagnosticTokens(value: Record<string, unknown>): number {
  return estimatePmOutputTokens(
    Buffer.byteLength(JSON.stringify(value, null, 2), "utf8"),
  );
}

function isDiagnosticRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactDiagnosticRecovery(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isDiagnosticRecord(value)) return undefined;
  const compact: Record<string, unknown> = {};
  for (const key of [
    "suggested_retry",
    "suggested_retry_args",
    "next_best_command",
    "allowed_values",
    "candidate_commands",
    "missing",
    "missing_required_fields",
    "option_scope",
    "retry_after_ms",
  ]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) compact[key] = candidate.slice(0, 3);
    else if (candidate !== undefined) compact[key] = candidate;
  }
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function truncateDiagnosticString(value: unknown, maximum: number): unknown {
  if (typeof value !== "string" || value.length <= maximum) return value;
  return `${value.slice(0, Math.max(1, maximum - 3))}...`;
}

function truncateDiagnosticUtf8Text(
  value: string,
  maximumBytes: number,
): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const suffix = "...";
  const codePoints = Array.from(value);
  let lower = 0;
  let upper = codePoints.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const candidate = `${codePoints.slice(0, middle).join("")}${suffix}`;
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) lower = middle;
    else upper = middle - 1;
  }
  return `${codePoints.slice(0, lower).join("")}${suffix}`;
}

function prioritizeDiagnosticFields(
  diagnostic: Record<string, unknown>,
): Record<string, unknown> {
  const prioritized: Record<string, unknown> = {};
  for (const key of [
    "code",
    "required",
    "recovery",
    "next_steps",
    "exit_code",
    "type",
    "title",
    "detail",
    "why",
    "examples",
  ]) {
    if (Object.hasOwn(diagnostic, key) && diagnostic[key] !== undefined) {
      prioritized[key] = diagnostic[key];
    }
  }
  for (const [key, value] of Object.entries(diagnostic)) {
    if (key !== "__proto__" && !Object.hasOwn(prioritized, key)) {
      prioritized[key] = value;
    }
  }
  return prioritized;
}

const DIAGNOSTIC_COLLECTION_LIMIT_STAGES = new Set<PmDiagnosticDegradationStep>(
  ["limit_collections", "compact_recovery", "action_only"],
);
const DIAGNOSTIC_RECOVERY_COMPACTION_STAGES =
  new Set<PmDiagnosticDegradationStep>(["compact_recovery", "action_only"]);

function actionOnlyDiagnostic(
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const actionOnly: Record<string, unknown> = {
    code: typeof candidate.code === "string" ? candidate.code : "diagnostic",
    required:
      truncateDiagnosticString(candidate.required, 160) ??
      "Inspect the diagnostic code and retry with corrected input.",
  };
  const recovery = compactDiagnosticRecovery(candidate.recovery);
  if (recovery !== undefined) {
    actionOnly.recovery = recovery;
  } else if (Array.isArray(candidate.next_steps)) {
    actionOnly.next_steps = candidate.next_steps.slice(0, 1);
  }
  if (candidate.exit_code !== undefined)
    actionOnly.exit_code = candidate.exit_code;
  if (candidate.type !== undefined) actionOnly.type = candidate.type;
  return actionOnly;
}

function diagnosticCandidate(
  diagnostic: Record<string, unknown>,
  stage: PmDiagnosticDegradationStep,
): Record<string, unknown> {
  const candidate = structuredClone(diagnostic);
  if (stage !== "full") {
    delete candidate.why;
    delete candidate.examples;
  }
  if (DIAGNOSTIC_COLLECTION_LIMIT_STAGES.has(stage)) {
    for (const [key, value] of Object.entries(candidate)) {
      if (Array.isArray(value)) candidate[key] = value.slice(0, 3);
    }
  }
  if (DIAGNOSTIC_RECOVERY_COMPACTION_STAGES.has(stage)) {
    const recovery = compactDiagnosticRecovery(candidate.recovery);
    if (recovery) candidate.recovery = recovery;
    else delete candidate.recovery;
  }
  if (stage !== "action_only") return prioritizeDiagnosticFields(candidate);
  return actionOnlyDiagnostic(candidate);
}

function attachDiagnosticReceipt(
  candidate: Record<string, unknown>,
  receipt: Omit<PmDiagnosticOutputReceipt, "estimated_tokens">,
): Record<string, unknown> {
  const projected = {
    ...candidate,
    diagnostic_output: { ...receipt, estimated_tokens: 0 },
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const estimatedTokens = estimateJsonDiagnosticTokens(projected);
    const outputReceipt =
      projected.diagnostic_output as PmDiagnosticOutputReceipt;
    if (outputReceipt.estimated_tokens === estimatedTokens) break;
    outputReceipt.estimated_tokens = estimatedTokens;
  }
  return projected;
}

function shrinkMinimalDiagnosticCandidate(
  candidate: Record<string, unknown>,
  receipt: Omit<PmDiagnosticOutputReceipt, "estimated_tokens">,
  budget: number,
): Record<string, unknown> {
  let fallback = attachDiagnosticReceipt(candidate, receipt);
  for (const optionalField of ["recovery", "exit_code"]) {
    if (
      estimateJsonDiagnosticTokens(fallback) <= budget ||
      candidate[optionalField] === undefined
    ) {
      continue;
    }
    delete candidate[optionalField];
    fallback = attachDiagnosticReceipt(candidate, receipt);
  }
  let maximumActionBytes = 40;
  while (
    estimateJsonDiagnosticTokens(fallback) > budget &&
    maximumActionBytes > 4
  ) {
    maximumActionBytes -= 4;
    candidate.code = truncateDiagnosticUtf8Text(
      String(candidate.code),
      maximumActionBytes,
    );
    candidate.required = truncateDiagnosticUtf8Text(
      String(candidate.required),
      maximumActionBytes,
    );
    fallback = attachDiagnosticReceipt(candidate, receipt);
  }
  return fallback;
}

function createMinimalDiagnosticFallback(
  projected: Record<string, unknown>,
  budget: number,
): Record<string, unknown> {
  const receipt = projected.diagnostic_output as PmDiagnosticOutputReceipt;
  const { estimated_tokens: _estimatedTokens, ...receiptWithoutEstimate } =
    receipt;
  const boundedOmittedFields = receiptWithoutEstimate.omitted_fields
    .slice(0, 8)
    .map((field) => truncateDiagnosticUtf8Text(field, 32));
  const boundedReceipt = {
    ...receiptWithoutEstimate,
    omitted_fields: boundedOmittedFields,
    ...(receiptWithoutEstimate.omitted_fields.length >
    boundedOmittedFields.length
      ? {
          omitted_fields_overflow_count:
            receiptWithoutEstimate.omitted_fields.length -
            boundedOmittedFields.length,
        }
      : {}),
  };
  const recoveryCandidate = compactDiagnosticRecovery(projected.recovery);
  const recovery =
    recoveryCandidate && estimateJsonDiagnosticTokens(recoveryCandidate) <= 48
      ? recoveryCandidate
      : undefined;
  const candidate: Record<string, unknown> = {
    code: truncateDiagnosticUtf8Text(
      String(projected.code),
      320,
    ),
    required: truncateDiagnosticUtf8Text(
      String(projected.required),
      320,
    ),
    ...(recovery ? { recovery } : {}),
    ...(projected.exit_code !== undefined
      ? { exit_code: projected.exit_code }
      : {}),
  };
  let fallback = attachDiagnosticReceipt(candidate, boundedReceipt);
  while (
    estimateJsonDiagnosticTokens(fallback) > budget &&
    boundedReceipt.omitted_fields.length > 0
  ) {
    boundedReceipt.omitted_fields.pop();
    boundedReceipt.omitted_fields_overflow_count =
      receiptWithoutEstimate.omitted_fields.length -
      boundedReceipt.omitted_fields.length;
    fallback = attachDiagnosticReceipt(candidate, boundedReceipt);
  }
  fallback = shrinkMinimalDiagnosticCandidate(
    candidate,
    boundedReceipt,
    budget,
  );
  return fallback;
}

/**
 * Bind a JSON diagnostic to its declared ceiling while preserving the first
 * corrective action and reporting every top-level omission.
 */
export function projectPmDiagnosticOutput<TDiagnostic extends object>(
  diagnostic: TDiagnostic,
  options: {
    diagnosticClass?: PmDiagnosticOutputClass;
    maxEstimatedTokens?: number;
  } = {},
): PmProjectedDiagnostic<TDiagnostic> {
  const diagnosticRecord = diagnostic as Record<string, unknown>;
  const diagnosticClass = options.diagnosticClass ?? "error";
  const contract = resolvePmDiagnosticOutputBudget(diagnosticClass);
  const explicitBudget = options.maxEstimatedTokens;
  if (
    explicitBudget !== undefined &&
    (!Number.isSafeInteger(explicitBudget) ||
      explicitBudget < contract.minimum_max_estimated_tokens)
  ) {
    throw new RangeError(
      `maxEstimatedTokens must be a safe integer >= ${contract.minimum_max_estimated_tokens}`,
    );
  }
  const budget =
    explicitBudget ?? contract.default_max_estimated_tokens_by_format.json;
  const originalEstimatedTokens =
    estimateJsonDiagnosticTokens(diagnosticRecord);
  const originalFields = Object.keys(diagnosticRecord);
  if (originalEstimatedTokens <= budget) {
    return prioritizeDiagnosticFields(
      structuredClone(diagnosticRecord),
    ) as PmProjectedDiagnostic<TDiagnostic>;
  }
  let projected: Record<string, unknown> | undefined;
  for (const [index, stage] of contract.degradation_ladder.entries()) {
    const candidate = diagnosticCandidate(diagnosticRecord, stage);
    const omittedFields = originalFields.filter(
      (field) => !Object.hasOwn(candidate, field),
    );
    const withReceipt = attachDiagnosticReceipt(candidate, {
      diagnostic_class: diagnosticClass,
      format: "json",
      budget,
      budget_source: explicitBudget === undefined ? "default" : "explicit",
      original_estimated_tokens: originalEstimatedTokens,
      truncated: index > 0,
      degradation_steps: contract.degradation_ladder.slice(0, index + 1),
      omitted_fields: omittedFields,
    });
    projected = withReceipt;
    if (estimateJsonDiagnosticTokens(withReceipt) <= budget) break;
  }
  if (estimateJsonDiagnosticTokens(projected!) > budget) {
    projected = createMinimalDiagnosticFallback(projected!, budget);
  }
  return projected as PmProjectedDiagnostic<TDiagnostic>;
}

/** Text diagnostic together with the same measured receipt used by JSON. */
export interface PmProjectedTextDiagnostic {
  /** Rendered action-first diagnostic. */
  output: string;
  /** Binding diagnostic budget receipt. */
  diagnostic_output: PmDiagnosticOutputReceipt;
}

/** Bind human-readable diagnostics without ever truncating the corrective action away. */
export function projectPmDiagnosticText(
  output: string,
  correctiveAction: string,
  options: {
    diagnosticClass?: PmDiagnosticOutputClass;
    maxEstimatedTokens?: number;
  } = {},
): PmProjectedTextDiagnostic {
  const diagnosticClass = options.diagnosticClass ?? "error";
  const contract = resolvePmDiagnosticOutputBudget(diagnosticClass);
  const explicitBudget = options.maxEstimatedTokens;
  if (
    explicitBudget !== undefined &&
    (!Number.isSafeInteger(explicitBudget) ||
      explicitBudget < contract.minimum_max_estimated_tokens)
  ) {
    throw new RangeError(
      `maxEstimatedTokens must be a safe integer >= ${contract.minimum_max_estimated_tokens}`,
    );
  }
  const budget =
    explicitBudget ?? contract.default_max_estimated_tokens_by_format.text;
  const originalEstimatedTokens = estimatePmOutputTokens(
    Buffer.byteLength(output, "utf8"),
  );
  const truncated = originalEstimatedTokens > budget;
  const actionPrefix = "What is required:\n  ";
  const actionSuffix = `\n\nDiagnostic output exceeded its declared ${budget}-token ceiling; rerun with structured JSON for the bounded recovery envelope.`;
  const correctiveActionText =
    correctiveAction.trim() ||
    "Inspect the diagnostic code and retry with corrected input.";
  const availableActionBytes = Math.max(
    1,
    budget * 4 - Buffer.byteLength(`${actionPrefix}${actionSuffix}`, "utf8"),
  );
  const projectedOutput = truncated
    ? `${actionPrefix}${truncateDiagnosticUtf8Text(
        correctiveActionText,
        availableActionBytes,
      )}${actionSuffix}`
    : output;
  return {
    output: projectedOutput,
    diagnostic_output: {
      diagnostic_class: diagnosticClass,
      format: "text",
      budget,
      budget_source: explicitBudget === undefined ? "default" : "explicit",
      original_estimated_tokens: originalEstimatedTokens,
      estimated_tokens: estimatePmOutputTokens(
        Buffer.byteLength(projectedOutput, "utf8"),
      ),
      truncated,
      degradation_steps: truncated
        ? [...contract.degradation_ladder]
        : ["full"],
      omitted_fields: truncated ? ["explanation", "collections"] : [],
    },
  };
}
