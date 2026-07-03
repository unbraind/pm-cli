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
import type {
  Dependency,
  ConfidenceTextLevel,
  ItemDocument,
  ItemMetadata,
  ItemStatus,
  LinkedDoc,
  LinkedFile,
  LinkedTest,
  LogNote,
  PmSettings,
} from "../types/index.js";

/**
 * Restricts shared import priority values accepted by import adapters.
 */
export type ImportPriorityValue = 0 | 1 | 2 | 3 | 4;

/**
 * Restricts import linked-artifact scopes accepted by bundled package adapters.
 */
export type ImportLinkedScope = "project" | "global";

/**
 * Configures conversion of loosely shaped source comments into pm log entries.
 */
export interface ToImportLogEntriesOptions {
  fallbackCreatedAt: string;
  fallbackAuthor: string;
  allowScalar?: boolean;
  textKeys?: readonly string[];
  createdAtKey?: string;
  authorKey?: string;
  toIsoString?: (value: unknown) => string | undefined;
}

/**
 * Configures conversion of loosely shaped source file/doc arrays into pm linked artifacts.
 */
export interface ToImportLinkedArtifactsOptions {
  allowScalar?: boolean;
  pathKeys?: readonly string[];
}

/**
 * Configures conversion of loosely shaped source test arrays into pm linked tests.
 */
export interface ToImportLinkedTestsOptions {
  allowScalar?: boolean;
  commandKeys?: readonly string[];
  pathKeys?: readonly string[];
  includeExtendedAssertions?: boolean;
  integerTimeout?: boolean;
  timeoutMinimum?: number;
  timeoutExclusiveMinimum?: boolean;
}

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
export function toImportPriority(value: unknown): ImportPriorityValue {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4) {
    return value as ImportPriorityValue;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 4) {
      return parsed as ImportPriorityValue;
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
 * Coerces a finite integer from a number or non-empty numeric string.
 */
export function toImportInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Coerces common boolean representations used by external package formats.
 */
export function toImportBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  return normalized === "false" || normalized === "0" ? false : undefined;
}

/**
 * Coerces an array of non-empty strings.
 */
export function toImportStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((entry) => toNonEmptyImportString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return entries.length > 0 ? entries : undefined;
}

/**
 * Coerces a record of non-empty string values.
 */
export function toImportStringMap(value: unknown): Record<string, string> | undefined {
  return toImportValueMap(value, toNonEmptyImportString);
}

/**
 * Coerces a record of integer values.
 */
export function toImportNumberMap(value: unknown): Record<string, number> | undefined {
  return toImportValueMap(value, toImportInteger);
}

/**
 * Maps a loose source confidence value onto pm's confidence field.
 */
export function toImportConfidence(
  value: unknown,
  allowedTextValues: readonly ConfidenceTextLevel[],
): ItemMetadata["confidence"] | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) {
    return value;
  }
  const normalized = toNonEmptyImportString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const candidate = normalized === "med" ? "medium" : normalized;
  if (allowedTextValues.some((entry) => entry === candidate)) {
    return candidate as ConfidenceTextLevel;
  }
  const parsed = Number(candidate);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : undefined;
}

/**
 * Maps a string onto an allowed enum value, including the common "med" alias.
 */
export function toImportNormalizedEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  const normalized = toNonEmptyImportString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const candidate = normalized === "med" ? "medium" : normalized;
  return allowed.includes(candidate as T[number]) ? (candidate as T[number]) : undefined;
}

/**
 * Resolves pm linked-artifact scope values, defaulting to project scope.
 */
export function toImportLinkScope(value: unknown): ImportLinkedScope {
  return toNonEmptyImportString(value)?.toLowerCase() === "global" ? "global" : "project";
}

/**
 * Converts source comments, notes, or learnings into pm log notes.
 */
export function toImportLogEntries(value: unknown, options: ToImportLogEntriesOptions): LogNote[] | undefined {
  const values = normalizeImportCollection(value, options.allowScalar === true);
  if (!values) {
    return undefined;
  }
  const entries = values
    .map((entry) => toImportLogEntry(entry, options))
    .filter((entry): entry is LogNote => entry !== undefined);
  return entries.length > 0 ? entries : undefined;
}

/**
 * Converts source file artifacts into pm linked files.
 */
export function toImportLinkedFiles(value: unknown, options: ToImportLinkedArtifactsOptions = {}): LinkedFile[] | undefined {
  return toImportLinkedArtifacts(value, options, (pathValue, record) => ({
    path: pathValue,
    scope: toImportLinkScope(record?.scope),
    note: toNonEmptyImportString(record?.note),
  }));
}

/**
 * Converts source doc artifacts into pm linked docs.
 */
export function toImportLinkedDocs(value: unknown, options: ToImportLinkedArtifactsOptions = {}): LinkedDoc[] | undefined {
  return toImportLinkedArtifacts(value, options, (pathValue, record) => ({
    path: pathValue,
    scope: toImportLinkScope(record?.scope),
    note: toNonEmptyImportString(record?.note),
  }));
}

/**
 * Converts source test artifacts into pm linked tests.
 */
