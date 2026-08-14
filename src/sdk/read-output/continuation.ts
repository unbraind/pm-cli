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
import type {
  PmReadOutputCursorEnvelope,
  PmReadOutputSurface,
} from "../read-output-contracts.js";
import { resolveReadOutputSurface } from "../read-output-contracts.js";
import {
  readOutputRowCollections,
  sliceReadOutputRowCollection,
} from "../read-output-rows.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Fingerprint stable row identities without including volatile observation fields. */
export function readOutputCollectionFingerprint(
  path: string,
  value: unknown[] | Record<string, unknown>,
): string {
  const identities = Array.isArray(value)
    ? value.map((row, index) => {
        if (!isRecord(row)) return `index:${String(index)}`;
        for (const key of [
          "id",
          "assertion_id",
          "measurement_id",
          "event_id",
        ]) {
          const candidate = row[key];
          if (typeof candidate === "string" && candidate.length > 0) {
            return `${key}:${candidate}`;
          }
        }
        return `index:${String(index)}`;
      })
    : Object.keys(value);
  return createHash("sha256")
    .update(JSON.stringify({ path, identities }))
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
  const collection = readOutputRowCollections(result).find(
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
    readOutputCollectionFingerprint(cursor.path, collection.value) !==
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
