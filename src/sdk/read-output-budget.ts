/**
 * @module sdk/read-output-budget
 *
 * Implements deterministic, bounded result compaction for the universal
 * read-output contract without expanding its public declaration module.
 */
import { formatBuiltInOutput } from "../core/output/output.js";
import type { PmReadOutputReceipt } from "./read-output-contracts.js";
import {
  countReadOutputRows,
  readOutputBudgetCollections,
} from "./read-output-rows.js";

interface StringCompactionState {
  /** Whether at least one string was shortened. */
  compacted: boolean;
}

const MAX_ESTIMATE_ITERATIONS = 8;
const MAX_COMPACTION_ITERATIONS = 64;
const RECOVERY_MARGIN_NUMERATOR = 5;
const RECOVERY_MARGIN_DENOMINATOR = 4;
const RECOVERY_ROUNDING_TOKENS = 100;

/** Project a standard item read to brief depth, preserving metadata and disclosing every removed section. */
export function projectReadOutputItemToBrief(
  command: string,
  options: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    command !== "get" ||
    !isRecord(result.item) ||
    [
      "fields",
      "outputInclude",
      "output_include",
      "outputCursor",
      "output_cursor",
    ].some((key) => options[key] !== undefined) ||
    options.full === true ||
    options.tree === true ||
    (options.depth !== undefined && options.depth !== "standard")
  )
    return undefined;
  const item = result.item;
  const sections = ["linked", "claim_state", "schedule"];
  const omitted = sections.filter((key) => Object.hasOwn(result, key));
  const projected = Object.fromEntries(
    Object.entries(result).filter(([key]) => !sections.includes(key)),
  );
  projected.item = Object.fromEntries(
    Object.entries(item).filter(([key]) => key !== "body"),
  );
  if (Object.hasOwn(item, "body")) omitted.push("body");
  const previous =
    isRecord(result.omission_receipt) &&
    Array.isArray(result.omission_receipt.omitted_field_groups)
      ? result.omission_receipt.omitted_field_groups
      : [];
  const groups = [
    ...previous,
    ...omitted.map((name) => ({
      name,
      restore_with: `--fields ${name}`,
    })),
  ];
  projected.omission_receipt = {
    has_omissions: groups.length > 0,
    omitted_field_group_count: groups.length,
    omitted_field_groups: groups,
  };
  return projected;
}

/** Input to the deterministic finite-retry recommendation contract. */
export interface PmReadOutputRecoveryBudgetInput {
  /** Ceiling that already bound and truncated the response. */
  effective_budget_tokens: number;
  /** Measured cost of the useful result before row compaction. */
  measured_result_tokens: number;
}

/** Executable next-budget recommendation shared by CLI, SDK, and MCP. */
export interface PmReadOutputRecoveryBudget {
  /** Rounded finite retry ceiling, or the only truthful safe fallback. */
  output_budget: number | "unbounded";
  /** Ratio to the binding request, absent when finite arithmetic is unsafe. */
  recovery_budget_multiplier: number | null;
  /** Stable algorithm revision for consumers and fixtures. */
  rule_version: "v1";
}

/**
 * Recommend a retry that is strictly larger than both the binding request and
 * the pre-compaction result, with a 25% envelope margin rounded to 100 tokens.
 */
export function resolveReadOutputRecoveryBudget(
  input: PmReadOutputRecoveryBudgetInput,
): PmReadOutputRecoveryBudget {
  const binding = Math.trunc(input.effective_budget_tokens);
  const measured = Math.trunc(input.measured_result_tokens);
  if (
    !Number.isSafeInteger(binding) ||
    binding <= 0 ||
    !Number.isSafeInteger(measured) ||
    measured <= 0
  ) {
    return {
      output_budget: "unbounded",
      recovery_budget_multiplier: null,
      rule_version: "v1",
    };
  }
  const baseline = Math.max(binding + 1, measured);
  const withMargin = Math.ceil(
    (baseline * RECOVERY_MARGIN_NUMERATOR) / RECOVERY_MARGIN_DENOMINATOR,
  );
  const rounded =
    Math.ceil(withMargin / RECOVERY_ROUNDING_TOKENS) * RECOVERY_ROUNDING_TOKENS;
  if (!Number.isSafeInteger(rounded)) {
    return {
      output_budget: "unbounded",
      recovery_budget_multiplier: null,
      rule_version: "v1",
    };
  }
  return {
    output_budget: rounded,
    recovery_budget_multiplier: rounded / binding,
    rule_version: "v1",
  };
}

/** Preserve an internal row declaration across clones without charging it as emitted metadata. */
export function preserveReadOutputRowContract(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  suppress = false,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(source, "row_contract");
  if (descriptor && (suppress || descriptor.enumerable === false)) {
    Object.defineProperty(target, "row_contract", { ...descriptor, enumerable: false });
  }
}

/** Estimate UTF-8 token cost using the selected JSON/TOON renderer, or compact JSON for structured SDK calls without a renderer. */
export function estimateReadOutputTokens(
  result: unknown,
  format?: "json" | "toon",
): number {
  const rendered =
    format === undefined
      ? JSON.stringify(result)
      : formatBuiltInOutput(result, format);
  return Math.ceil(Buffer.byteLength(rendered, "utf8") / 4);
}

