import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { runActiveOnReadHooks, runActiveOnWriteHooks } from "../../../core/extensions/index.js";
import { pathExists, removeFileIfExists, writeFileAtomic } from "../../../core/fs/fs-utils.js";
import { appendHistoryEntry, createHistoryEntry } from "../../../core/history/history.js";
import { generateItemId, normalizeItemId } from "../../../core/item/id.js";
import { canonicalDocument, normalizeFrontMatter, serializeItemDocument, splitFrontMatter } from "../../../core/item/item-format.js";
import { parseTags } from "../../../core/item/parse.js";
import { acquireLock } from "../../../core/lock/lock.js";
import { EXIT_CODE } from "../../../core/shared/constants.js";
import type { GlobalOptions } from "../../../core/shared/command-types.js";
import { PmCliError } from "../../../core/shared/errors.js";
import { nowIso } from "../../../core/shared/time.js";
import { listAllFrontMatter, locateItem, readLocatedItem } from "../../../core/store/item-store.js";
import { getHistoryPath, getItemPath, getSettingsPath, resolvePmRoot } from "../../../core/store/paths.js";
import { readSettings } from "../../../core/store/settings.js";
import { ITEM_TYPE_VALUES, STATUS_VALUES } from "../../../types/index.js";
import type { ItemDocument, ItemFrontMatter, ItemStatus, ItemType, PmSettings } from "../../../types/index.js";

const DEFAULT_TODOS_FOLDER = ".pi/todos";

export interface TodosImportOptions {
  folder?: string;
  author?: string;
  message?: string;
}

export interface TodosExportOptions {
  folder?: string;
}

export interface TodosImportResult {
  ok: boolean;
  folder: string;
  imported: number;
  skipped: number;
  ids: string[];
  warnings: string[];
}

export interface TodosExportResult {
  ok: boolean;
  folder: string;
  exported: number;
  ids: string[];
  warnings: string[];
}

type PriorityValue = 0 | 1 | 2 | 3 | 4;

interface ParsedTodoCandidate {
  entryName: string;
  frontMatter: Record<string, unknown>;
  body: string;
  readWarnings: string[];
}

interface TodosImportRuntime {
  pmRoot: string;
  sourceFolder: string;
  settings: PmSettings;
  author: string;
  message: string;
}

type ImportCandidateResult = { id: string; writeWarnings: string[] } | { warning: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function toPriority(value: unknown): PriorityValue {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4) {
    return value as PriorityValue;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 4) {
      return parsed as PriorityValue;
    }
  }
  return 2;
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
  if (!normalized) {
    return "Task";
  }
  for (const candidate of ITEM_TYPE_VALUES) {
    if (candidate.toLowerCase() === normalized) {
      return candidate;
    }
  }
  return "Task";
}

