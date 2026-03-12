import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, removeFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { runActiveOnReadHooks, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { appendHistoryEntry, createHistoryEntry } from "../../core/history/history.js";
import { generateItemId, normalizeItemId, normalizeRawItemId } from "../../core/item/id.js";
import { canonicalDocument, normalizeFrontMatter, serializeItemDocument } from "../../core/item/item-format.js";
import { parseTags } from "../../core/item/parse.js";
import { acquireLock } from "../../core/lock/lock.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { isTimestampLiteral, nowIso } from "../../core/shared/time.js";
import { getHistoryPath, getItemPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { Dependency, ItemDocument, ItemFrontMatter, ItemStatus, ItemType, LogNote, LinkedFile, LinkedTest, LinkedDoc } from "../../types/index.js";
import { DEPENDENCY_KIND_VALUES, STATUS_VALUES } from "../../types/index.js";

const PRIMARY_AUTO_DISCOVERY_FILES = [
  ".beads/issues.jsonl",
  "issues.jsonl",
] as const;

const UNSAFE_AUTO_DISCOVERY_FILES = [
  ".beads/sync_base.jsonl",
  "sync_base.jsonl",
] as const;

export interface BeadsImportOptions {
  file?: string;
  author?: string;
  message?: string;
  preserveSourceIds?: boolean;
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
  labels?: unknown;
  body?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  closed_at?: unknown;
  due_at?: unknown;
  deadline?: unknown;
  assignee?: unknown;
  owner?: unknown;
  author?: unknown;
  created_by?: unknown;
  estimated_minutes?: unknown;
  acceptance_criteria?: unknown;
  design?: unknown;
  external_ref?: unknown;
  close_reason?: unknown;
  dependencies?: unknown;
  comments?: unknown;
  notes?: unknown;
  learnings?: unknown;
  files?: unknown;
  tests?: unknown;
  docs?: unknown;
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
  if (!isTimestampLiteral(raw)) {
    return undefined;
  }
  return raw;
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

function toItemType(value: unknown): { type: ItemType; sourceType?: string } {
  const raw = toNonEmptyString(value);
  const normalized = raw?.toLowerCase();
  switch (normalized) {
    case "epic":
      return { type: "Epic" };
    case "feature":
      return { type: "Feature" };
    case "task":
      return { type: "Task" };
    case "chore":
      return { type: "Chore" };
    case "issue":
      return { type: "Issue" };
    case "bug":
      return { type: "Issue", sourceType: raw };
    case "event":
      return { type: "Task", sourceType: raw };
    default:
      return { type: "Task", sourceType: raw };
  }
}

function toStatus(value: unknown): ItemStatus {
  const normalized = toNonEmptyString(value)?.toLowerCase();
  if (normalized && STATUS_VALUES.includes(normalized as ItemStatus)) {
    return normalized as ItemStatus;
  }
  return "open";
}

function toDependencyKind(value: unknown): { kind: Dependency["kind"]; sourceKind?: string } {
  const raw = toNonEmptyString(value);
  const normalized = raw?.toLowerCase();
  if (!normalized) {
    return { kind: "related" };
  }

  const preserveIfChanged = (kind: Dependency["kind"]): { kind: Dependency["kind"]; sourceKind?: string } => ({
    kind,
    sourceKind: normalized === kind ? undefined : raw,
  });

  if (DEPENDENCY_KIND_VALUES.includes(normalized as Dependency["kind"])) {
    return preserveIfChanged(normalized as Dependency["kind"]);
  }

  switch (normalized) {
    case "parent-child":
      return preserveIfChanged("parent_child");
    case "child-of":
      return preserveIfChanged("child_of");
    case "related-to":
    case "relates-to":
      return preserveIfChanged("related_to");
    case "discovered-from":
      return preserveIfChanged("discovered_from");
    case "blocked-by":
      return preserveIfChanged("blocked_by");
    case "incident-from":
      return preserveIfChanged("incident_from");
    default:
      return {
        kind: "related",
        sourceKind: raw,
      };
  }
}

function normalizeImportedId(id: string, prefix: string, preserveSourceIds: boolean): string {
  return preserveSourceIds ? normalizeRawItemId(id) : normalizeItemId(id, prefix);
}

function toDependencies(
  value: unknown,
  fallbackCreatedAt: string,
  prefix: string,
  preserveSourceIds: boolean,
): Dependency[] | undefined {
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
        id: normalizeImportedId(id, prefix, preserveSourceIds),
        kind: "related",
        created_at: fallbackCreatedAt,
      });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const id = toNonEmptyString(candidate.id) ?? toNonEmptyString(candidate.item_id) ?? toNonEmptyString(candidate.depends_on_id);
    if (!id) {
      continue;
    }
    const dependencyKind = toDependencyKind(candidate.type ?? candidate.kind);
    dependencies.push({
      id: normalizeImportedId(id, prefix, preserveSourceIds),
      kind: dependencyKind.kind,
      created_at: toIsoString(candidate.created_at) ?? fallbackCreatedAt,
      author: toNonEmptyString(candidate.author) ?? toNonEmptyString(candidate.created_by),
      source_kind: dependencyKind.sourceKind,
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

function toLinkedFiles(value: unknown): LinkedFile[] | undefined {
  if (typeof value === "string") {
    const p = toNonEmptyString(value);
    if (!p) return undefined;
    return [{ path: p, scope: "project" }];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const files: LinkedFile[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const p = toNonEmptyString(entry);
      if (p) files.push({ path: p, scope: "project" });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const p = toNonEmptyString(candidate.path) ?? toNonEmptyString(candidate.file);
    if (!p) continue;
    
    files.push({
      path: p,
      scope: toNonEmptyString(candidate.scope) === "global" ? "global" : "project",
      note: toNonEmptyString(candidate.note),
    });
  }

  return files.length > 0 ? files : undefined;
}

function toLinkedTests(value: unknown): LinkedTest[] | undefined {
  if (typeof value === "string") {
    const c = toNonEmptyString(value);
    if (!c) return undefined;
    return [{ command: c, scope: "project" }];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tests: LinkedTest[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const c = toNonEmptyString(entry);
      if (c) tests.push({ command: c, scope: "project" });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const command = toNonEmptyString(candidate.command) ?? toNonEmptyString(candidate.test);
    const p = toNonEmptyString(candidate.path);
    if (!command && !p) continue;

    let timeout: number | undefined;
    if (typeof candidate.timeout_seconds === "number" && Number.isFinite(candidate.timeout_seconds)) {
      timeout = candidate.timeout_seconds;
    } else if (typeof candidate.timeout_seconds === "string") {
      const parsed = Number(candidate.timeout_seconds);
      if (Number.isFinite(parsed) && parsed >= 0) {
        timeout = parsed;
      }
    }

    tests.push({
      command,
      path: p,
      scope: toNonEmptyString(candidate.scope) === "global" ? "global" : "project",
      timeout_seconds: timeout,
      note: toNonEmptyString(candidate.note),
    });
  }

  return tests.length > 0 ? tests : undefined;
}

function toLinkedDocs(value: unknown): LinkedDoc[] | undefined {
  if (typeof value === "string") {
    const p = toNonEmptyString(value);
    if (!p) return undefined;
    return [{ path: p, scope: "project" }];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const docs: LinkedDoc[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const p = toNonEmptyString(entry);
      if (p) docs.push({ path: p, scope: "project" });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const p = toNonEmptyString(candidate.path) ?? toNonEmptyString(candidate.doc);
    if (!p) continue;
    
    docs.push({
      path: p,
      scope: toNonEmptyString(candidate.scope) === "global" ? "global" : "project",
      note: toNonEmptyString(candidate.note),
    });
  }

  return docs.length > 0 ? docs : undefined;
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

async function readStdin(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

async function resolveBeadsSource(rawPath: string | undefined): Promise<{
  source: string;
  sourcePath?: string;
  raw: string;
  warnings: string[];
}> {
  const explicitSource = toNonEmptyString(rawPath);
  if (explicitSource) {
    if (explicitSource === "-") {
      return {
        source: "-",
        raw: await readStdin(),
        warnings: [],
      };
    }

    const explicitPath = resolveInputPath(explicitSource);
    if (!(await pathExists(explicitPath))) {
      throw new PmCliError(`Beads source file not found at ${explicitPath}`, EXIT_CODE.NOT_FOUND);
    }
    return {
      source: explicitSource,
      sourcePath: explicitPath,
      raw: await fs.readFile(explicitPath, "utf8"),
      warnings: [],
    };
  }

  for (const candidate of PRIMARY_AUTO_DISCOVERY_FILES) {
    const candidatePath = resolveInputPath(candidate);
    if (await pathExists(candidatePath)) {
      return {
        source: candidate,
        sourcePath: candidatePath,
        raw: await fs.readFile(candidatePath, "utf8"),
        warnings: candidate === PRIMARY_AUTO_DISCOVERY_FILES[0] ? [] : [`beads_import_source_autodiscovered:${candidate}`],
      };
    }
  }

  for (const candidate of UNSAFE_AUTO_DISCOVERY_FILES) {
    const candidatePath = resolveInputPath(candidate);
    if (await pathExists(candidatePath)) {
      throw new PmCliError(
        `Beads auto-discovery found ${candidatePath}, but sync_base snapshots may be partial. Export a full Beads JSONL file and pass --file <path> (or --file - for stdin).`,
        EXIT_CODE.NOT_FOUND,
      );
    }
  }

  throw new PmCliError(
    `Beads source file not found. Checked ${PRIMARY_AUTO_DISCOVERY_FILES.join(", ")}. Use --file <path> or --file - for stdin.`,
    EXIT_CODE.NOT_FOUND,
  );
}

export async function runBeadsImport(options: BeadsImportOptions, global: GlobalOptions): Promise<BeadsImportResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitHasRun(pmRoot);

  const settings = await readSettings(pmRoot);
  const preserveSourceIds = options.preserveSourceIds === true;
  const { source, sourcePath, raw, warnings: sourceWarnings } = await resolveBeadsSource(options.file);
  const warnings: string[] = [
    ...sourceWarnings,
  ];
  if (sourcePath) {
    warnings.push(
      ...(await runActiveOnReadHooks({
        path: sourcePath,
        scope: "project",
      })),
    );
  }
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
      ? normalizeImportedId(toNonEmptyString(record.id) as string, settings.id_prefix, preserveSourceIds)
      : await generateItemId(pmRoot, settings.id_prefix);
    const typeMapping = toItemType(record.issue_type ?? record.type);
    const type = typeMapping.type;
    const closedAt = toIsoString(record.closed_at);
    const assignee = toNonEmptyString(record.assignee) ?? toNonEmptyString(record.owner);
    const frontMatter = normalizeFrontMatter({
      id,
      title,
      description: toNonEmptyString(record.description) ?? "",
      type,
      source_type: typeMapping.sourceType,
      status: toStatus(record.status),
      priority: toPriority(record.priority),
      tags: toTags(record.tags ?? record.labels),
      created_at: createdAt,
      updated_at: updatedAt,
      deadline: toIsoString(record.due_at ?? record.deadline),
      closed_at: closedAt,
      assignee,
      source_owner: toNonEmptyString(record.owner),
      author: toNonEmptyString(record.author) ?? toNonEmptyString(record.created_by) ?? author,
      estimated_minutes: toEstimatedMinutes(record.estimated_minutes),
      acceptance_criteria: toNonEmptyString(record.acceptance_criteria),
      design: toNonEmptyString(record.design),
      external_ref: toNonEmptyString(record.external_ref),
      close_reason: toNonEmptyString(record.close_reason),
      dependencies: toDependencies(record.dependencies, createdAt, settings.id_prefix, preserveSourceIds),
      comments: toLogEntries(record.comments, createdAt, author),
      notes: toLogEntries(record.notes, createdAt, author),
      learnings: toLogEntries(record.learnings, createdAt, author),
      files: toLinkedFiles(record.files),
      tests: toLinkedTests(record.tests),
      docs: toLinkedDocs(record.docs),
    });
    const rawBody = toNonEmptyString(record.body) ?? "";
    const design = toNonEmptyString(record.design);
    const externalRef = toNonEmptyString(record.external_ref);
    let finalBody = rawBody;
    if (design) {
      finalBody += (finalBody ? "\n\n" : "") + "## Design\n\n" + design;
    }
    if (externalRef) {
      finalBody += (finalBody ? "\n\n" : "") + "## External Reference\n" + externalRef;
    }
    const afterDocument = canonicalDocument({
      front_matter: frontMatter,
      body: finalBody,
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
