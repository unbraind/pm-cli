import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  CommitImportedItemParams,
  CommitImportedItemResult,
  Dependency,
  GlobalOptions,
  ItemDocument,
  ItemMetadata,
  ItemStatus,
  ItemType,
  LinkedDoc,
  LinkedFile,
  LinkedTest,
  LogNote,
  PmSettings,
} from "@unbrained/pm-cli/sdk";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const CURRENT_RUNTIME_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TODOS_FOLDER = ".pm/todos";

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
type ConfidenceTextValue = Extract<NonNullable<ItemMetadata["confidence"]>, string>;

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
  typeNames: string[];
  typeToFolder: Record<string, string>;
  author: string;
  message: string;
}

type ImportCandidateResult = { id: string; writeWarnings: string[] } | { warning: string };

interface ActiveExtensionRegistrations {
  types?: unknown;
}

interface ItemTypeRegistry {
  types: string[];
  type_to_folder: Record<string, string>;
}

interface TodosSdkModule {
  CONFIDENCE_TEXT_VALUES: readonly ConfidenceTextValue[];
  DEPENDENCY_KIND_VALUES: readonly Dependency["kind"][];
  EXIT_CODE: {
    NOT_FOUND: number;
  };
  ISSUE_SEVERITY_VALUES: readonly string[];
  PmCliError: new (message: string, exitCode?: number) => Error;
  RISK_VALUES: readonly string[];
  canonicalDocument: (document: ItemDocument) => ItemDocument;
  commitImportedItem: (params: CommitImportedItemParams) => Promise<CommitImportedItemResult>;
  ensureTrackerInitialized: (pmRoot: string) => Promise<void>;
  generateItemId: (pmRoot: string, prefix: string) => Promise<string>;
  getActiveExtensionRegistrations: () => ActiveExtensionRegistrations | null;
  getItemPath: (
    pmRoot: string,
    type: ItemType,
    id: string,
    itemFormat: "toon",
    typeToFolder: Record<string, string>,
  ) => string;
  listAllFrontMatter: (
    pmRoot: string,
    itemFormat: PmSettings["item_format"],
    typeToFolder: Record<string, string>,
  ) => Promise<ItemMetadata[]>;
  locateItem: (
    pmRoot: string,
    id: string,
    prefix: string,
    itemFormat: PmSettings["item_format"],
    typeToFolder: Record<string, string>,
  ) => Promise<unknown>;
  normalizeFrontMatter: (frontMatter: Partial<ItemMetadata>) => ItemMetadata;
  normalizeItemId: (id: string, prefix: string) => string;
  nowIso: () => string;
  readLocatedItem: (located: unknown) => Promise<{ document: ItemDocument }>;
  readSettings: (pmRoot: string) => Promise<PmSettings>;
  resolveItemTypeRegistry: (
    settings: PmSettings,
    registrations: ActiveExtensionRegistrations | null,
  ) => ItemTypeRegistry;
  resolvePmRoot: (cwd: string, overridePath?: string) => string;
  runActiveOnReadHooks: (context: { path: string; scope: "project" | "global" }) => Promise<string[]>;
  runActiveOnWriteHooks: (context: {
    path: string;
    scope: "project" | "global";
    op: string;
  }) => Promise<string[]>;
  selectImportAuthor: (explicitAuthor: string | undefined, settingsAuthor: string) => string;
  splitFrontMatter: (content: string) => { frontMatter: string; body: string };
  toEstimatedMinutesValue: (value: unknown) => number | undefined;
  toImportPriority: (value: unknown) => 0 | 1 | 2 | 3 | 4;
  toImportStatus: (value: unknown) => ItemStatus;
  toImportTags: (value: unknown) => string[];
  toNonEmptyImportString: (value: unknown) => string | undefined;
  writeFileAtomic: (targetPath: string, content: string) => Promise<void>;
}

