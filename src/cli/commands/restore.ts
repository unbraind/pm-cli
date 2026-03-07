import jsonPatch from "fast-json-patch";
import { pathExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { appendHistoryEntry, createHistoryEntry } from "../../core/history/history.js";
import { canonicalDocument, serializeItemDocument } from "../../core/item/item-format.js";
import { acquireLock } from "../../core/lock/lock.js";
import { EXIT_CODE, FRONT_MATTER_KEY_ORDER } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { orderObject, sha256Hex, stableStringify } from "../../core/shared/serialization.js";
import { runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getHistoryPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { HistoryEntry, HistoryPatchOp, ItemDocument, ItemFrontMatter } from "../../types/index.js";
import { readHistoryEntries } from "./history.js";

interface CanonicalReplayDocument {
  front_matter: Record<string, unknown>;
  body: string;
}

interface ResolvedRestoreTarget {
  kind: "version" | "timestamp";
  raw: string;
  historyIndex: number;
}

export interface RestoreCommandOptions {
  author?: string;
  message?: string;
  force?: boolean;
}

export interface RestoreResult {
  item: ItemFrontMatter;
  restored_from: {
    kind: "version" | "timestamp";
    target: string;
    history_index: number;
    entry_ts: string;
    entry_op: string;
  };
  changed_fields: string[];
  warnings: string[];
}

const EMPTY_REPLAY_DOCUMENT: CanonicalReplayDocument = {
  front_matter: {},
  body: "",
};

function toAuthor(candidate: string | undefined, defaultAuthor: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function toReplayDocument(document: ItemDocument): CanonicalReplayDocument {
  const canonical = canonicalDocument(document);
  return {
    front_matter: orderObject(
      canonical.front_matter as unknown as Record<string, unknown>,
      FRONT_MATTER_KEY_ORDER,
    ),
    body: canonical.body,
  };
}

function replayHash(document: CanonicalReplayDocument): string {
  return sha256Hex(stableStringify(document));
}

function ensureReplayTarget(target: string, history: HistoryEntry[]): ResolvedRestoreTarget {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new PmCliError("Missing restore target. Use a timestamp or version number.", EXIT_CODE.USAGE);
  }

  if (/^\d+$/.test(trimmed)) {
    const version = Number(trimmed);
    if (!Number.isSafeInteger(version) || version < 1 || version > history.length) {
      throw new PmCliError(
        `Restore version must be between 1 and ${history.length} for this item.`,
        EXIT_CODE.USAGE,
      );
    }
    return {
      kind: "version",
      raw: trimmed,
      historyIndex: version - 1,
    };
  }

  const parsedTarget = Date.parse(trimmed);
  if (!Number.isFinite(parsedTarget)) {
    throw new PmCliError(
      `Invalid restore target "${target}". Use a positive version number or ISO timestamp.`,
      EXIT_CODE.USAGE,
    );
  }

  let index = -1;
  for (let i = 0; i < history.length; i += 1) {
    const entryTimestamp = Date.parse(history[i].ts);
    if (!Number.isFinite(entryTimestamp)) {
      throw new PmCliError(
        `History for this item contains invalid timestamp at entry ${i + 1}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    if (entryTimestamp <= parsedTarget) {
      index = i;
    }
  }

  if (index < 0) {
    throw new PmCliError(`No history entries exist at or before timestamp ${trimmed}.`, EXIT_CODE.USAGE);
  }

  return {
    kind: "timestamp",
    raw: trimmed,
    historyIndex: index,
  };
}

function applyHistoryPatch(
  current: CanonicalReplayDocument,
  patch: HistoryPatchOp[],
  entryNumber: number,
): CanonicalReplayDocument {
  try {
    const applied = jsonPatch.applyPatch(
      structuredClone(current),
      patch as jsonPatch.Operation[],
      true,
      false,
    ).newDocument as unknown;
    if (
      typeof applied !== "object" ||
      applied === null ||
      !("front_matter" in applied) ||
      !("body" in applied) ||
      typeof (applied as { body: unknown }).body !== "string" ||
      typeof (applied as { front_matter: unknown }).front_matter !== "object" ||
      (applied as { front_matter: unknown }).front_matter === null
    ) {
      throw new PmCliError(
        `History replay produced an invalid document shape at entry ${entryNumber}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    const replay = applied as { front_matter: Record<string, unknown>; body: string };
    return {
      front_matter: replay.front_matter,
      body: replay.body,
    };
  } catch (error: unknown) {
    if (error instanceof PmCliError) {
      throw error;
    }
    throw new PmCliError(
      `Failed to apply history patch at entry ${entryNumber}.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

function replayToTarget(history: HistoryEntry[], targetIndex: number): CanonicalReplayDocument {
  let document: CanonicalReplayDocument = structuredClone(EMPTY_REPLAY_DOCUMENT);

  for (let i = 0; i <= targetIndex; i += 1) {
    const entry = history[i];
    const beforeHash = replayHash(document);
    if (beforeHash !== entry.before_hash) {
      throw new PmCliError(
        `History hash mismatch before replay at entry ${i + 1}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }

    document = applyHistoryPatch(document, entry.patch, i + 1);

    const afterHash = replayHash(document);
    if (afterHash !== entry.after_hash) {
      throw new PmCliError(
        `History hash mismatch after replay at entry ${i + 1}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
  }

  return document;
}

function changedFields(beforeDocument: ItemDocument, afterDocument: ItemDocument): string[] {
  const beforeReplay = toReplayDocument(beforeDocument);
  const afterReplay = toReplayDocument(afterDocument);
  const patch = jsonPatch.compare(beforeReplay, afterReplay) as HistoryPatchOp[];
  const fields = new Set<string>();

  for (const op of patch) {
    if (op.path === "/body" || op.path.startsWith("/body/")) {
      fields.add("body");
      continue;
    }
    const segment = op.path.replace(/^\/front_matter\/?/, "").split("/")[0];
    fields.add(segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  }

  return Array.from(fields).sort((a, b) => a.localeCompare(b));
}

export async function runRestore(
  id: string,
  target: string,
  options: RestoreCommandOptions,
  global: GlobalOptions,
): Promise<RestoreResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const located = await locateItem(pmRoot, id, settings.id_prefix);
  if (!located) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
  }

  const historyPath = getHistoryPath(pmRoot, located.id);
  const history = await readHistoryEntries(historyPath, located.id);
  if (history.length === 0) {
    throw new PmCliError(`No history exists for ${located.id}; restore is unavailable.`, EXIT_CODE.NOT_FOUND);
  }

  const resolvedTarget = ensureReplayTarget(target, history);
  const replayDocument = replayToTarget(history, resolvedTarget.historyIndex);
  const restoredDocument = canonicalDocument({
    front_matter: replayDocument.front_matter as unknown as ItemFrontMatter,
    body: replayDocument.body,
  });

  if (restoredDocument.front_matter.id !== located.id) {
    throw new PmCliError(
      `Restore target resolved to item ${restoredDocument.front_matter.id}, expected ${located.id}.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }

  const author = toAuthor(options.author, settings.author_default);
  const releaseLock = await acquireLock(
    pmRoot,
    located.id,
    settings.locks.ttl_seconds,
    author,
    Boolean(options.force),
  );

  try {
    const { raw: originalRaw, document: currentDocument } = await readLocatedItem(located);
    const assigned = currentDocument.front_matter.assignee?.trim();
    if (assigned && assigned !== author && !options.force) {
      throw new PmCliError(
        `Item ${located.id} is assigned to ${assigned}. Use --force to override.`,
        EXIT_CODE.CONFLICT,
      );
    }

    const serializedRestore = serializeItemDocument(restoredDocument);
    await writeFileAtomic(located.itemPath, serializedRestore);

    const historyEntry = createHistoryEntry({
      nowIso: nowIso(),
      author,
      op: "restore",
      before: currentDocument,
      after: restoredDocument,
      message: options.message,
    });

    try {
      await appendHistoryEntry(historyPath, historyEntry);
    } catch (error: unknown) {
      await writeFileAtomic(located.itemPath, originalRaw);
      throw error;
    }
    const hookWarnings = [
      ...(await runActiveOnWriteHooks({
        path: located.itemPath,
        scope: "project",
        op: "restore",
      })),
      ...(await runActiveOnWriteHooks({
        path: historyPath,
        scope: "project",
        op: "restore:history",
      })),
    ];

    const targetEntry = history[resolvedTarget.historyIndex];
    return {
      item: restoredDocument.front_matter,
      restored_from: {
        kind: resolvedTarget.kind,
        target: resolvedTarget.raw,
        history_index: resolvedTarget.historyIndex + 1,
        entry_ts: targetEntry.ts,
        entry_op: targetEntry.op,
      },
      changed_fields: changedFields(currentDocument, restoredDocument),
      warnings: hookWarnings,
    };
  } finally {
    await releaseLock();
  }
}
