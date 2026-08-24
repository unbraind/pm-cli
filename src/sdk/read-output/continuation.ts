/**
 * @module sdk/read-output/continuation
 *
 * Encodes, validates, and applies stable continuations for declared read-output
 * row collections while keeping cursor mechanics separate from dimension
 * resolution and budget policy.
 */
import { createHash } from "node:crypto";

import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { stableStringify } from "../../core/shared/serialization.js";
import type {
  PmReadOutputCursorEnvelope,
  PmReadOutputSurface,
} from "../read-output-contracts.js";
import { resolveReadOutputSurface } from "../read-output-contracts.js";
import {
  readOutputContinuationRowCollections,
  sliceReadOutputRowCollection,
} from "../read-output-rows.js";

const MAX_READ_OUTPUT_CURSOR_LENGTH = 4096;

const HEALTH_TELEMETRY_VOLATILE_DETAIL_FIELDS = Object.freeze([
  "queue_draining",
  "queue_entries",
  "queue_exists",
  "queue_high_retry_entries",
  "queue_invalid_rows",
  "queue_max_attempts",
  "queue_rows_total",
  "queue_size_bytes",
  "pending_otel_spans",
  "last_attempted_flush_at",
  "last_failed_flush_at",
  "last_otel_attempt_at",
  "last_otel_failure_at",
  "last_otel_success_at",
  "last_successful_flush_at",
] as const);

/** Stable snapshot policy for a read surface whose probes refresh observation metadata. */
export interface PmReadOutputContinuationFingerprintPolicy {
  /** Version included in fingerprints so policy changes invalidate older cursors. */
  version: 3;
  /** Declared continuation row paths governed by this policy. */
  paths: readonly string[];
  /** Exact direct detail fields excluded for each named dynamic row. */
  ignored_detail_field_names_by_row: Readonly<
    Record<string, readonly string[]>
  >;
  /** Promise that verdicts, stable configuration, and nonvolatile evidence remain bound. */
  guarantee: "nonvolatile_snapshot_and_stable_configuration";
}

/** Command-specific exceptions to complete-row continuation fingerprinting. */
export const PM_READ_OUTPUT_CONTINUATION_FINGERPRINT_POLICIES: Readonly<
  Partial<
    Record<PmReadOutputSurface, PmReadOutputContinuationFingerprintPolicy>
  >
> = Object.freeze({
  health: Object.freeze({
    version: 3,
    paths: Object.freeze(["checks"]),
    ignored_detail_field_names_by_row: Object.freeze({
      telemetry: HEALTH_TELEMETRY_VOLATILE_DETAIL_FIELDS,
    }),
    guarantee: "nonvolatile_snapshot_and_stable_configuration",
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeReadOutputFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeReadOutputFingerprintValue);
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      normalizeReadOutputFingerprintValue(entry),
    ]),
  );
}

function normalizeReadOutputFingerprintRow(
  value: unknown,
  policy: PmReadOutputContinuationFingerprintPolicy,
): unknown {
  if (!isRecord(value)) return normalizeReadOutputFingerprintValue(value);
  const rowName = typeof value.name === "string" ? value.name : undefined;
  const ignoredDetailFields =
    rowName !== undefined &&
    Object.hasOwn(policy.ignored_detail_field_names_by_row, rowName)
      ? policy.ignored_detail_field_names_by_row[rowName]
      : undefined;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => {
        if (key !== "details" || !ignoredDetailFields || !isRecord(entry)) {
          return [key, normalizeReadOutputFingerprintValue(entry)];
        }
        return [
          key,
          Object.fromEntries(
            Object.entries(entry)
              .filter(([detailKey]) => !ignoredDetailFields.includes(detailKey))
              .map(([detailKey, detailValue]) => [
                detailKey,
                normalizeReadOutputFingerprintValue(detailValue),
              ]),
          ),
        ];
      }),
  );
}

function normalizeReadOutputFingerprintSnapshot(
  value: unknown,
  policy: PmReadOutputContinuationFingerprintPolicy,
): unknown {
  return Array.isArray(value)
    ? value.map((row) => normalizeReadOutputFingerprintRow(row, policy))
    : normalizeReadOutputFingerprintRow(value, policy);
}