async function loadTodosSdkModule(): Promise<TodosSdkModule> {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  const hasConfiguredPackageRoot = typeof envRoot === "string" && envRoot.trim().length > 0;
  const packageRoot =
    hasConfiguredPackageRoot
      ? path.resolve(envRoot.trim())
      : path.resolve(CURRENT_RUNTIME_ROOT, "../../../..");
  const modulePath = hasConfiguredPackageRoot
    ? path.join(packageRoot, "dist", "sdk", "index.js")
    : path.join(packageRoot, "src", "sdk", "index.ts");
  try {
    const loaded = (await import(pathToFileURL(modulePath).href)) as Partial<TodosSdkModule>;
    if (
      Array.isArray(loaded.CONFIDENCE_TEXT_VALUES) &&
      Array.isArray(loaded.DEPENDENCY_KIND_VALUES) &&
      typeof loaded.EXIT_CODE === "object" &&
      loaded.EXIT_CODE !== null &&
      Array.isArray(loaded.ISSUE_SEVERITY_VALUES) &&
      typeof loaded.PmCliError === "function" &&
      Array.isArray(loaded.RISK_VALUES) &&
      typeof loaded.canonicalDocument === "function" &&
      typeof loaded.commitImportedItem === "function" &&
      typeof loaded.ensureTrackerInitialized === "function" &&
      typeof loaded.generateItemId === "function" &&
      typeof loaded.getActiveExtensionRegistrations === "function" &&
      typeof loaded.getItemPath === "function" &&
      typeof loaded.listAllFrontMatter === "function" &&
      typeof loaded.locateItem === "function" &&
      typeof loaded.normalizeFrontMatter === "function" &&
      typeof loaded.normalizeItemId === "function" &&
      typeof loaded.nowIso === "function" &&
      typeof loaded.readLocatedItem === "function" &&
      typeof loaded.readSettings === "function" &&
      typeof loaded.resolveItemTypeRegistry === "function" &&
      typeof loaded.resolvePmRoot === "function" &&
      typeof loaded.runActiveOnReadHooks === "function" &&
      typeof loaded.runActiveOnWriteHooks === "function" &&
      typeof loaded.selectImportAuthor === "function" &&
      typeof loaded.splitFrontMatter === "function" &&
      typeof loaded.toEstimatedMinutesValue === "function" &&
      typeof loaded.toImportPriority === "function" &&
      typeof loaded.toImportStatus === "function" &&
      typeof loaded.toImportTags === "function" &&
      typeof loaded.toNonEmptyImportString === "function" &&
      typeof loaded.writeFileAtomic === "function"
    ) {
      return loaded as TodosSdkModule;
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(`builtin-todos failed to load SDK exports from ${modulePath}.`);
}

const {
  CONFIDENCE_TEXT_VALUES,
  DEPENDENCY_KIND_VALUES,
  EXIT_CODE,
  ISSUE_SEVERITY_VALUES,
  PmCliError,
  RISK_VALUES,
  canonicalDocument,
  commitImportedItem,
  ensureTrackerInitialized,
  generateItemId,
  getActiveExtensionRegistrations,
  getItemPath,
  listAllFrontMatter,
  locateItem,
  normalizeFrontMatter,
  normalizeItemId,
  nowIso,
  readLocatedItem,
  readSettings,
  resolveItemTypeRegistry,
  resolvePmRoot,
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
  selectImportAuthor,
  splitFrontMatter,
  toEstimatedMinutesValue,
  toImportPriority,
  toImportStatus,
  toImportTags,
  toNonEmptyImportString,
  writeFileAtomic,
} = await loadTodosSdkModule();

// Shared, behavior-identical value coercers are sourced from the SDK adapter
// surface; package-specific mappings (lenient timestamps, type-name resolution,
// confidence/enum coercion) stay local below.
const toNonEmptyString = toNonEmptyImportString;
const toEstimatedMinutes = toEstimatedMinutesValue;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function toInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

const toPriority: (value: unknown) => PriorityValue = toImportPriority;

function toConfidence(value: unknown): ItemMetadata["confidence"] | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized === "med") {
    return "medium";
  }
  if (CONFIDENCE_TEXT_VALUES.includes(normalized as (typeof CONFIDENCE_TEXT_VALUES)[number])) {
    return normalized as (typeof CONFIDENCE_TEXT_VALUES)[number];
  }
  const parsed = Number(normalized);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100) {
    return parsed;
  }
  return undefined;
}

function toNormalizedEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }
  const candidate = normalized === "med" ? "medium" : normalized;
  if (allowed.includes(candidate as T[number])) {
    return candidate as T[number];
  }
  return undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  return undefined;
}

const toTags = toImportTags;

function toLinkScope(value: unknown): "project" | "global" {
  return toNonEmptyString(value)?.toLowerCase() === "global" ? "global" : "project";
}

function toStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((entry) => toNonEmptyString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return entries.length > 0 ? entries : undefined;
}

function toStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, entryValue]) => [key.trim(), toNonEmptyString(entryValue)] as const)
    .filter((entry): entry is readonly [string, string] => entry[0].length > 0 && entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toNumberMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, entryValue]) => [key.trim(), toInteger(entryValue)] as const)
    .filter((entry): entry is readonly [string, number] => entry[0].length > 0 && entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toDependencyEntries(value: unknown, fallbackCreatedAt: string): ItemMetadata["dependencies"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const dependencies: NonNullable<ItemMetadata["dependencies"]> = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = toNonEmptyString(entry.id);
    if (!id) {
      continue;
    }
    const normalizedKind = toNonEmptyString(entry.kind)?.toLowerCase();
    const kind =
      normalizedKind && DEPENDENCY_KIND_VALUES.includes(normalizedKind as (typeof DEPENDENCY_KIND_VALUES)[number])
        ? (normalizedKind as (typeof DEPENDENCY_KIND_VALUES)[number])
        : "related";
    dependencies.push({
      id,
      kind,
      created_at: toIsoString(entry.created_at) ?? fallbackCreatedAt,
      author: toNonEmptyString(entry.author),
      source_kind: toNonEmptyString(entry.source_kind),
    });
  }
  return dependencies.length > 0 ? dependencies : undefined;
}

function toLogEntries(value: unknown, fallbackCreatedAt: string, fallbackAuthor: string): LogNote[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((entry) => {
      if (typeof entry === "string") {
        const text = toNonEmptyString(entry);
        return text
          ? {
              created_at: fallbackCreatedAt,
              author: fallbackAuthor,
              text,
            }
          : undefined;
      }
      if (!isRecord(entry)) {
        return undefined;
      }
      const text = toNonEmptyString(entry.text);
      if (!text) {
        return undefined;
      }
      return {
        created_at: toIsoString(entry.created_at) ?? fallbackCreatedAt,
        author: toNonEmptyString(entry.author) ?? fallbackAuthor,
        text,
      };
    })
    .filter((entry): entry is LogNote => entry !== undefined);
  return entries.length > 0 ? entries : undefined;
}

function toLinkedFiles(value: unknown): LinkedFile[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((entry) => {
      if (typeof entry === "string") {
        const filePath = toNonEmptyString(entry);
        return filePath ? { path: filePath, scope: "project" } : undefined;
      }
      if (!isRecord(entry)) {
        return undefined;
      }
      const filePath = toNonEmptyString(entry.path);
      if (!filePath) {
        return undefined;
      }
      return {
        path: filePath,
        scope: toLinkScope(entry.scope),
        note: toNonEmptyString(entry.note),
      };
    })
    .filter((entry): entry is LinkedFile => entry !== undefined);
  return entries.length > 0 ? entries : undefined;
}

function toLinkedDocs(value: unknown): LinkedDoc[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((entry) => {
      if (typeof entry === "string") {
        const docPath = toNonEmptyString(entry);
        return docPath ? { path: docPath, scope: "project" } : undefined;
      }
      if (!isRecord(entry)) {
        return undefined;
      }
      const docPath = toNonEmptyString(entry.path);
      if (!docPath) {
        return undefined;
      }
      return {
        path: docPath,
        scope: toLinkScope(entry.scope),
        note: toNonEmptyString(entry.note),
      };
    })
    .filter((entry): entry is LinkedDoc => entry !== undefined);
  return entries.length > 0 ? entries : undefined;
}

