/** @module sdk/history/attestation
 * Export and verify independently retained history commitments without locks or writes.
 */
import {
  historyDigest,
  resolveHistoryHashAlgorithm,
} from "../../core/history/digest.js";
import { stableStringify } from "../../core/shared/serialization.js";
import {
  isMillisecondPrecisionRfc3339DateTime,
  nowIso,
} from "../../core/shared/time.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { scanAttestationStreams } from "./attestation-scan.js";
import {
  PM_HISTORY_ATTESTATION_CONTRACT,
  type ExportAttestationOptions,
  type HistoryAttestation,
  type HistoryAttestationOptions,
  type HistoryAttestationStream,
  type HistoryAttestationVerification,
} from "./attestation-contract.js";
export * from "./attestation-contract.js";

/** Recognize plain JSON objects before inspecting untrusted bundle properties. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Match exactly the documented fields so unvalidated data cannot cross the trust boundary. */
function hasFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

/** Accept a lowercase digest with the algorithm's exact output length. */
function isDigest(value: unknown, algorithm: string): value is string {
  return (
    typeof value === "string" &&
    (algorithm === "sha256" ? /^[a-f0-9]{64}$/u : /^[a-f0-9]{128}$/u).test(
      value,
    )
  );
}

/** Validate nullable anchors against the algorithm declared by the latest record. */
function validStreamAnchors(value: Record<string, unknown>): boolean {
  if (value.entries === 0) {
    return (
      [
        value.latest_hash_algorithm,
        value.latest_after_hash,
        value.latest_record_hash,
        value.checkpoint_digest,
        value.last_maintenance,
      ].every((field) => field === null) && value.rewrite_count === 0
    );
  }
  if (
    value.latest_hash_algorithm !== "sha256" &&
    value.latest_hash_algorithm !== "sha512"
  )
    return false;
  return (
    isDigest(value.latest_after_hash, value.latest_hash_algorithm) &&
    (value.latest_record_hash === null ||
      isDigest(value.latest_record_hash, value.latest_hash_algorithm))
  );
}

/** Validate the bounded maintenance receipt without trusting a matching bundle rollup. */
function validMaintenance(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value) || !hasFields(value, ["op", "ts", "record_hash"]))
    return false;
  return (
    typeof value.op === "string" &&
    [
      "history_compact",
      "history_compact_baseline",
      "history_redact",
      "history_repair",
      "history_salvage",
      "merge_reconcile",
    ].includes(value.op) &&
    typeof value.ts === "string" &&
    isMillisecondPrecisionRfc3339DateTime(value.ts) &&
    (value.record_hash === null ||
      isDigest(value.record_hash, "sha256") ||
      isDigest(value.record_hash, "sha512"))
  );
}

/** Validate a bounded stream summary independently from its self-consistent rollup. */
function isStream(value: unknown, algorithm: string): boolean {
  if (
    !isObject(value) ||
    !hasFields(value, [
      "id",
      "entries",
      "bytes",
      "stream_digest",
      "latest_after_hash",
      "latest_record_hash",
      "latest_hash_algorithm",
      "rewrite_count",
      "checkpoint_digest",
      "last_maintenance",
    ])
  )
    return false;
  return (
    typeof value.id === "string" &&
    /^[A-Za-z0-9_-]+$/u.test(value.id) &&
    [value.entries, value.bytes, value.rewrite_count].every(
      (count) =>
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    ) &&
    isDigest(value.stream_digest, algorithm) &&
    validStreamAnchors(value) &&
    (value.checkpoint_digest === null ||
      isDigest(value.checkpoint_digest, "sha256")) &&
    validMaintenance(value.last_maintenance)
  );
}

