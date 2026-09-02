/**
 * @module core/history/history
 *
 * Implements append-only history and replay behavior for History.
 */
import jsonPatch from "fast-json-patch";
import { ITEM_METADATA_KEY_ORDER } from "../shared/constants.js";
import { runActiveServiceOverride } from "../extensions/index.js";
import { appendLineAtomic } from "../fs/fs-utils.js";
import { canonicalDocument } from "../item/item-format.js";
import { toItemRecord } from "../item/item-record.js";
import {
  orderObject,
  sha256Hex,
  stableStringify,
} from "../shared/serialization.js";
import {
  isMillisecondPrecisionRfc3339DateTime,
  nowIso,
} from "../shared/time.js";
import {
  diagnoseAgentIdentity,
  resolveHistoryAgentIdentity,
  resolveHistoryAuthorSource,
  type AuthorSource,
} from "../shared/author.js";
import type {
  HistoryEntry,
  HistoryPatchOp,
  ItemDocument,
  LinkedTest,
} from "../../types/index.js";
import {
  appendHistoryEntryWithEventIndex,
  removeHistoryEventIndexForHistoryPath,
} from "./event-index.js";
import { classifyHistoryEvent } from "./event-classification.js";
import { invalidateHistoryDriftCacheForPath } from "./drift-cache.js";

const EMPTY_LEGACY_HASH_DOCUMENT = {
  front_matter: {},
  body: "",
};

/** Hash epoch for the current canonical item surface written into immutable history. */
export const CURRENT_HISTORY_ITEM_HASH_VERSION = 3 as const;
/** Hash epochs understood by this runtime. */
export const SUPPORTED_HISTORY_ITEM_HASH_VERSIONS = [1, 2, 3] as const;
/** Restricts item hash versions accepted by history replay. */
export type HistoryItemHashVersion =
  (typeof SUPPORTED_HISTORY_ITEM_HASH_VERSIONS)[number];

function compareOptionalStrings(
  left: string | undefined,
  right: string | undefined,
): number {
  return (left ?? "").localeCompare(right ?? "");
}

function compareOptionalNumbers(
  left: number | undefined,
  right: number | undefined,
): number {
  return (left ?? 0) - (right ?? 0);
}

function compareJsonValues(
  left: unknown,
  right: unknown,
  fallback: unknown,
): number {
  // Preserve the original v1 comparator byte-for-byte: replacing JSON.stringify
  // with stableStringify would invalidate immutable hashes from legacy streams.
  return JSON.stringify(left ?? fallback).localeCompare(
    JSON.stringify(right ?? fallback),
  );
}

function compareLegacyLinkedTests(left: LinkedTest, right: LinkedTest): number {
  const comparisons = [
    left.scope.localeCompare(right.scope),
    compareOptionalStrings(left.path, right.path),
    compareOptionalStrings(left.command, right.command),
    compareOptionalNumbers(left.timeout_seconds, right.timeout_seconds),
    compareOptionalStrings(left.pm_context_mode, right.pm_context_mode),
    Number(Boolean(left.shared_host_safe)) -
      Number(Boolean(right.shared_host_safe)),
    compareJsonValues(left.env_clear, right.env_clear, []),
    compareJsonValues(left.env_set, right.env_set, {}),
    compareJsonValues(
      left.assert_stdout_contains,
      right.assert_stdout_contains,
      [],
    ),
    compareJsonValues(left.assert_stdout_regex, right.assert_stdout_regex, []),
    compareJsonValues(
      left.assert_stderr_contains,
      right.assert_stderr_contains,
      [],
    ),
    compareJsonValues(left.assert_stderr_regex, right.assert_stderr_regex, []),
    compareOptionalNumbers(
      left.assert_stdout_min_lines,
      right.assert_stdout_min_lines,
    ),
    compareJsonValues(
      left.assert_json_field_equals,
      right.assert_json_field_equals,
      {},
    ),
    compareJsonValues(
      left.assert_json_field_gte,
      right.assert_json_field_gte,
      {},
    ),
    compareOptionalStrings(left.note, right.note),
  ];
  return comparisons.find((comparison) => comparison !== 0) ?? 0;
}