function toLinkedTests(value: unknown): LinkedTest[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: LinkedTest[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const command = toNonEmptyString(entry);
      if (command) {
        entries.push({ command, scope: "project" });
      }
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const command = toNonEmptyString(entry.command);
    const testPath = toNonEmptyString(entry.path);
    if (!command && !testPath) {
      continue;
    }
    const timeoutSeconds = toInteger(entry.timeout_seconds);
    const pmContextMode = toNormalizedEnum(entry.pm_context_mode, ["schema", "tracker", "auto"] as const);
    entries.push({
      command,
      path: testPath,
      scope: toLinkScope(entry.scope),
      timeout_seconds: timeoutSeconds !== undefined && timeoutSeconds > 0 ? timeoutSeconds : undefined,
      pm_context_mode: pmContextMode,
      env_set: toStringMap(entry.env_set),
      env_clear: toStringList(entry.env_clear),
      shared_host_safe: toBoolean(entry.shared_host_safe),
      assert_stdout_contains: toStringList(entry.assert_stdout_contains),
      assert_stdout_regex: toStringList(entry.assert_stdout_regex),
      assert_stderr_contains: toStringList(entry.assert_stderr_contains),
      assert_stderr_regex: toStringList(entry.assert_stderr_regex),
      assert_stdout_min_lines: toInteger(entry.assert_stdout_min_lines),
      assert_json_field_equals: toStringMap(entry.assert_json_field_equals),
      assert_json_field_gte: toNumberMap(entry.assert_json_field_gte),
      note: toNonEmptyString(entry.note),
    });
  }
  return entries.length > 0 ? entries : undefined;
}

function toItemType(value: unknown, typeNames: string[]): ItemType {
  const normalized = toNonEmptyString(value)?.toLowerCase();
  const fallbackType = typeNames.find((entry) => entry.toLowerCase() === "task") ?? typeNames[0] ?? "Task";
  if (!normalized) {
    return fallbackType;
  }
  for (const candidate of typeNames) {
    if (candidate.toLowerCase() === normalized) {
      return candidate;
    }
  }
  return fallbackType;
}

const toStatus: (value: unknown) => ItemStatus = toImportStatus;
const selectAuthor = selectImportAuthor;
const ensureInitHasRun = ensureTrackerInitialized;

function normalizeBody(body: string): string {
  return body.replace(/^\n+/, "").replace(/\s+$/, "");
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
  // splitFrontMatter only returns a non-empty block when content starts with "{",
  // so a successful JSON.parse here always yields an object; the guard below is a
  // defensive, unreachable branch.
  /* v8 ignore start */
  if (!isRecord(parsed)) {
    throw new TypeError("Front matter must be a JSON object");
  }
  /* v8 ignore stop */
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
  const type = toItemType(candidate.frontMatter.type, runtime.typeNames);
  const located = await locateItem(
    runtime.pmRoot,
    id,
    runtime.settings.id_prefix,
    runtime.settings.item_format,
    runtime.typeToFolder,
  );
  if (located) {
    return { warning: `todos_import_item_exists:${id}` };
  }
  const itemPath = getItemPath(runtime.pmRoot, type, id, "toon", runtime.typeToFolder);

  const afterDocument = canonicalDocument({
    metadata: normalizeFrontMatter({
      id,
      title,
      description: toNonEmptyString(candidate.frontMatter.description) ?? "",
      type,
      status: toStatus(candidate.frontMatter.status),
      priority: toPriority(candidate.frontMatter.priority),
      confidence: toConfidence(candidate.frontMatter.confidence),
      tags: toTags(candidate.frontMatter.tags),
      created_at: createdAt,
      updated_at: updatedAt,
      deadline: toIsoString(candidate.frontMatter.deadline),
      assignee: toNonEmptyString(candidate.frontMatter.assignee),
      author: toNonEmptyString(candidate.frontMatter.author) ?? runtime.author,
      estimated_minutes: toEstimatedMinutes(candidate.frontMatter.estimated_minutes),
      acceptance_criteria: toNonEmptyString(candidate.frontMatter.acceptance_criteria),
      definition_of_ready: toNonEmptyString(candidate.frontMatter.definition_of_ready),
      order: toInteger(candidate.frontMatter.order),
      goal: toNonEmptyString(candidate.frontMatter.goal),
      objective: toNonEmptyString(candidate.frontMatter.objective),
      value: toNonEmptyString(candidate.frontMatter.value),
      impact: toNonEmptyString(candidate.frontMatter.impact),
      outcome: toNonEmptyString(candidate.frontMatter.outcome),
      why_now: toNonEmptyString(candidate.frontMatter.why_now),
      parent: toNonEmptyString(candidate.frontMatter.parent),
      reviewer: toNonEmptyString(candidate.frontMatter.reviewer),
      risk: toNormalizedEnum(candidate.frontMatter.risk, RISK_VALUES),
      sprint: toNonEmptyString(candidate.frontMatter.sprint),
      release: toNonEmptyString(candidate.frontMatter.release),
      blocked_by: toNonEmptyString(candidate.frontMatter.blocked_by),
      blocked_reason: toNonEmptyString(candidate.frontMatter.blocked_reason),
      unblock_note: toNonEmptyString(candidate.frontMatter.unblock_note),
      reporter: toNonEmptyString(candidate.frontMatter.reporter),
      severity: toNormalizedEnum(candidate.frontMatter.severity, ISSUE_SEVERITY_VALUES),
      environment: toNonEmptyString(candidate.frontMatter.environment),
      repro_steps: toNonEmptyString(candidate.frontMatter.repro_steps),
      resolution: toNonEmptyString(candidate.frontMatter.resolution),
      expected_result: toNonEmptyString(candidate.frontMatter.expected_result),
      actual_result: toNonEmptyString(candidate.frontMatter.actual_result),
      affected_version: toNonEmptyString(candidate.frontMatter.affected_version),
      fixed_version: toNonEmptyString(candidate.frontMatter.fixed_version),
      component: toNonEmptyString(candidate.frontMatter.component),
      regression: toBoolean(candidate.frontMatter.regression),
      customer_impact: toNonEmptyString(candidate.frontMatter.customer_impact),
      close_reason: toNonEmptyString(candidate.frontMatter.close_reason),
      dependencies: toDependencyEntries(candidate.frontMatter.dependencies, createdAt),
      comments: toLogEntries(candidate.frontMatter.comments, createdAt, runtime.author),
      notes: toLogEntries(candidate.frontMatter.notes, createdAt, runtime.author),
      learnings: toLogEntries(candidate.frontMatter.learnings, createdAt, runtime.author),
      files: toLinkedFiles(candidate.frontMatter.files),
      docs: toLinkedDocs(candidate.frontMatter.docs),
      tests: toLinkedTests(candidate.frontMatter.tests),
    } as ItemMetadata),
    body: candidate.body,
  });

  const commit = await commitImportedItem({
    pmRoot: runtime.pmRoot,
    id,
    itemPath,
    document: afterDocument,
    author: runtime.author,
    message: runtime.message,
    settings: runtime.settings,
    conflictWarningPrefix: "todos_import_lock_conflict",
  });
  if (!commit.committed) {
    return { warning: commit.conflictWarning };
  }

  return { id, writeWarnings: commit.writeWarnings };
}

