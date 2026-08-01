/**
 * @module sdk/output-token-accounting
 *
 * Provides transport-neutral, opt-in attribution for the bytes emitted by a pm
 * command. The receipt deliberately excludes itself from the accounted total,
 * while reporting its own independently measured overhead.
 */
import { estimatePmOutputTokens } from "./cli-contracts/agent-output-contracts.js";

/** Stable output sections used by CLI, MCP, replay gates, and package hosts. */
export type PmOutputTokenSection =
  | "result_rows"
  | "envelope"
  | "diagnostics"
  | "hints";

/** Byte and token estimate attributed to one output section. */
export interface PmOutputTokenSectionAccounting {
  /** Exact share of emitted pre-receipt bytes allocated to this section. */
  bytes: number;
  /** Token estimate derived with pm's canonical UTF-8 byte estimator. */
  estimated_tokens: number;
}

/** Bounded accounting receipt attached only when explicitly requested. */
export interface PmOutputTokenAccounting {
  /** Receipt schema version. */
  version: 1;
  /** Scope measured by this receipt. */
  measurement_scope: "output_before_token_accounting";
  /** Canonical estimator shared with declared output budgets. */
  estimator: "ceil(utf8_bytes / 4)";
  /** Exact UTF-8 byte count of the emitted output before this receipt. */
  total_bytes: number;
  /** Canonical token estimate for {@link total_bytes}. */
  total_estimated_tokens: number;
  /** Deterministic attribution whose byte values sum exactly to total_bytes. */
  sections: Record<PmOutputTokenSection, PmOutputTokenSectionAccounting>;
  /** Exact UTF-8 bytes added by the accounting receipt itself. */
  accounting_receipt_bytes: number;
  /** Token estimate for the excluded receipt overhead. */
  accounting_receipt_estimated_tokens: number;
  /** Fields intentionally excluded from the accounted total. */
  excluded_fields: readonly ["token_accounting"];
  /** Describes how structural transport bytes are assigned to sections. */
  section_allocation: "proportional_canonical_json";
}

/** Result enriched by opt-in token accounting without weakening its input type. */
export type PmTokenAccountedResult<Result> =
  Result extends Record<string, unknown>
    ? Result & { token_accounting: PmOutputTokenAccounting }
    : { result: Result; token_accounting: PmOutputTokenAccounting };

const SECTION_ORDER: readonly PmOutputTokenSection[] = [
  "result_rows",
  "envelope",
  "diagnostics",
  "hints",
];
const ROW_KEYS =
  /^(?:items|results|rows|ready|blocked|recommended|decision_needed|children|dependencies|events|matches|commands|tools)$/u;
const DIAGNOSTIC_KEYS =
  /^(?:diagnostics|errors?|warnings?|findings|violations|failures?)$/u;
const HINT_KEYS =
  /^(?:hints?|suggestions?|next_steps?|recovery|remediation|examples?)$/u;
const MAX_RECEIPT_STABILIZATION_PASSES = 8;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function canonicalJsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value) ?? "null");
}

function sectionForEntry(key: string, value: unknown): PmOutputTokenSection {
  if (DIAGNOSTIC_KEYS.test(key)) return "diagnostics";
  if (HINT_KEYS.test(key)) return "hints";
  if (ROW_KEYS.test(key) || Array.isArray(value)) return "result_rows";
  return "envelope";
}

function collectSectionWeights(
  result: unknown,
): Record<PmOutputTokenSection, number> {
  const weights: Record<PmOutputTokenSection, number> = {
    result_rows: 0,
    envelope: 0,
    diagnostics: 0,
    hints: 0,
  };
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    weights[Array.isArray(result) ? "result_rows" : "envelope"] =
      canonicalJsonBytes(result);
    return weights;
  }
  for (const [key, value] of Object.entries(result)) {
    weights[sectionForEntry(key, value)] += canonicalJsonBytes({
      [key]: value,
    });
  }
  if (Object.values(weights).every((weight) => weight === 0)) {
    weights.envelope = 1;
  }
  return weights;
}

function allocateExactBytes(
  totalBytes: number,
  weights: Record<PmOutputTokenSection, number>,
): Record<PmOutputTokenSection, number> {
  const weightTotal = SECTION_ORDER.reduce(
    (total, section) => total + weights[section],
    0,
  );
  const exact = SECTION_ORDER.map((section) => ({
    section,
    value: (totalBytes * weights[section]) / weightTotal,
  }));
  const allocated: Record<PmOutputTokenSection, number> = {
    result_rows: 0,
    envelope: 0,
    diagnostics: 0,
    hints: 0,
  };
  for (const entry of exact) allocated[entry.section] = Math.floor(entry.value);
  let remainder =
    totalBytes -
    SECTION_ORDER.reduce((total, section) => total + allocated[section], 0);
  for (const entry of [...exact].sort(
    (left, right) =>
      right.value -
        Math.floor(right.value) -
        (left.value - Math.floor(left.value)) ||
      SECTION_ORDER.indexOf(left.section) -
        SECTION_ORDER.indexOf(right.section),
  )) {
    if (remainder === 0) break;
    allocated[entry.section] += 1;
    remainder -= 1;
  }
  return allocated;
}

function attachReceipt<Result>(
  result: Result,
  receipt: PmOutputTokenAccounting,
): PmTokenAccountedResult<Result> {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    return {
      ...(result as Record<string, unknown>),
      token_accounting: receipt,
    } as PmTokenAccountedResult<Result>;
  }
  return {
    result,
    token_accounting: receipt,
  } as PmTokenAccountedResult<Result>;
}

/**
 * Attach a deterministic receipt for exactly the bytes produced by
 * {@link render} before accounting. The renderer is supplied by the transport,
 * so CLI TOON/JSON, MCP JSON, and package-defined hosts all measure their real
 * representation rather than a guessed intermediate shape.
 */
export function attachOutputTokenAccounting<Result>(
  result: Result,
  render: (value: unknown) => string,
): PmTokenAccountedResult<Result> {
  const originalBytes = utf8Bytes(render(result));
  const allocatedBytes = allocateExactBytes(
    originalBytes,
    collectSectionWeights(result),
  );
  const sections = Object.fromEntries(
    SECTION_ORDER.map((section) => [
      section,
      {
        bytes: allocatedBytes[section],
        estimated_tokens: estimatePmOutputTokens(allocatedBytes[section]),
      },
    ]),
  ) as Record<PmOutputTokenSection, PmOutputTokenSectionAccounting>;
  let receipt: PmOutputTokenAccounting = {
    version: 1,
    measurement_scope: "output_before_token_accounting",
    estimator: "ceil(utf8_bytes / 4)",
    total_bytes: originalBytes,
    total_estimated_tokens: estimatePmOutputTokens(originalBytes),
    sections,
    accounting_receipt_bytes: 0,
    accounting_receipt_estimated_tokens: 0,
    excluded_fields: ["token_accounting"],
    section_allocation: "proportional_canonical_json",
  };
  let accounted = attachReceipt(result, receipt);
  for (let pass = 0; pass < MAX_RECEIPT_STABILIZATION_PASSES; pass += 1) {
    const measuredReceiptBytes = utf8Bytes(render(accounted)) - originalBytes;
    if (measuredReceiptBytes === receipt.accounting_receipt_bytes)
      return accounted;
    receipt = {
      ...receipt,
      accounting_receipt_bytes: measuredReceiptBytes,
      accounting_receipt_estimated_tokens:
        estimatePmOutputTokens(measuredReceiptBytes),
    };
    accounted = attachReceipt(result, receipt);
  }
  return accounted;
}
