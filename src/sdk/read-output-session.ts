/**
 * @module sdk/read-output-session
 *
 * Implements a stateless, caller-carried session ledger for cross-call output
 * budgets and resolvable references to item facts served by earlier reads.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import {
  mapReadOutputRows,
  readOutputRowCollections,
} from "./read-output-rows.js";

/** Versioned state supplied to a sequence of related read invocations. */
export interface PmReadOutputSessionState {
  /** Session-state schema version. */
  version: 1;
  /** Caller-selected request-group identity. */
  id: string;
  /** Binding token ceiling shared by every invocation in the group. */
  token_budget: number;
  /** Tokens already spent by earlier invocations. */
  spent_tokens: number;
  /** Item facts already serialized in full during this session. */
  seen_item_ids: string[];
}

/** Lightweight row emitted instead of repeating a previously served item. */
export interface PmReadOutputSessionReference {
  /** Stable item identity retained for joins and follow-up reads. */
  id: string;
  /** Resolvable reference to the session fact already in caller context. */
  context_ref: string;
}

/** Receipt proving cross-call suppression and budget accounting. */
export interface PmReadOutputSessionReceipt {
  /** Session-receipt schema version. */
  contract_version: 1;
  /** Caller-selected request-group identity. */
  id: string;
  /** Accounting scope, including this receipt and the read-output receipt. */
  measurement_scope: "complete_read_envelope";
  /** Canonical estimator shared with per-call output budgets. */
  estimator: "ceil(utf8_bytes / 4)";
  /** Group ceiling supplied in the session state. */
  token_budget: number;
  /** Spend carried into this invocation. */
  spent_before_tokens: number;
  /** Exact fixed-point estimate emitted by this invocation. */
  spent_this_call_tokens: number;
  /** Portion of this invocation charged before the ceiling was exhausted. */
  charged_this_call_tokens: number;
  /** Accumulated spend after this invocation. */
  spent_total_tokens: number;
  /** Unspent group capacity after this invocation. */
  remaining_tokens: number;
  /** Whether no further useful read envelope fits the group ceiling. */
  exhausted: boolean;
  /** Number of full item facts known before this invocation. */
  seen_before_count: number;
  /** Number of newly delivered item facts retained in this envelope. */
  new_item_count: number;
  /** Number of repeated item rows replaced by references. */
  suppressed_repeat_count: number;
  /** Stable reference syntax used by suppressed rows. */
  reference_format: "session:<session-id>:<item-id>";
  /** Command that restores a referenced item when prior context is unavailable. */
  restore_reference_with: "pm get <item-id> --brief";
  /** Caller-carried state for the next read in the same request group. */
  next_state: PmReadOutputSessionState;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SESSION_KEYS = new Set([
  "version",
  "id",
  "token_budget",
  "spent_tokens",
  "seen_item_ids",
]);
const SESSION_FIELD_VALIDATIONS = [
  {
    valid: (state: Record<string, unknown>) => state.version === 1,
    reason: "version must equal 1.",
  },
  {
    valid: (state: Record<string, unknown>) =>
      typeof state.id === "string" && SESSION_ID_PATTERN.test(state.id),
    reason: "id must be 1-64 portable identifier characters.",
  },
  {
    valid: (state: Record<string, unknown>) =>
      Number.isSafeInteger(state.token_budget) &&
      (state.token_budget as number) >= 256,
    reason: "token_budget must be a safe integer of at least 256.",
  },
  {
    valid: (state: Record<string, unknown>) =>
      Number.isSafeInteger(state.spent_tokens) &&
      (state.spent_tokens as number) >= 0 &&
      (state.spent_tokens as number) <= (state.token_budget as number),
    reason:
      "spent_tokens must be a non-negative safe integer no larger than token_budget.",
  },
  {
    valid: (state: Record<string, unknown>) =>
      Array.isArray(state.seen_item_ids) &&
      state.seen_item_ids.every(
        (id) => typeof id === "string" && ITEM_ID_PATTERN.test(id),
      ),
    reason: "seen_item_ids must contain only portable item identifiers.",
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Throw one stable usage refusal for a malformed caller-carried session. */
function invalidSession(reason: string): never {
  throw new PmCliError(`--output-session ${reason}`, EXIT_CODE.USAGE, {
    code: "invalid_read_output_session",
    field: "outputSession",
  });
}

/** Parse and strictly validate a JSON string or typed session-state object. */
export function parseReadOutputSession(
  value: unknown,
): PmReadOutputSessionState | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      invalidSession("must be a valid JSON object.");
    }
  }
  if (!isRecord(parsed)) invalidSession("must be a JSON object.");
  const unknownKeys = Object.keys(parsed).filter(
    (key) => !SESSION_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    invalidSession(`contains unknown field "${unknownKeys.sort()[0]}".`);
  }
  const invalidField = SESSION_FIELD_VALIDATIONS.find(
    (validation) => !validation.valid(parsed),
  );
  if (invalidField !== undefined) invalidSession(invalidField.reason);
  const seenItemIds = [...new Set(parsed.seen_item_ids as string[])].sort();
  return {
    version: 1,
    id: parsed.id as string,
    token_budget: parsed.token_budget as number,
    spent_tokens: parsed.spent_tokens as number,
    seen_item_ids: seenItemIds,
  };
}