/** Return whether a value is a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Recursively shorten explanatory strings and record whether content changed. */
function compactStrings(value: unknown, state: StringCompactionState): unknown {
  if (typeof value === "string") {
    if (value.length <= 240) return value;
    state.compacted = true;
    return `${value.slice(0, 240)}…`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => compactStrings(entry, state));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      compactStrings(entry, state),
    ]),
  );
}

/** Update a receipt to the fixed-point estimate of the result containing it. */
export function updateReadOutputReceiptEstimate(
  result: Record<string, unknown>,
  receipt: PmReadOutputReceipt,
  format?: "json" | "toon",
): void {
  let estimate = receipt.estimated_tokens;
  for (let iteration = 0; iteration < MAX_ESTIMATE_ITERATIONS; iteration += 1) {
    receipt.estimated_tokens = estimate;
    const measured = estimateReadOutputTokens(result, format);
    if (measured === estimate) return;
    estimate = measured;
  }
  receipt.estimated_tokens = estimate;
}

/** Select the largest reducible declared row collection, breaking ties by path. */
function selectCompactionCollection(
  result: Record<string, unknown>,
  minimumRowsByPath: ReadonlyMap<string, number>,
): ReturnType<typeof readOutputBudgetCollections>[number] | undefined {
  return readOutputBudgetCollections(result)
    .filter((collection) => {
      const length = Array.isArray(collection.value)
        ? collection.value.length
        : Object.keys(collection.value).length;
      return (
        length > Math.max(1, minimumRowsByPath.get(collection.path) ?? 0)
      );
    })
    .map((collection) => ({
      collection,
      length: Array.isArray(collection.value)
        ? collection.value.length
        : Object.keys(collection.value).length,
    }))
    .sort(
      (left, right) =>
        right.length - left.length ||
        left.collection.path.localeCompare(right.collection.path),
    )[0]?.collection;
}

/** Reduce the largest row collection until the budget fits or no rows can move. */
function compactRowsToBudget(
  result: Record<string, unknown>,
  receipt: PmReadOutputReceipt,
  budget: number,
  minimumRowsByPath: ReadonlyMap<string, number>,
  format?: "json" | "toon",
  finalize?: (result: Record<string, unknown>) => void,
): void {
  for (
    let iteration = 0;
    iteration < MAX_COMPACTION_ITERATIONS;
    iteration += 1
  ) {
    finalize?.(result);
    updateReadOutputReceiptEstimate(result, receipt, format);
    if (receipt.estimated_tokens <= budget) return;
    const candidate = selectCompactionCollection(result, minimumRowsByPath);
    if (!candidate) return;
    const minimumRows = Math.max(1, minimumRowsByPath.get(candidate.path) ?? 0);
    const values = Array.isArray(candidate.value)
      ? [...candidate.value]
      : Object.entries(candidate.value);
    const retainPrefix = (length: number): void => {
      if (Array.isArray(candidate.value)) {
        candidate.value.length = length;
        for (let index = 0; index < length; index += 1) candidate.value[index] = values[index];
      } else {
        for (const key of Object.keys(candidate.value)) delete candidate.value[key];
        Object.defineProperties(candidate.value, Object.getOwnPropertyDescriptors(
          Object.fromEntries(values.slice(0, length) as [string, unknown][]),
        ));
      }
      if (typeof result.count === "number") result.count = countReadOutputRows(result);
      if (candidate.path === "items") result.applied_limit = length;
      finalize?.(result);
      updateReadOutputReceiptEstimate(result, receipt, format);
    };
    receipt.rows_compacted = true;
    receipt.compacted_row_paths = [
      ...new Set([...(receipt.compacted_row_paths ?? []), candidate.path]),
    ].sort((left, right) => left.localeCompare(right));
    result.has_more = true;
    result.truncated = true;
    // Measure the complete envelope at each candidate, including rebased
    // cursors and session charges. Halving without backtracking wastes rows.
    let low = minimumRows;
    let high = values.length - 1;
    let retained = minimumRows;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      retainPrefix(middle);
      if (receipt.estimated_tokens <= budget) {
        retained = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    retainPrefix(retained);
  }
}

/** Compact strings and rows in place, then return the final exact estimate. */
export function compactReadOutputToBudget(
  result: Record<string, unknown>,
  receipt: PmReadOutputReceipt,
  budget: number,
  minimumRowsByPath: ReadonlyMap<string, number> = new Map(),
  format?: "json" | "toon",
  finalize?: (result: Record<string, unknown>) => void,
): Record<string, unknown> {
  const stringCompactionState: StringCompactionState = { compacted: false };
  const compacted = compactStrings(result, stringCompactionState) as Record<
    string,
    unknown
  >;
  preserveReadOutputRowContract(result, compacted);
  receipt.strings_compacted = stringCompactionState.compacted;
  compacted.read_output = receipt;
  compactRowsToBudget(compacted, receipt, budget, minimumRowsByPath, format, finalize);
  updateReadOutputReceiptEstimate(compacted, receipt, format);
  return compacted;
}
