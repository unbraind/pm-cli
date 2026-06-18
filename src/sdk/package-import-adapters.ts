/**
 * Shared external-source import adapter primitives for bundled pm packages.
 *
 * The Beads (pm-beads) and Todos (pm-todos) importers map records from an
 * external format into pm items. The field-by-field mapping is intentionally
 * package-specific (different source schemas, type vocabularies, and timestamp
 * rules), but a number of value-coercion helpers and the item write/commit
 * sequence are behavior-identical across both adapters.
 *
 * These primitives are re-exported from the SDK runtime surface (`src/sdk/runtime.ts`),
 * which is the only module bundled packages are permitted to import (they load it
 * at runtime via `PM_CLI_PACKAGE_ROOT`). Centralizing them here removes copy-pasted
 * helper bodies while keeping each package's explicit field mapping in the package.
 */

import { appendHistoryEntry, createHistoryEntry } from "../core/history/history.js";
import { acquireLock } from "../core/lock/lock.js";
import { parseTags } from "../core/item/parse.js";
import { normalizeStatusInput } from "../core/item/status.js";
import { serializeItemDocument } from "../core/item/item-format.js";
import { getHistoryPath, getSettingsPath } from "../core/store/paths.js";
import { pathExists, removeFileIfExists, writeFileAtomic } from "../core/fs/fs-utils.js";
import { runActiveOnWriteHooks } from "../core/extensions/index.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { nowIso } from "../core/shared/time.js";
import type { ItemDocument, ItemMetadata, ItemStatus, PmSettings } from "../types/index.js";

/**
 * Returns the trimmed string when `value` is a non-empty string, else undefined.
 */
export function toNonEmptyImportString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Coerces a non-negative finite numeric estimate (number or numeric string).
 */
export function toEstimatedMinutesValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Coerces a priority into the 0..4 range, defaulting to 2.
 */
export function toImportPriority(value: unknown): 0 | 1 | 2 | 3 | 4 {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4) {
    return value as 0 | 1 | 2 | 3 | 4;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 4) {
      return parsed as 0 | 1 | 2 | 3 | 4;
    }
  }
  return 2;
}

/**
 * Normalizes tags from an array of strings or a comma-separated string.
 */
export function toImportTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    const tags = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    return Array.from(new Set(tags)).sort((left, right) => left.localeCompare(right));
  }
  if (typeof value === "string") {
    return parseTags(value);
  }
  return [];
}

/**
 * Maps a raw status value to a canonical pm status, defaulting to "open".
 */
export function toImportStatus(value: unknown): ItemStatus {
  const normalized = toNonEmptyImportString(value);
  if (normalized) {
    const canonical = normalizeStatusInput(normalized);
    if (canonical) {
      return canonical;
    }
  }
  return "open";
}

/**
 * Resolves the effective import author: explicit flag, PM_AUTHOR, then settings,
 * falling back to "unknown".
 */
export function selectImportAuthor(explicitAuthor: string | undefined, settingsAuthor: string): string {
  const explicit = explicitAuthor?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  const envAuthor = process.env.PM_AUTHOR?.trim();
  if (envAuthor && envAuthor.length > 0) {
    return envAuthor;
  }
  const settings = settingsAuthor.trim();
  return settings.length > 0 ? settings : "unknown";
}

/**
 * Throws a NOT_FOUND PmCliError when the tracker has not been initialized.
 */
export async function ensureTrackerInitialized(pmRoot: string): Promise<void> {
  const exists = await pathExists(getSettingsPath(pmRoot));
  if (!exists) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
}

/**
 * Returns an empty item document used as the `before` state on import.
 */
export function emptyImportedDocument(): ItemDocument {
  return {
    metadata: {} as ItemMetadata,
    body: "",
  };
}

/**
 * Documents the commit imported item params payload exchanged by command, SDK, and package integrations.
 */
export interface CommitImportedItemParams {
  pmRoot: string;
  id: string;
  itemPath: string;
  document: ItemDocument;
  author: string;
  message: string;
  settings: PmSettings;
  /** Warning prefix emitted on a lock conflict, e.g. "beads_import_lock_conflict". */
  conflictWarningPrefix: string;
}

/**
 * Restricts commit imported item result values accepted by command, SDK, and storage contracts.
 */
export type CommitImportedItemResult =
  | { committed: true; writeWarnings: string[] }
  | { committed: false; conflictWarning: string };

/**
 * Performs the shared item write/commit sequence: acquire the per-item lock,
 * atomically write the TOON document, append the import history entry, and run
 * on-write hooks. On a lock CONFLICT it returns a `conflictWarning` (using the
 * caller-supplied prefix) instead of throwing; any other error removes the
 * partially written file and rethrows.
 */
export async function commitImportedItem(
  params: CommitImportedItemParams,
): Promise<CommitImportedItemResult> {
  const { pmRoot, id, itemPath, document, author, message, settings, conflictWarningPrefix } = params;
  const historyPath = getHistoryPath(pmRoot, id);
  const beforeDocument = emptyImportedDocument();
  try {
    const releaseLock = await acquireLock(pmRoot, id, settings.locks.ttl_seconds, author);
    try {
      await writeFileAtomic(itemPath, serializeItemDocument(document, { format: "toon" }));
      try {
        const entry = createHistoryEntry({
          nowIso: nowIso(),
          author,
          op: "import",
          before: beforeDocument,
          after: document,
          message,
        });
        await appendHistoryEntry(historyPath, entry);
        const writeWarnings = [
          ...(await runActiveOnWriteHooks({
            path: itemPath,
            scope: "project",
            op: "import",
            item_id: document.metadata.id,
            item_type: document.metadata.type,
            before: beforeDocument,
            after: document,
            changed_fields: ["imported"],
          })),
          ...(await runActiveOnWriteHooks({
            path: historyPath,
            scope: "project",
            op: "import:history",
            item_id: document.metadata.id,
            item_type: document.metadata.type,
            before: beforeDocument,
            after: document,
            changed_fields: ["imported"],
          })),
        ];
        return { committed: true, writeWarnings };
      } catch (error: unknown) {
        await removeFileIfExists(itemPath);
        throw error;
      }
    } finally {
      await releaseLock();
    }
  } catch (error: unknown) {
    if (error instanceof PmCliError && error.exitCode === EXIT_CODE.CONFLICT) {
      return { committed: false, conflictWarning: `${conflictWarningPrefix}:${id}` };
    }
    throw error;
  }
}