function toStatus(value: unknown): ItemStatus {
  const normalized = toNonEmptyString(value)?.toLowerCase();
  if (normalized && STATUS_VALUES.includes(normalized as ItemStatus)) {
    return normalized as ItemStatus;
  }
  return "open";
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

function normalizeBody(body: string): string {
  return body.replace(/^\n+/, "").replace(/\s+$/, "");
}

function emptyDocument(): ItemDocument {
  return {
    front_matter: {} as ItemFrontMatter,
    body: "",
  };
}

function resolveFolderPath(rawPath: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

function parseTodoMarkdown(content: string): { frontMatter: Record<string, unknown>; body: string } {
  const split = splitFrontMatter(content);
  if (split.frontMatter.length === 0) {
    throw new TypeError("Missing JSON front matter");
  }
  const parsed = JSON.parse(split.frontMatter) as unknown;
  if (!isRecord(parsed)) {
    throw new TypeError("Front matter must be a JSON object");
  }
  return {
    frontMatter: parsed,
    body: normalizeBody(split.body),
  };
}

async function readTodoCandidate(sourceFolder: string, entry: Dirent): Promise<ParsedTodoCandidate | { warning: string }> {
  const sourcePath = path.join(sourceFolder, entry.name);
  let raw: string;
  try {
    raw = await fs.readFile(sourcePath, "utf8");
  } catch {
    return { warning: `todos_import_read_failed:${entry.name}` };
  }
  const readWarnings = await runActiveOnReadHooks({
    path: sourcePath,
    scope: "project",
  });

  let parsed: { frontMatter: Record<string, unknown>; body: string };
  try {
    parsed = parseTodoMarkdown(raw);
  } catch {
    return { warning: `todos_import_invalid_front_matter:${entry.name}` };
  }

  return {
    entryName: entry.name,
    frontMatter: parsed.frontMatter,
    body: parsed.body,
    readWarnings,
  };
}

async function importTodoCandidate(candidate: ParsedTodoCandidate, runtime: TodosImportRuntime): Promise<ImportCandidateResult> {
  const title = toNonEmptyString(candidate.frontMatter.title);
  if (!title) {
    return { warning: `todos_import_missing_title:${candidate.entryName}` };
  }

  const explicitId = toNonEmptyString(candidate.frontMatter.id);
  const derivedId = path.basename(candidate.entryName, path.extname(candidate.entryName));
  // Hidden filenames (for example `.md`) do not provide stable human ids.
  const idSource = explicitId ?? (derivedId.startsWith(".") ? undefined : derivedId);
  const id = idSource
    ? normalizeItemId(idSource, runtime.settings.id_prefix)
    : await generateItemId(runtime.pmRoot, runtime.settings.id_prefix);
  const createdAt = toIsoString(candidate.frontMatter.created_at) ?? nowIso();
  const updatedAt = toIsoString(candidate.frontMatter.updated_at) ?? createdAt;
  const type = toItemType(candidate.frontMatter.type);
  const itemPath = getItemPath(runtime.pmRoot, type, id);
  if (await pathExists(itemPath)) {
    return { warning: `todos_import_item_exists:${id}` };
  }

  const afterDocument = canonicalDocument({
    front_matter: normalizeFrontMatter({
      id,
      title,
      description: toNonEmptyString(candidate.frontMatter.description) ?? "",
      type,
      status: toStatus(candidate.frontMatter.status),
      priority: toPriority(candidate.frontMatter.priority),
      tags: toTags(candidate.frontMatter.tags),
      created_at: createdAt,
      updated_at: updatedAt,
      deadline: toIsoString(candidate.frontMatter.deadline),
      assignee: toNonEmptyString(candidate.frontMatter.assignee),
      author: toNonEmptyString(candidate.frontMatter.author) ?? runtime.author,
      estimated_minutes: toEstimatedMinutes(candidate.frontMatter.estimated_minutes),
      acceptance_criteria: toNonEmptyString(candidate.frontMatter.acceptance_criteria),
      close_reason: toNonEmptyString(candidate.frontMatter.close_reason),
      dependencies: Array.isArray(candidate.frontMatter.dependencies) ? (candidate.frontMatter.dependencies as any[]) : undefined,
      comments: Array.isArray(candidate.frontMatter.comments) ? (candidate.frontMatter.comments as any[]) : undefined,
      notes: Array.isArray(candidate.frontMatter.notes) ? (candidate.frontMatter.notes as any[]) : undefined,
      learnings: Array.isArray(candidate.frontMatter.learnings) ? (candidate.frontMatter.learnings as any[]) : undefined,
      files: Array.isArray(candidate.frontMatter.files) ? (candidate.frontMatter.files as any[]) : undefined,
      docs: Array.isArray(candidate.frontMatter.docs) ? (candidate.frontMatter.docs as any[]) : undefined,
      tests: Array.isArray(candidate.frontMatter.tests) ? (candidate.frontMatter.tests as any[]) : undefined,
    } as ItemFrontMatter),
    body: candidate.body,
  });

  const historyPath = getHistoryPath(runtime.pmRoot, id);
  let writeWarnings: string[] = [];
  try {
    const releaseLock = await acquireLock(runtime.pmRoot, id, runtime.settings.locks.ttl_seconds, runtime.author);
    try {
      await writeFileAtomic(itemPath, serializeItemDocument(afterDocument));
      try {
        const historyEntry = createHistoryEntry({
          nowIso: nowIso(),
          author: runtime.author,
          op: "import",
          before: emptyDocument(),
          after: afterDocument,
          message: runtime.message,
        });
        await appendHistoryEntry(historyPath, historyEntry);
        writeWarnings = [
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
        ];
      } catch (error: unknown) {
        await removeFileIfExists(itemPath);
        throw error;
      }
    } finally {
      await releaseLock();
    }
  } catch (error: unknown) {
    if (error instanceof PmCliError && error.exitCode === EXIT_CODE.CONFLICT) {
      return { warning: `todos_import_lock_conflict:${id}` };
    }
    throw error;
  }

  return { id, writeWarnings };
}

export async function runTodosImport(options: TodosImportOptions, global: GlobalOptions): Promise<TodosImportResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitHasRun(pmRoot);

  const settings = await readSettings(pmRoot);
  const folder = toNonEmptyString(options.folder) ?? DEFAULT_TODOS_FOLDER;
  const sourceFolder = resolveFolderPath(folder);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(sourceFolder, { withFileTypes: true });
  } catch {
    throw new PmCliError(`Todos source folder not found at ${sourceFolder}`, EXIT_CODE.NOT_FOUND);
  }

  const author = selectAuthor(toNonEmptyString(options.author), settings.author_default);
  const message = toNonEmptyString(options.message) ?? "Import from todos markdown";
  const warnings: string[] = [
    ...(await runActiveOnReadHooks({
      path: sourceFolder,
      scope: "project",
    })),
  ];
  const ids: string[] = [];
  let imported = 0;
  let skipped = 0;

  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));

  const runtime: TodosImportRuntime = {
    pmRoot,
    sourceFolder,
    settings,
    author,
    message,
  };

  for (const entry of markdownFiles) {
    const candidate = await readTodoCandidate(sourceFolder, entry);
    if ("warning" in candidate) {
      warnings.push(candidate.warning);
      skipped += 1;
      continue;
    }
    warnings.push(...candidate.readWarnings);

    const importedCandidate = await importTodoCandidate(candidate, runtime);
    if ("warning" in importedCandidate) {
      warnings.push(importedCandidate.warning);
      skipped += 1;
      continue;
    }
    warnings.push(...importedCandidate.writeWarnings);

    ids.push(importedCandidate.id);
    imported += 1;
  }

  return {
    ok: true,
    folder,
    imported,
    skipped,
    ids,
    warnings,
  };
}

