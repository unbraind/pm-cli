/**
 * @module sdk/lifecycle/checkpoint-rollback
 *
 * Reverses proven bulk effects under the ordinary item mutation lock, retaining
 * unrelated current context and refusing conflicting postimages atomically.
 */
import { readHistoryEntries } from "../../core/history/read.js";
import { replayHistoryToTarget } from "../../core/history/projection.js";
import { replayToCanonicalItemDocument } from "../../core/history/replay.js";
import { mutateItemWithHistoryContext } from "../../core/store/item-store.js";
import { getHistoryPath } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { stableValueEquals } from "../../core/shared/serialization.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { restoreCheckpointItems, type LoadedMutationCheckpoint } from "../../core/checkpoint/mutation-checkpoint.js";
import type { HistoryEntry, ItemDocument } from "../../types/index.js";
import { verifyHistoryEntries } from "../history-read.js";

interface InverseField {
  field: string;
  before: unknown;
  after: unknown;
}

/** Compose one committed field delta, refusing an intervening peer's write to that field. */
function appendInverseFields(fields: Map<string, InverseField>, before: ItemDocument, after: ItemDocument): void {
  const beforeFields = { ...before.metadata, body: before.body } as Record<string, unknown>;
  const afterFields = { ...after.metadata, body: after.body } as Record<string, unknown>;
  for (const field of new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])) {
    if (field === "updated_at" || field === "pm_format_version") continue;
    const prior = beforeFields[field];
    const next = afterFields[field];
    if (stableValueEquals(prior, next)) continue;
    const previous = fields.get(field);
    if (previous && !stableValueEquals(previous.after, prior)) {
      throw new PmCliError(`Rollback conflict on ${field}: the batch effects contain an intervening edit. Inspect pm history before resolving it.`, EXIT_CODE.CONFLICT);
    }
    fields.set(field, { field, before: previous ? previous.before : prior, after: next });
  }
}

/** Retain the earliest preimage and latest postimage of each field actually changed by this batch. */
function checkpointInverseFields(history: HistoryEntry[], checkpointId: string, schema: Awaited<ReturnType<typeof readSettings>>["schema"]): InverseField[] {
  const fields = new Map<string, InverseField>();
  for (const [index, entry] of history.entries()) {
    if (entry.context?.bulk_checkpoint !== checkpointId) continue;
    const before = replayToCanonicalItemDocument(replayHistoryToTarget(history, index - 1), { schema });
    const after = replayToCanonicalItemDocument(replayHistoryToTarget(history, index), { schema });
    appendInverseFields(fields, before, after);
  }
  return [...fields.values()].filter((field) => !stableValueEquals(field.before, field.after));
}

/** Check all inverse guards before touching any field in the locked document. */
function applyCheckpointInverse(document: ItemDocument, fields: InverseField[]): string[] {
  const current = { ...document.metadata, body: document.body } as Record<string, unknown>;
  const conflicts = fields.filter((field) => !stableValueEquals(current[field.field], field.after));
  if (conflicts.length > 0) {
    throw new PmCliError(`Rollback conflict on ${conflicts.map((field) => field.field).join(", ")}: a later edit changed a batch field. Inspect pm get/history and reconcile it explicitly before retrying.`, EXIT_CODE.CONFLICT);
  }
  for (const field of fields) {
    if (field.field === "body") document.body = field.before as string;
    else if (field.before === undefined) delete (document.metadata as Record<string, unknown>)[field.field];
    else (document.metadata as Record<string, unknown>)[field.field] = structuredClone(field.before);
  }
  return fields.map((field) => field.field);
}

/** Undo only attributed committed item effects; legacy timestamp checkpoints cannot authorize a destructive restore. */
export async function rollbackMutationCheckpoint(pmRoot: string, checkpoint: LoadedMutationCheckpoint, options: { author?: string; message: string; force?: boolean }) {
  if (checkpoint.record.rollback_strategy !== "guarded_inverse") {
    throw new PmCliError("This legacy checkpoint has no attributable inverse effects. Inspect pm history and use an explicit pm restore only after reviewing later edits.", EXIT_CODE.CONFLICT);
  }
  const settings = await readSettings(pmRoot);
  return restoreCheckpointItems(checkpoint.items, async (id) => {
    const result = await mutateItemWithHistoryContext({
      pmRoot, settings, id, op: "restore", author: resolveAuthor(options.author, settings.author_default),
      message: options.message,
      force: options.force, skipNoop: true, historyContext: { bulk_rollback: checkpoint.id },
      async mutate(document) {
        const history = await readHistoryEntries(getHistoryPath(pmRoot, id), id);
        const verification = verifyHistoryEntries(history, document);
        if (!verification.ok) throw new PmCliError(`Cannot safely roll back ${id}: item/history verification failed. Inspect pm history --verify before recovery.`, EXIT_CODE.CONFLICT);
        if (history.some((entry) => entry.context?.bulk_rollback === checkpoint.id)) return { changedFields: [] };
        return { changedFields: applyCheckpointInverse(document, checkpointInverseFields(history, checkpoint.id, settings.schema)) };
      },
    });
    return { changed_fields: result.changedFields, warnings: result.warnings, skipped: result.changedFields.length === 0 };
  });
}
