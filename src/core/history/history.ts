import jsonPatch from "fast-json-patch";
import { EMPTY_CANONICAL_DOCUMENT, FRONT_MATTER_KEY_ORDER } from "../shared/constants.js";
import { appendLineAtomic } from "../fs/fs-utils.js";
import { canonicalDocument } from "../item/item-format.js";
import { orderObject, sha256Hex, stableStringify } from "../shared/serialization.js";
import type { HistoryEntry, HistoryPatchOp, ItemDocument } from "../../types/index.js";

function canonicalHashDocument(document: ItemDocument): { front_matter: Record<string, unknown>; body: string } {
  const hasFrontMatter = document.front_matter && Object.keys(document.front_matter).length > 0;
  if (!hasFrontMatter) {
    return {
      front_matter: {},
      body: document.body ?? "",
    };
  }
  const canonical = canonicalDocument(document);
  const orderedFrontMatter = orderObject(
    canonical.front_matter as unknown as Record<string, unknown>,
    FRONT_MATTER_KEY_ORDER,
  );
  return {
    front_matter: orderedFrontMatter,
    body: canonical.body,
  };
}

export function hashDocument(document: ItemDocument): string {
  return sha256Hex(stableStringify(canonicalHashDocument(document)));
}

export function hashEmptyDocument(): string {
  return sha256Hex(stableStringify(EMPTY_CANONICAL_DOCUMENT));
}

export function createHistoryEntry(params: {
  nowIso: string;
  author: string;
  op: string;
  before: ItemDocument;
  after: ItemDocument;
  message?: string;
}): HistoryEntry {
  const beforeCanonical = canonicalHashDocument(params.before);
  const afterCanonical = canonicalHashDocument(params.after);
  const patch = jsonPatch.compare(beforeCanonical, afterCanonical) as HistoryPatchOp[];

  return {
    ts: params.nowIso,
    author: params.author,
    op: params.op,
    patch,
    before_hash: sha256Hex(stableStringify(beforeCanonical)),
    after_hash: sha256Hex(stableStringify(afterCanonical)),
    message: params.message === undefined ? undefined : params.message,
  };
}

export async function appendHistoryEntry(historyPath: string, entry: HistoryEntry): Promise<void> {
  await appendLineAtomic(historyPath, JSON.stringify(entry));
}