export function toImportLinkedTests(value: unknown, options: ToImportLinkedTestsOptions = {}): LinkedTest[] | undefined {
  const values = normalizeImportCollection(value, options.allowScalar === true);
  if (!values) {
    return undefined;
  }
  const entries = values
    .map((entry) => toImportLinkedTest(entry, options))
    .filter((entry): entry is LinkedTest => entry !== undefined);
  return entries.length > 0 ? entries : undefined;
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

function isImportRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeImportCollection(value: unknown, allowScalar: boolean): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  return allowScalar ? [value] : undefined;
}

function firstNonEmptyImportString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = toNonEmptyImportString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function toImportValueMap<T>(
  value: unknown,
  coerce: (entryValue: unknown) => T | undefined,
): Record<string, T> | undefined {
  if (!isImportRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, entryValue]) => [key.trim(), coerce(entryValue)] as const)
    .filter((entry): entry is readonly [string, T] => entry[0].length > 0 && entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toImportLogEntry(entry: unknown, options: ToImportLogEntriesOptions): LogNote | undefined {
  if (typeof entry === "string") {
    return toImportLogEntryFromText(entry, options);
  }
  if (!isImportRecord(entry)) {
    return undefined;
  }
  const text = firstNonEmptyImportString(entry, options.textKeys ?? ["text"]);
  if (!text) {
    return undefined;
  }
  const createdAtKey = options.createdAtKey ?? "created_at";
  const authorKey = options.authorKey ?? "author";
  const createdAt =
    (options.toIsoString ? options.toIsoString(entry[createdAtKey]) : toNonEmptyImportString(entry[createdAtKey])) ??
    options.fallbackCreatedAt;
  return {
    created_at: createdAt,
    author: toNonEmptyImportString(entry[authorKey]) ?? options.fallbackAuthor,
    text,
  };
}

function toImportLogEntryFromText(entry: string, options: ToImportLogEntriesOptions): LogNote | undefined {
  const text = toNonEmptyImportString(entry);
  return text
    ? {
        created_at: options.fallbackCreatedAt,
        author: options.fallbackAuthor,
        text,
      }
    : undefined;
}

function toImportLinkedArtifacts<T>(
  value: unknown,
  options: ToImportLinkedArtifactsOptions,
  build: (pathValue: string, record?: Record<string, unknown>) => T,
): T[] | undefined {
  const values = normalizeImportCollection(value, options.allowScalar === true);
  if (!values) {
    return undefined;
  }
  const pathKeys = options.pathKeys ?? ["path"];
  const entries = values
    .map((entry) => toImportLinkedArtifact(entry, pathKeys, build))
    .filter((entry): entry is T => entry !== undefined);
  return entries.length > 0 ? entries : undefined;
}

function toImportLinkedArtifact<T>(
  entry: unknown,
  pathKeys: readonly string[],
  build: (pathValue: string, record?: Record<string, unknown>) => T,
): T | undefined {
  if (typeof entry === "string") {
    const pathValue = toNonEmptyImportString(entry);
    return pathValue ? build(pathValue) : undefined;
  }
  if (!isImportRecord(entry)) {
    return undefined;
  }
  const pathValue = firstNonEmptyImportString(entry, pathKeys);
  return pathValue ? build(pathValue, entry) : undefined;
}

function toImportLinkedTest(entry: unknown, options: ToImportLinkedTestsOptions): LinkedTest | undefined {
  if (typeof entry === "string") {
    const command = toNonEmptyImportString(entry);
    return command ? { command, scope: "project" } : undefined;
  }
  if (!isImportRecord(entry)) {
    return undefined;
  }
  const command = firstNonEmptyImportString(entry, options.commandKeys ?? ["command"]);
  const testPath = firstNonEmptyImportString(entry, options.pathKeys ?? ["path"]);
  if (!command && !testPath) {
    return undefined;
  }
  return {
    command,
    path: testPath,
    scope: toImportLinkScope(entry.scope),
    timeout_seconds: toImportLinkedTestTimeout(entry.timeout_seconds, options),
    note: toNonEmptyImportString(entry.note),
    ...(options.includeExtendedAssertions === true ? toImportLinkedTestAssertions(entry) : {}),
  };
}

function toImportLinkedTestTimeout(value: unknown, options: ToImportLinkedTestsOptions): number | undefined {
  const parsed = options.integerTimeout === true ? toImportInteger(value) : toImportFiniteNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  const minimum = options.timeoutMinimum ?? 0;
  return options.timeoutExclusiveMinimum === true ? (parsed > minimum ? parsed : undefined) : parsed >= minimum ? parsed : undefined;
}

function toImportFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toImportLinkedTestAssertions(entry: Record<string, unknown>): Partial<LinkedTest> {
  return {
    pm_context_mode: toImportNormalizedEnum(entry.pm_context_mode, ["schema", "tracker", "auto"] as const),
    env_set: toImportStringMap(entry.env_set),
    env_clear: toImportStringList(entry.env_clear),
    shared_host_safe: toImportBoolean(entry.shared_host_safe),
    assert_stdout_contains: toImportStringList(entry.assert_stdout_contains),
    assert_stdout_regex: toImportStringList(entry.assert_stdout_regex),
    assert_stderr_contains: toImportStringList(entry.assert_stderr_contains),
    assert_stderr_regex: toImportStringList(entry.assert_stderr_regex),
    assert_stdout_min_lines: toImportInteger(entry.assert_stdout_min_lines),
    assert_json_field_equals: toImportStringMap(entry.assert_json_field_equals),
    assert_json_field_gte: toImportNumberMap(entry.assert_json_field_gte),
  };
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