/** Resolve an item identity from built-in list rows and nested search hits. */
function itemIdFromRow(row: unknown): string | undefined {
  if (!isRecord(row)) return undefined;
  if (typeof row.id === "string") return row.id;
  if (typeof row.item_id === "string") return row.item_id;
  return isRecord(row.item) && typeof row.item.id === "string"
    ? row.item.id
    : undefined;
}

/** Summarize delivered item facts and compact references across row paths. */
function summarizeReadOutputSessionRows(result: Record<string, unknown>): {
  deliveredIds: Set<string>;
  suppressedRepeatCount: number;
} {
  const deliveredIds = new Set<string>();
  let suppressedRepeatCount = 0;
  for (const collection of readOutputRowCollections(result)) {
    const rows = Array.isArray(collection.value)
      ? collection.value
      : Object.values(collection.value);
    for (const row of rows) {
      if (!isRecord(row)) continue;
      if (typeof row.context_ref === "string") {
        suppressedRepeatCount += 1;
        continue;
      }
      const itemId = itemIdFromRow(row);
      if (itemId !== undefined) deliveredIds.add(itemId);
    }
  }
  return { deliveredIds, suppressedRepeatCount };
}

/** Replace previously served item rows with compact, resolvable references. */
export function applyReadOutputSessionReferences(
  result: Record<string, unknown>,
  state: PmReadOutputSessionState,
): Record<string, unknown> {
  const seen = new Set(state.seen_item_ids);
  return mapReadOutputRows(result, (row) => {
    const itemId = itemIdFromRow(row);
    return itemId !== undefined && seen.has(itemId)
      ? {
          id: itemId,
          context_ref: `session:${state.id}:${itemId}`,
        }
      : row;
  });
}

/** Attach a fixed-point session receipt and return the exact charged tokens. */
export function attachReadOutputSessionReceipt(
  result: Record<string, unknown>,
  state: PmReadOutputSessionState,
): Record<string, unknown> {
  const { deliveredIds, suppressedRepeatCount } =
    summarizeReadOutputSessionRows(result);
  const nextSeen = [
    ...new Set([...state.seen_item_ids, ...deliveredIds]),
  ].sort();
  const receipt: PmReadOutputSessionReceipt = {
    contract_version: 1,
    id: state.id,
    measurement_scope: "complete_read_envelope",
    estimator: "ceil(utf8_bytes / 4)",
    token_budget: state.token_budget,
    spent_before_tokens: state.spent_tokens,
    spent_this_call_tokens: 0,
    charged_this_call_tokens: 0,
    spent_total_tokens: state.spent_tokens,
    remaining_tokens: state.token_budget - state.spent_tokens,
    exhausted: false,
    seen_before_count: state.seen_item_ids.length,
    new_item_count: deliveredIds.size,
    suppressed_repeat_count: suppressedRepeatCount,
    reference_format: "session:<session-id>:<item-id>",
    restore_reference_with: "pm get <item-id> --brief",
    next_state: {
      version: 1,
      id: state.id,
      token_budget: state.token_budget,
      spent_tokens: state.spent_tokens,
      seen_item_ids: nextSeen,
    },
  };
  const withReceipt = { ...result, read_session: receipt };
  let estimate = 0;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    receipt.spent_this_call_tokens = estimate;
    receipt.charged_this_call_tokens = Math.min(
      state.token_budget - state.spent_tokens,
      estimate,
    );
    receipt.spent_total_tokens = Math.min(
      state.token_budget,
      state.spent_tokens + receipt.charged_this_call_tokens,
    );
    receipt.remaining_tokens = Math.max(
      0,
      state.token_budget - receipt.spent_total_tokens,
    );
    receipt.exhausted = receipt.remaining_tokens < 256;
    receipt.next_state.spent_tokens = receipt.spent_total_tokens;
    const measured = Math.ceil(
      Buffer.byteLength(JSON.stringify(withReceipt), "utf8") / 4,
    );
    if (measured === estimate) return withReceipt;
    estimate = measured;
  }
  return withReceipt;
}

/** Return the unspent group budget available to the current invocation. */
export function readOutputSessionRemainingTokens(
  state: PmReadOutputSessionState,
): number {
  return Math.max(0, state.token_budget - state.spent_tokens);
}
