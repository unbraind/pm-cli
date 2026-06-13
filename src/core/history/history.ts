import jsonPatch from "fast-json-patch";
import { FRONT_MATTER_KEY_ORDER } from "../shared/constants.js";
import { runActiveServiceOverride } from "../extensions/index.js";
import { appendLineAtomic } from "../fs/fs-utils.js";
import { canonicalDocument } from "../item/item-format.js";
import { toItemRecord } from "../item/item-record.js";
import { orderObject, sha256Hex, stableStringify } from "../shared/serialization.js";
import type { HistoryEntry, HistoryPatchOp, ItemDocument } from "../../types/index.js";

const EMPTY_LEGACY_HASH_DOCUMENT = {
  front_matter: {},
  body: "",
};

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
      operation.op === "replace" && !isDefinedPointerPath(replayCursor, operation.path)
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

function canonicalHashDocument(document: ItemDocument): { front_matter: Record<string, unknown>; body: string } {
  const hasMetadata = document.metadata && Object.keys(document.metadata).length > 0;
  if (!hasMetadata) {
    return {
      front_matter: {},
      body: document.body ?? "",
    };
  }
  const canonical = canonicalDocument(document);
  const orderedFrontMatter = orderObject(toItemRecord(canonical.metadata), FRONT_MATTER_KEY_ORDER);
  return {
    front_matter: orderedFrontMatter,
    body: canonical.body,
  };
}

function canonicalPatchDocument(document: ItemDocument): { metadata: Record<string, unknown>; body: string } {
  const hasMetadata = document.metadata && Object.keys(document.metadata).length > 0;
  if (!hasMetadata) {
    return {
      metadata: {},
      body: document.body ?? "",
    };
  }
  const canonical = canonicalDocument(document);
  const orderedMetadata = orderObject(toItemRecord(canonical.metadata), FRONT_MATTER_KEY_ORDER);
  return {
    metadata: orderedMetadata,
    body: canonical.body,
  };
}

export function hashDocument(document: ItemDocument): string {
  return sha256Hex(stableStringify(canonicalHashDocument(document)));
}

export function hashEmptyDocument(): string {
  return sha256Hex(stableStringify(EMPTY_LEGACY_HASH_DOCUMENT));
}

export function createHistoryEntry(params: {
  nowIso: string;
  author: string;
  op: string;
  before: ItemDocument;
  after: ItemDocument;
  message?: string;
}): HistoryEntry {
  const beforeHashCanonical = canonicalHashDocument(params.before);
  const afterHashCanonical = canonicalHashDocument(params.after);
  const beforePatchCanonical = canonicalPatchDocument(params.before);
  const afterPatchCanonical = canonicalPatchDocument(params.after);
  const rawPatch = jsonPatch.compare(beforePatchCanonical, afterPatchCanonical) as HistoryPatchOp[];
  const patch = normalizeHistoryPatchOps(beforePatchCanonical, rawPatch);

  return {
    ts: params.nowIso,
    author: params.author,
    op: params.op,
    patch,
    before_hash: sha256Hex(stableStringify(beforeHashCanonical)),
    after_hash: sha256Hex(stableStringify(afterHashCanonical)),
    message: params.message === undefined ? undefined : params.message,
  };
}

export async function appendHistoryEntry(historyPath: string, entry: HistoryEntry): Promise<void> {
  const override = await runActiveServiceOverride("history_append", {
    history_path: historyPath,
    entry,
  });
  if (override.handled) {
    if (override.result === false) {
      return;
    }
    if (typeof override.result === "string") {
      await appendLineAtomic(historyPath, override.result);
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
      const nextHistoryPath = typeof record.history_path === "string" ? record.history_path : historyPath;
      if (typeof record.line === "string") {
        await appendLineAtomic(nextHistoryPath, record.line);
        return;
      }
      const nextEntry = (record.entry ?? entry) as HistoryEntry;
      await appendLineAtomic(nextHistoryPath, JSON.stringify(nextEntry));
      return;
    }
  }
  await appendLineAtomic(historyPath, JSON.stringify(entry));
}

export const _testOnly = {
  decodeJsonPointer,
  isDefinedPointerPath,
};