function decodeJsonPointer(path: string): string[] {
  if (!path || path === "/") {
    return [];
  }
  if (!path.startsWith("/")) {
    return [];
  }
  return path
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function isDefinedPointerPath(document: unknown, path: string): boolean {
  const segments = decodeJsonPointer(path);
  if (segments.length === 0) {
    return true;
  }
  let cursor: unknown = document;
  for (const segment of segments) {
    if (Array.isArray(cursor)) {
      if (segment === "-" || !/^(0|[1-9]\d*)$/.test(segment)) {
        return false;
      }
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return false;
      }
      const next = cursor[index];
      if (next === undefined) {
        return false;
      }
      cursor = next;
      continue;
    }
    if (typeof cursor !== "object" || cursor === null) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return false;
    }
    const next = (cursor as Record<string, unknown>)[segment];
    if (next === undefined) {
      return false;
    }
    cursor = next;
  }
  return true;
}

function normalizeHistoryPatchOps(
  beforeDocument: { metadata: Record<string, unknown>; body: string },
  patch: HistoryPatchOp[],
): HistoryPatchOp[] {
  const normalized: HistoryPatchOp[] = [];
  let replayCursor: unknown = structuredClone(beforeDocument);
  for (const operation of patch) {
    const normalizedOperation =
      operation.op === "replace" &&
      !isDefinedPointerPath(replayCursor, operation.path)
        ? ({ ...operation, op: "add" } as HistoryPatchOp)
        : operation;
    normalized.push(normalizedOperation);
    replayCursor = jsonPatch.applyPatch(
      replayCursor,
      [normalizedOperation as jsonPatch.Operation],
      true,
      true,
    ).newDocument as unknown;
  }
  return normalized;
}

function canonicalHashDocument(
  document: ItemDocument,
  version: HistoryItemHashVersion,
  legacyV2Fields = false,
): {
  front_matter: Record<string, unknown>;
  body: string;
} {
  const hasMetadata =
    document.metadata && Object.keys(document.metadata).length > 0;
  if (!hasMetadata) {
    return {
      front_matter: {},
      body: document.body ?? "",
    };
  }
  const canonical = canonicalDocument(document);
  // Epoch 1 and the earliest epoch-2 writer predate linked-test provenance,
  // workspace isolation, per-execution receipts, and case-preserving
  // dependency ids. Later epoch-2 writers included those fields without
  // advancing the marker, so verification must retain both immutable forms.
  const usesLegacyFields = version === 1 || (version === 2 && legacyV2Fields);
  const epochMetadata = usesLegacyFields
    ? {
        ...canonical.metadata,
        ...(canonical.metadata.dependencies === undefined
          ? {}
          : {
              dependencies: canonical.metadata.dependencies.map(
                (dependency) => ({
                  ...dependency,
                  id: dependency.id.toLowerCase(),
                }),
              ),
            }),
        ...(canonical.metadata.tests === undefined
          ? {}
          : {
              tests: canonical.metadata.tests.map(
                ({
                  workspace_context_mode: _workspaceContextMode,
                  provenance: _provenance,
                  provenance_invalid: _provenanceInvalid,
                  ...test
                }) => test,
              ),
            }),
        ...(canonical.metadata.test_runs === undefined
          ? {}
          : {
              test_runs: canonical.metadata.test_runs.map(
                ({ executions: _executions, ...testRun }) => testRun,
              ),
            }),
      }
    : canonical.metadata;
  const metadata =
    version === 1 && epochMetadata.tests
      ? {
          ...epochMetadata,
          tests: [...epochMetadata.tests].sort(compareLegacyLinkedTests),
        }
      : epochMetadata;
  const orderedMetadata = orderObject(
    toItemRecord(metadata),
    ITEM_METADATA_KEY_ORDER,
  );
  return {
    front_matter: orderedMetadata,
    body: canonical.body,
  };
}