export async function runTodosExport(options: TodosExportOptions, global: GlobalOptions): Promise<TodosExportResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitHasRun(pmRoot);

  const settings = await readSettings(pmRoot);
  const folder = toNonEmptyString(options.folder) ?? DEFAULT_TODOS_FOLDER;
  const destinationFolder = resolveFolderPath(folder);
  await fs.mkdir(destinationFolder, { recursive: true });

  const warnings: string[] = [];
  const ids: string[] = [];
  let exported = 0;
  const items = await listAllFrontMatter(pmRoot);
  const sorted = [...items].sort((left, right) => left.id.localeCompare(right.id));

  for (const item of sorted) {
    const located = await locateItem(pmRoot, item.id, settings.id_prefix);
    if (!located) {
      warnings.push(`todos_export_missing_item:${item.id}`);
      continue;
    }

    try {
      const { document } = await readLocatedItem(located);
      const todoFrontMatter: Record<string, unknown> = { ...document.front_matter };
      const frontMatter = JSON.stringify(todoFrontMatter, null, 2);
      const body = normalizeBody(document.body);
      const serialized = body.length > 0 ? `${frontMatter}\n\n${body}\n` : `${frontMatter}\n`;
      const exportPath = path.join(destinationFolder, `${document.front_matter.id}.md`);
      await writeFileAtomic(exportPath, serialized);
      warnings.push(
        ...(await runActiveOnWriteHooks({
          path: exportPath,
          scope: "project",
          op: "todos:export",
        })),
      );
      ids.push(document.front_matter.id);
      exported += 1;
    } catch {
      warnings.push(`todos_export_read_failed:${item.id}`);
    }
  }

  return {
    ok: true,
    folder,
    exported,
    ids,
    warnings,
  };
}