export async function runTodosImport(options: TodosImportOptions, global: GlobalOptions): Promise<TodosImportResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitHasRun(pmRoot);

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const folder = toNonEmptyString(options.folder) ?? DEFAULT_TODOS_FOLDER;
  const sourceFolder = resolveFolderPath(folder);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(sourceFolder, { withFileTypes: true });
  } catch {
    throw new PmCliError(
      `Todos source folder not found at ${sourceFolder}. Use --folder <path> to point at the directory of Todo markdown files.`,
      EXIT_CODE.NOT_FOUND,
    );
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
    typeNames: typeRegistry.types,
    typeToFolder: typeRegistry.type_to_folder,
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
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const folder = toNonEmptyString(options.folder) ?? DEFAULT_TODOS_FOLDER;
  const destinationFolder = resolveFolderPath(folder);
  await fs.mkdir(destinationFolder, { recursive: true });

  const warnings: string[] = [];
  const ids: string[] = [];
  let exported = 0;
  const items = await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder);
  const sorted = [...items].sort((left, right) => left.id.localeCompare(right.id));

  for (const item of sorted) {
    const located = await locateItem(pmRoot, item.id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
    if (!located) {
      warnings.push(`todos_export_missing_item:${item.id}`);
      continue;
    }

    try {
      const { document } = await readLocatedItem(located);
      const todoFrontMatter: Record<string, unknown> = { ...document.metadata };
      const frontMatter = JSON.stringify(todoFrontMatter, null, 2);
      const body = normalizeBody(document.body);
      const serialized = body.length > 0 ? `${frontMatter}\n\n${body}\n` : `${frontMatter}\n`;
      const exportPath = path.join(destinationFolder, `${document.metadata.id}.md`);
      await writeFileAtomic(exportPath, serialized);
      warnings.push(
        ...(await runActiveOnWriteHooks({
          path: exportPath,
          scope: "project",
          op: "todos:export",
        })),
      );
      ids.push(document.metadata.id);
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