function canonicalPatchDocument(document: ItemDocument): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const hasMetadata =
    document.metadata && Object.keys(document.metadata).length > 0;
  if (!hasMetadata) {
    return {
      metadata: {},
      body: document.body ?? "",
    };
  }
  const canonical = canonicalDocument(document);
  const orderedMetadata = orderObject(
    toItemRecord(canonical.metadata),
    ITEM_METADATA_KEY_ORDER,
  );
  return {
    metadata: orderedMetadata,
    body: canonical.body,
  };
}

/** Implements hash document for the public runtime surface of this module. */
export function hashDocument(document: ItemDocument): string {
  return hashDocumentForVersion(document, CURRENT_HISTORY_ITEM_HASH_VERSION);
}

/** Hash an item with an explicit canonicalization epoch for replay compatibility. */
export function hashDocumentForVersion(
  document: ItemDocument,
  version: HistoryItemHashVersion,
): string {
  if (
    !SUPPORTED_HISTORY_ITEM_HASH_VERSIONS.some(
      (supportedVersion) => supportedVersion === version,
    )
  ) {
    throw new TypeError(`unsupported_item_hash_version:${String(version)}`);
  }
  return sha256Hex(stableStringify(canonicalHashDocument(document, version)));
}

/**
 * Return the ordered hash candidates accepted when verifying one immutable
 * history epoch. Epoch 2 has both its established expanded hash first and the
 * earlier field-frozen writer hash second; the other epochs have one form.
 */
export function hashDocumentVerificationCandidates(
  document: ItemDocument,
  version: HistoryItemHashVersion,
): [string, ...string[]] {
  const canonicalHash = hashDocumentForVersion(document, version);
  return version === 2
    ? [
        canonicalHash,
        sha256Hex(
          stableStringify(canonicalHashDocument(document, version, true)),
        ),
      ]
    : [canonicalHash];
}

/** Implements hash empty document for the public runtime surface of this module. */
export function hashEmptyDocument(): string {
  return sha256Hex(stableStringify(EMPTY_LEGACY_HASH_DOCUMENT));
}

/** Implements create history entry for the public runtime surface of this module. */
export function createHistoryEntry(params: {
  nowIso: string;
  author: string;
  authorSource?: AuthorSource;
  op: string;
  before: ItemDocument;
  after: ItemDocument;
  message?: string;
  context?: Record<string, unknown>;
}): HistoryEntry {
  const beforeHashCanonical = canonicalHashDocument(
    params.before,
    CURRENT_HISTORY_ITEM_HASH_VERSION,
  );
  const afterHashCanonical = canonicalHashDocument(
    params.after,
    CURRENT_HISTORY_ITEM_HASH_VERSION,
  );
  const beforePatchCanonical = canonicalPatchDocument(params.before);
  const afterPatchCanonical = canonicalPatchDocument(params.after);
  const rawPatch = jsonPatch.compare(
    beforePatchCanonical,
    afterPatchCanonical,
  ) as HistoryPatchOp[];
  const patch = normalizeHistoryPatchOps(beforePatchCanonical, rawPatch);
  const agentIdentity = resolveHistoryAgentIdentity(params.author);
  const provenanceOutcomes = agentIdentity.harness
    ? Object.fromEntries(
        Object.entries(diagnoseAgentIdentity().provenance_outcomes).filter(
          ([, outcome]) =>
            outcome.resolver !== undefined && outcome.status !== "resolved",
        ),
      )
    : undefined;
  const context =
    provenanceOutcomes === undefined ||
    Object.keys(provenanceOutcomes).length === 0
      ? params.context
      : {
          ...params.context,
          agent_provenance_outcomes: provenanceOutcomes,
        };

  const entry: HistoryEntry = {
    ts: params.nowIso,
    author: params.author,
    author_source:
      params.authorSource ?? resolveHistoryAuthorSource(params.author),
    ...(agentIdentity.harness ? { agent_harness: agentIdentity.harness } : {}),
    ...(agentIdentity.model ? { agent_model: agentIdentity.model } : {}),
    ...(agentIdentity.model_source
      ? { agent_model_source: agentIdentity.model_source }
      : {}),
    ...(agentIdentity.instance
      ? { agent_instance: agentIdentity.instance }
      : {}),
    ...(agentIdentity.provenance
      ? { agent_provenance: agentIdentity.provenance }
      : {}),
    ...(agentIdentity.episode ? { agent_episode: agentIdentity.episode } : {}),
    op: params.op,
    patch,
    before_hash: sha256Hex(stableStringify(beforeHashCanonical)),
    after_hash: sha256Hex(stableStringify(afterHashCanonical)),
    item_hash_version: CURRENT_HISTORY_ITEM_HASH_VERSION,
    message: params.message === undefined ? undefined : params.message,
    ...(context === undefined ? {} : { context }),
  };
  return { ...entry, event_class: classifyHistoryEvent(entry) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fallbackHistoryTimestamp(entry: Pick<HistoryEntry, "ts">): string {
  const ts = entry.ts.trim();
  if (ts.length === 0) return nowIso();
  if (!isMillisecondPrecisionRfc3339DateTime(ts)) {
    throw new TypeError(
      "History timestamp must be a valid RFC 3339 date-time with millisecond precision",
    );
  }
  return entry.ts;
}

function withHistoryTimestamp(
  value: Record<string, unknown>,
  fallbackTs: string,
): Record<string, unknown> {
  const ts = value.ts;
  if (typeof ts === "string" && ts.trim().length > 0) {
    if (!isMillisecondPrecisionRfc3339DateTime(ts.trim())) {
      throw new TypeError(
        "History timestamp must be a valid RFC 3339 date-time with millisecond precision",
      );
    }
    return value;
  }
  return { ...value, ts: fallbackTs };
}

function serializeHistoryLine(
  value: unknown,
  fallbackEntry: Pick<HistoryEntry, "ts">,
): string {
  const fallbackTs = fallbackHistoryTimestamp(fallbackEntry);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) {
        return JSON.stringify(withHistoryTimestamp(parsed, fallbackTs));
      }
    } catch {
      // Non-JSON extension lines are preserved for compatibility.
    }
    return value;
  }
  if (isRecord(value)) {
    return JSON.stringify(withHistoryTimestamp(value, fallbackTs));
  }
  return JSON.stringify(value);
}