/** Fingerprint the policy-normalized row snapshot so stable evidence changes fail closed. */
export function readOutputCollectionFingerprint(
  path: string,
  value: unknown[] | Record<string, unknown>,
  command?: PmReadOutputSurface,
): string {
  const policy = command
    ? PM_READ_OUTPUT_CONTINUATION_FINGERPRINT_POLICIES[command]
    : undefined;
  const policyApplies = policy?.paths.includes(path) === true;
  return createHash("sha256")
    .update(
      stableStringify({
        path,
        value: policyApplies
          ? normalizeReadOutputFingerprintSnapshot(value, policy)
          : value,
        ...(policyApplies
          ? { fingerprint_policy_version: policy.version }
          : {}),
      }),
    )
    .digest("base64url")
    .slice(0, 16);
}

/** Encode one stable declared-row continuation for CLI, SDK, and MCP callers. */
export function encodeReadOutputContinuationCursor(
  cursor: Omit<PmReadOutputCursorEnvelope, "version">,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      c: cursor.command,
      p: cursor.path,
      o: cursor.offset,
      n: cursor.total_rows,
      f: cursor.fingerprint,
    }),
    "utf8",
  ).toString("base64url");
}

/** Decode and validate one universal declared-row continuation cursor. */
export function decodeReadOutputContinuationCursor(
  raw: string,
): PmReadOutputCursorEnvelope {
  if (raw.length > MAX_READ_OUTPUT_CURSOR_LENGTH) {
    throw new PmCliError(
      "The read-output continuation cursor is malformed or unsupported.",
      EXIT_CODE.USAGE,
      { code: "read_output_cursor_invalid" },
    );
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    candidate = null;
  }
  if (
    !isRecord(candidate) ||
    candidate.v !== 1 ||
    resolveReadOutputSurface(String(candidate.c ?? "")) !== candidate.c ||
    typeof candidate.p !== "string" ||
    candidate.p.length === 0 ||
    !Number.isSafeInteger(candidate.o) ||
    (candidate.o as number) < 0 ||
    !Number.isSafeInteger(candidate.n) ||
    (candidate.n as number) < 1 ||
    typeof candidate.f !== "string" ||
    candidate.f.length === 0
  ) {
    throw new PmCliError(
      "The read-output continuation cursor is malformed or unsupported.",
      EXIT_CODE.USAGE,
      { code: "read_output_cursor_invalid" },
    );
  }
  return {
    version: 1,
    command: candidate.c as PmReadOutputSurface,
    path: candidate.p as string,
    offset: candidate.o as number,
    total_rows: candidate.n as number,
    fingerprint: candidate.f as string,
  };
}

/** Place every non-passing assurance assertion before passing evidence. */
export function prioritizeAssuranceAssertions(
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(result.assertions)) return result;
  const priority = (row: unknown): number => {
    if (!isRecord(row) || row.verdict === "pass") return 4;
    if (row.verdict === "retired") return 3;
    return row.enforcement === "block" ? 0 : row.enforcement === "warn" ? 1 : 2;
  };
  return {
    ...result,
    assertions: result.assertions
      .map((row, index) => ({ row, index }))
      .sort(
        (left, right) =>
          priority(left.row) - priority(right.row) || left.index - right.index,
      )
      .map(({ row }) => row),
    budget_retention_policy: "verdict_priority",
  };
}

/** Validate and apply a continuation suffix to its declared row collection. */
export function applyReadOutputContinuation(
  result: Record<string, unknown>,
  command: PmReadOutputSurface,
  cursor: PmReadOutputCursorEnvelope | undefined,
): Record<string, unknown> {
  if (!cursor) return result;
  if (cursor.command !== command) {
    throw new PmCliError(
      `The read-output cursor belongs to ${cursor.command}, not ${command}.`,
      EXIT_CODE.USAGE,
      { code: "read_output_cursor_command_mismatch" },
    );
  }
  const collection = readOutputContinuationRowCollections(result).find(
    (entry) => entry.path === cursor.path,
  );
  const totalRows = collection
    ? Array.isArray(collection.value)
      ? collection.value.length
      : Object.keys(collection.value).length
    : 0;
  if (
    !collection ||
    totalRows !== cursor.total_rows ||
    cursor.offset > totalRows ||
    readOutputCollectionFingerprint(cursor.path, collection.value, command) !==
      cursor.fingerprint
  ) {
    throw new PmCliError(
      "The read-output continuation no longer matches the declared row collection; restart the bounded read.",
      EXIT_CODE.USAGE,
      { code: "read_output_cursor_stale" },
    );
  }
  return sliceReadOutputRowCollection(result, cursor.path, cursor.offset);
}
