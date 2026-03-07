import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, removeFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { runActiveOnReadHooks, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { appendHistoryEntry, createHistoryEntry } from "../../core/history/history.js";
import { generateItemId, normalizeItemId } from "../../core/item/id.js";
import { canonicalDocument, normalizeFrontMatter, serializeItemDocument } from "../../core/item/item-format.js";
import { parseTags } from "../../core/item/parse.js";
import { acquireLock } from "../../core/lock/lock.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { getHistoryPath, getItemPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { Dependency, ItemDocument, ItemFrontMatter, ItemStatus, ItemType, LogNote } from "../../types/index.js";
import { DEPENDENCY_KIND_VALUES, STATUS_VALUES } from "../../types/index.js";

const DEFAULT_BEADS_FILE = ".beads/issues.jsonl";

export interface BeadsImportOptions {
  file?: string;
  author?: string;
  message?: string;
}

export interface BeadsImportResult {
  ok: boolean;
  source: string;
  imported: number;
  skipped: number;
  ids: string[];
  warnings: string[];
}

interface BeadsRecord extends Record<string, unknown> {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  issue_type?: unknown;
  type?: unknown;
  status?: unknown;
  priority?: unknown;
  tags?: unknown;
  body?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  deadline?: unknown;
  assignee?: unknown;
  author?: unknown;
  estimated_minutes?: unknown;
  acceptance_criteria?: unknown;
  close_reason?: unknown;
  dependencies?: unknown;
  comments?: unknown;
  notes?: unknown;
  learnings?: unknown;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toIsoString(value: unknown): string | undefined {
  const raw = toNonEmptyString(value);
  if (!raw) {
    return undefined;
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}

function toEstimatedMinutes(value: unknown): number | undefined {
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

function toPriority(value: unknown): 0 | 1 | 2 | 3 | 4 {
  const fallback: 0 | 1 | 2 | 3 | 4 = 2;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4) {
    return value as 0 | 1 | 2 | 3 | 4;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 4) {
      return parsed as 0 | 1 | 2 | 3 | 4;
    }
  }
  return fallback;
}

function toTags(value: unknown): string[] {
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

function toItemType(value: unknown): ItemType {
  const normalized = toNonEmptyString(value)?.toLowerCase();
  switch (normalized) {
    case "epic":
      return "Epic";
    case "feature":
      return "Feature";
    case "task":
      return "Task";
    case "chore":
      return "Chore";
    case "issue":
      return "Issue";
    default:
      return "Task";
  }
}

function toStatus(value: unknown): ItemStatus {
  const normalized = toNonEmptyString(value)?.toLowerCase();
  if (normalized && STATUS_VALUES.includes(normalized as ItemStatus)) {
    return normalized as ItemStatus;
  }
  return "open";
}

function toDependencyKind(value: unknown): Dependency["kind"] {
  const normalized = toNonEmptyString(value)?.toLowerCase();
  if (normalized && DEPENDENCY_KIND_VALUES.includes(normalized as Dependency["kind"])) {
    return normalized as Dependency["kind"];
  }
  return "related";
}

function toDependencies(value: unknown, fallbackCreatedAt: string, prefix: string): Dependency[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const dependencies: Dependency[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const id = toNonEmptyString(entry);
      if (!id) {
        continue;
      }
      dependencies.push({
        id: normalizeItemId(id, prefix),
        kind: "related",
        created_at: fallbackCreatedAt,
      });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const id = toNonEmptyString(candidate.id) ?? toNonEmptyString(candidate.item_id);
    if (!id) {
      continue;
    }
    dependencies.push({
      id: normalizeItemId(id, prefix),
      kind: toDependencyKind(candidate.kind),
      created_at: toIsoString(candidate.created_at) ?? fallbackCreatedAt,
      author: toNonEmptyString(candidate.author),
    });
  }

  return dependencies.length > 0 ? dependencies : undefined;
}

function toLogEntries(value: unknown, fallbackCreatedAt: string, fallbackAuthor: string): LogNote[] | undefined {
  if (typeof value === "string") {
    const text = toNonEmptyString(value);
    if (!text) {
      return undefined;
    }
    return [
      {
        created_at: fallbackCreatedAt,
        author: fallbackAuthor,
        text,
      },
    ];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries: LogNote[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const text = toNonEmptyString(entry);
      if (!text) {
        continue;
      }
      entries.push({
        created_at: fallbackCreatedAt,
        author: fallbackAuthor,
        text,
      });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const text =
      toNonEmptyString(candidate.text) ??
      toNonEmptyString(candidate.comment) ??
      toNonEmptyString(candidate.note) ??
      toNonEmptyString(candidate.learning);
    if (!text) {
      continue;
    }
    entries.push({
      created_at: toIsoString(candidate.created_at) ?? fallbackCreatedAt,
      author: toNonEmptyString(candidate.author) ?? fallbackAuthor,
      text,
    });
  }

  return entries.length > 0 ? entries : undefined;
}

function selectAuthor(explicitAuthor: string | undefined, settingsAuthor: string): string {
  const candidate = explicitAuthor ?? process.env.PM_AUTHOR ?? settingsAuthor;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

function ensureInitHasRun(pmRoot: string): Promise<void> {
  return pathExists(getSettingsPath(pmRoot)).then((exists) => {
    if (!exists) {
      throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
    }
  });
}

function emptyDocument(): ItemDocument {
  return {
    front_matter: {} as ItemFrontMatter,
    body: "",
  };
}

function resolveInputPath(rawPath: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

export async function runBeadsImport(options: BeadsImportOptions, global: GlobalOptions): Promise<BeadsImportResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitHasRun(pmRoot);

  const settings = await readSettings(pmRoot);
  const source = toNonEmptyString(options.file) ?? DEFAULT_BEADS_FILE;
  const sourcePath = resolveInputPath(source);
  if (!(await pathExists(sourcePath))) {
    throw new PmCliError(`Beads source file not found at ${sourcePath}`, EXIT_CODE.NOT_FOUND);
  }

  const raw = await fs.readFile(sourcePath, "utf8");
  const warnings: string[] = [
    ...(await runActiveOnReadHooks({
      path: sourcePath,
      scope: "project",
    })),
  ];
  const lines = raw.split(/\r?\n/);
  const author = selectAuthor(toNonEmptyString(options.author), settings.author_default);
  const message = toNonEmptyString(options.message) ?? "Import from Beads JSONL";
  const ids: string[] = [];
  let imported = 0;
  let skipped = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (line.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      warnings.push(`beads_import_invalid_jsonl_line:${lineNumber}`);
      skipped += 1;
      continue;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      warnings.push(`beads_import_invalid_record:${lineNumber}`);
      skipped += 1;
      continue;
    }
    const record = parsed as BeadsRecord;

    const title = toNonEmptyString(record.title);
    if (!title) {
      warnings.push(`beads_import_missing_title:${lineNumber}`);
      skipped += 1;
      continue;
    }

    const createdAt = toIsoString(record.created_at) ?? nowIso();
    const updatedAt = toIsoString(record.updated_at) ?? createdAt;
    const id = toNonEmptyString(record.id)
      ? normalizeItemId(toNonEmptyString(record.id) as string, settings.id_prefix)
      : await generateItemId(pmRoot, settings.id_prefix);
    const type = toItemType(record.issue_type ?? record.type);
    const frontMatter = normalizeFrontMatter({
      id,
      title,
      description: toNonEmptyString(record.description) ?? "",
      type,
      status: toStatus(record.status),
      priority: toPriority(record.priority),
      tags: toTags(record.tags),
      created_at: createdAt,
      updated_at: updatedAt,
      deadline: toIsoString(record.deadline),
      assignee: toNonEmptyString(record.assignee),
      author: toNonEmptyString(record.author) ?? author,
      estimated_minutes: toEstimatedMinutes(record.estimated_minutes),
      acceptance_criteria: toNonEmptyString(record.acceptance_criteria),
      close_reason: toNonEmptyString(record.close_reason),
      dependencies: toDependencies(record.dependencies, createdAt, settings.id_prefix),
      comments: toLogEntries(record.comments, createdAt, author),
      notes: toLogEntries(record.notes, createdAt, author),
      learnings: toLogEntries(record.learnings, createdAt, author),
    });
    const afterDocument = canonicalDocument({
      front_matter: frontMatter,
      body: toNonEmptyString(record.body) ?? "",
    });
    const itemPath = getItemPath(pmRoot, type, id);
    if (await pathExists(itemPath)) {
      warnings.push(`beads_import_item_exists:${id}`);
      skipped += 1;
      continue;
    }

    const historyPath = getHistoryPath(pmRoot, id);
    try {
      const releaseLock = await acquireLock(pmRoot, id, settings.locks.ttl_seconds, author);
      try {
        await writeFileAtomic(itemPath, serializeItemDocument(afterDocument));
        try {
          const entry = createHistoryEntry({
            nowIso: nowIso(),
            author,
            op: "import",
            before: emptyDocument(),
            after: afterDocument,
            message,
          });
          await appendHistoryEntry(historyPath, entry);
          warnings.push(
            ...(await runActiveOnWriteHooks({
              path: itemPath,
              scope: "project",
              op: "import",
            })),
            ...(await runActiveOnWriteHooks({
              path: historyPath,
              scope: "project",
              op: "import:history",
            })),
          );
        } catch (error: unknown) {
          await removeFileIfExists(itemPath);
          throw error;
        }
      } finally {
        await releaseLock();
      }
    } catch (error: unknown) {
      if (error instanceof PmCliError && error.exitCode === EXIT_CODE.CONFLICT) {
        warnings.push(`beads_import_lock_conflict:${id}`);
        skipped += 1;
        continue;
      }
      throw error;
    }

    ids.push(id);
    imported += 1;
  }

  return {
    ok: true,
    source,
    imported,
    skipped,
    ids,
    warnings,
  };
}