/** Implements append history entry for the public runtime surface of this module. */
export async function appendHistoryEntry(
  historyPath: string,
  entry: HistoryEntry,
): Promise<void> {
  const override = await runActiveServiceOverride("history_append", {
    history_path: historyPath,
    entry,
  });
  if (override.handled) {
    if (override.result === false) {
      return;
    }
    if (typeof override.result === "string") {
      await appendLineAtomic(
        historyPath,
        serializeHistoryLine(override.result, entry),
      );
      await invalidateHistoryDriftCacheForPath(historyPath);
      await removeHistoryEventIndexForHistoryPath(historyPath);
      return;
    }
    if (typeof override.result === "object" && override.result !== null) {
      const record = override.result as {
        history_path?: unknown;
        entry?: unknown;
        line?: unknown;
        skip?: unknown;
      };
      if (record.skip === true) {
        return;
      }
      const nextHistoryPath =
        typeof record.history_path === "string"
          ? record.history_path
          : historyPath;
      if (typeof record.line === "string") {
        await appendLineAtomic(
          nextHistoryPath,
          serializeHistoryLine(record.line, entry),
        );
        await invalidateHistoryDriftCacheForPath(nextHistoryPath);
        await removeHistoryEventIndexForHistoryPath(nextHistoryPath);
        return;
      }
      await appendLineAtomic(
        nextHistoryPath,
        serializeHistoryLine(record.entry ?? entry, entry),
      );
      await invalidateHistoryDriftCacheForPath(nextHistoryPath);
      await removeHistoryEventIndexForHistoryPath(nextHistoryPath);
      return;
    }
  }
  const normalizedEntry =
    entry.ts.trim().length > 0
      ? entry
      : { ...entry, ts: fallbackHistoryTimestamp(entry) };
  await appendHistoryEntryWithEventIndex(
    historyPath,
    normalizedEntry,
    async () => {
      await appendLineAtomic(
        historyPath,
        serializeHistoryLine(normalizedEntry, normalizedEntry),
      );
    },
  );
  await invalidateHistoryDriftCacheForPath(historyPath);
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  decodeJsonPointer,
  isDefinedPointerPath,
};