/** Validate untrusted JSON and its rollup before treating it as an expected commitment. */
export function parseHistoryAttestation(value: unknown): HistoryAttestation {
  if (
    !isObject(value) ||
    !hasFields(value, [
      "format",
      "version",
      "hash_algorithm",
      "generated_at",
      "streams",
      "workspace_digest",
    ])
  )
    throw new TypeError("Invalid history attestation bundle");
  if (
    value.format !== PM_HISTORY_ATTESTATION_CONTRACT.format ||
    value.version !== 1 ||
    typeof value.generated_at !== "string" ||
    !isMillisecondPrecisionRfc3339DateTime(value.generated_at) ||
    !Array.isArray(value.streams) ||
    (value.hash_algorithm !== "sha256" && value.hash_algorithm !== "sha512")
  )
    throw new TypeError("Invalid history attestation format");
  const algorithm = value.hash_algorithm;
  let previous: string | undefined;
  for (const stream of value.streams) {
    if (!isStream(stream, algorithm))
      throw new TypeError("Invalid history attestation stream");
    const id = (stream as HistoryAttestationStream).id;
    if (previous !== undefined && id <= previous)
      throw new TypeError("Invalid history attestation stream order");
    previous = id;
  }
  const { workspace_digest: expected, ...payload } = value;
  if (historyDigest(stableStringify(payload), algorithm) !== expected)
    throw new TypeError("History attestation rollup mismatch");
  return value as unknown as HistoryAttestation;
}

/** Export every retained item/workspace stream; refuse incomplete or invalid evidence. */
export async function exportAttestation(
  options: ExportAttestationOptions = {},
): Promise<HistoryAttestation> {
  const algorithm = resolveHistoryHashAlgorithm(options.hashAlgorithm);
  const generatedAt = options.generatedAt ?? nowIso();
  if (!isMillisecondPrecisionRfc3339DateTime(generatedAt))
    throw new TypeError("Invalid history attestation timestamp");
  const rows = await scanAttestationStreams(
    resolvePmRoot(options.cwd ?? process.cwd(), options.pmRoot),
    algorithm,
  );
  const invalid = rows.filter((row) => row.stream === null);
  if (invalid.length > 0)
    throw new TypeError(
      `Cannot export history attestation: invalid streams ${invalid.map((row) => row.id).join(", ")}`,
    );
  const payload = {
    format: PM_HISTORY_ATTESTATION_CONTRACT.format,
    version: 1 as const,
    hash_algorithm: algorithm,
    generated_at: generatedAt,
    streams: rows.map((row) => row.stream as HistoryAttestationStream),
  };
  return parseHistoryAttestation({
    ...payload,
    workspace_digest: historyDigest(stableStringify(payload), algorithm),
  });
}

/** Compare exact bytes with a trusted detached bundle; append and maintenance changes remain visible. */
export async function verifyAttestation(
  bundleInput: unknown,
  options: HistoryAttestationOptions = {},
): Promise<HistoryAttestationVerification> {
  const bundle = parseHistoryAttestation(bundleInput);
  const rows = await scanAttestationStreams(
    resolvePmRoot(options.cwd ?? process.cwd(), options.pmRoot),
    bundle.hash_algorithm,
  );
  const current = new Map(rows.map((row) => [row.id, row]));
  const expected = new Map(bundle.streams.map((stream) => [stream.id, stream]));
  const missing = bundle.streams
    .filter((stream) => !current.has(stream.id))
    .map((stream) => stream.id);
  const added = rows
    .filter((row) => !expected.has(row.id))
    .map((row) => row.id);
  const invalid = rows
    .filter((row) => row.stream === null)
    .map((row) => row.id);
  const transitions: HistoryAttestationVerification["transitions"] = [];
  for (const stream of bundle.streams) {
    const row = current.get(stream.id);
    if (
      row &&
      (row.digest !== stream.stream_digest ||
        stableStringify(row.stream) !== stableStringify(stream))
    )
      transitions.push({
        id: stream.id,
        before_digest: stream.stream_digest,
        after_digest: row.digest,
        last_maintenance: row.stream?.last_maintenance ?? null,
      });
  }
  return {
    ok:
      missing.length + added.length + invalid.length + transitions.length === 0,
    workspace_digest: bundle.workspace_digest,
    streams_checked: rows.length,
    changed_streams: transitions.map((transition) => transition.id),
    missing_streams: missing,
    added_streams: added,
    invalid_streams: invalid,
    transitions,
  };
}
