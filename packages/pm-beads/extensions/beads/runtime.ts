import fs from "node:fs/promises";
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
  PmSettings,
  ToImportLinkedArtifactsOptions,
  ToImportLinkedTestsOptions,
  ToImportLogEntriesOptions,
} from "@unbrained/pm-cli/sdk";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const CURRENT_RUNTIME_ROOT = path.dirname(fileURLToPath(import.meta.url));
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

interface ActiveExtensionRegistrations {
  types?: unknown;
}

interface ItemTypeRegistry {
  types: string[];
  type_to_folder: Record<string, string>;
}

interface BeadsImportRuntime {
  sdk: BeadsSdkModule;
  pmRoot: string;
  settings: PmSettings;
  typeRegistry: ItemTypeRegistry;
  preserveSourceIds: boolean;
  author: string;
  message: string;
}

type BeadsImportLineResult = { id: string; writeWarnings: string[] } | { warning: string };
type ParsedBeadsLine = { record: BeadsRecord } | { warning: string } | null;

interface BeadsSdkModule {
  DEPENDENCY_KIND_VALUES: readonly Dependency["kind"][];
  EXIT_CODE: {
    NOT_FOUND: number;
    USAGE: number;
  };
  PmCliError: new (message: string, exitCode?: number) => Error;
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
  isTimestampLiteral: (value: string) => boolean;
  locateItem: (
    pmRoot: string,
    id: string,
    prefix: string,
    itemFormat: PmSettings["item_format"],
    typeToFolder: Record<string, string>,
  ) => Promise<unknown>;
  normalizeFrontMatter: (frontMatter: Partial<ItemMetadata>) => ItemMetadata;
  normalizeItemId: (id: string, prefix: string) => string;
  normalizeRawItemId: (id: string) => string;
  nowIso: () => string;
  pathExists: (targetPath: string) => Promise<boolean>;
  readSettings: (pmRoot: string) => Promise<PmSettings>;
  resolveItemTypeRegistry: (
    settings: PmSettings,
    registrations: ActiveExtensionRegistrations | null,
  ) => ItemTypeRegistry;
  resolvePmRoot: (cwd: string, overridePath?: string) => string;
  runActiveOnReadHooks: (context: { path: string; scope: "project" | "global" }) => Promise<string[]>;
  selectImportAuthor: (explicitAuthor: string | undefined, settingsAuthor: string) => string;
  toEstimatedMinutesValue: (value: unknown) => number | undefined;
  toImportLinkedDocs: (value: unknown, options?: ToImportLinkedArtifactsOptions) => ItemMetadata["docs"];
  toImportLinkedFiles: (value: unknown, options?: ToImportLinkedArtifactsOptions) => ItemMetadata["files"];
  toImportLinkedTests: (value: unknown, options?: ToImportLinkedTestsOptions) => ItemMetadata["tests"];
  toImportLogEntries: (value: unknown, options: ToImportLogEntriesOptions) => ItemMetadata["comments"];
  toImportPriority: (value: unknown) => 0 | 1 | 2 | 3 | 4;
  toImportStatus: (value: unknown) => ItemStatus;
  toImportTags: (value: unknown) => string[];
  toNonEmptyImportString: (value: unknown) => string | undefined;
}

const BEADS_SDK_ARRAY_EXPORTS = [
  "DEPENDENCY_KIND_VALUES",
] as const satisfies readonly (keyof BeadsSdkModule)[];

const BEADS_SDK_FUNCTION_EXPORTS = [
  "PmCliError",
  "canonicalDocument",
  "commitImportedItem",
  "ensureTrackerInitialized",
  "generateItemId",
  "getActiveExtensionRegistrations",
  "getItemPath",
  "isTimestampLiteral",
  "locateItem",
  "normalizeFrontMatter",
  "normalizeItemId",
  "normalizeRawItemId",
  "nowIso",
  "pathExists",
  "readSettings",
  "resolveItemTypeRegistry",
  "resolvePmRoot",
  "runActiveOnReadHooks",
  "selectImportAuthor",
  "toEstimatedMinutesValue",
  "toImportLinkedDocs",
  "toImportLinkedFiles",
  "toImportLinkedTests",
  "toImportLogEntries",
  "toImportPriority",
  "toImportStatus",
  "toImportTags",
  "toNonEmptyImportString",
] as const satisfies readonly (keyof BeadsSdkModule)[];

function resolveBeadsSdkModulePath(): string {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  const hasConfiguredPackageRoot = typeof envRoot === "string" && envRoot.trim().length > 0;
  const packageRoot = hasConfiguredPackageRoot ? path.resolve(envRoot.trim()) : path.resolve(CURRENT_RUNTIME_ROOT, "../../../..");
  return hasConfiguredPackageRoot
    ? path.join(packageRoot, "dist", "sdk", "index.js")
    : path.join(packageRoot, "src", "sdk", "index.ts");
}

function hasBeadsSdkArrayExports(loaded: Partial<BeadsSdkModule>): boolean {
  return BEADS_SDK_ARRAY_EXPORTS.every((key) => Array.isArray(loaded[key]));
}

function hasBeadsSdkFunctionExports(loaded: Partial<BeadsSdkModule>): boolean {
  return BEADS_SDK_FUNCTION_EXPORTS.every((key) => typeof loaded[key] === "function");
}

function hasBeadsSdkExitCodeExports(loaded: Partial<BeadsSdkModule>): boolean {
  return (
    typeof loaded.EXIT_CODE === "object" &&
    loaded.EXIT_CODE !== null &&
    typeof loaded.EXIT_CODE.NOT_FOUND === "number" &&
    typeof loaded.EXIT_CODE.USAGE === "number"
  );
}

function isBeadsSdkModule(loaded: Partial<BeadsSdkModule>): loaded is BeadsSdkModule {
  return hasBeadsSdkArrayExports(loaded) && hasBeadsSdkFunctionExports(loaded) && hasBeadsSdkExitCodeExports(loaded);
}

async function loadBeadsSdkModule(): Promise<BeadsSdkModule> {
  const modulePath = resolveBeadsSdkModulePath();
  try {
    const loaded = (await import(pathToFileURL(modulePath).href)) as Partial<BeadsSdkModule>;
    if (isBeadsSdkModule(loaded)) {
      return loaded;
    }
  } catch (error: unknown) {
    throw new Error(`builtin-beads failed to load SDK exports from ${modulePath}.`, { cause: error });
  }
  throw new Error(`builtin-beads failed to load SDK exports from ${modulePath}.`);
}

const beadsSdk = await loadBeadsSdkModule();

const {
  DEPENDENCY_KIND_VALUES,
  EXIT_CODE,
  PmCliError,
  ensureTrackerInitialized,
  getActiveExtensionRegistrations,
  isTimestampLiteral,
  normalizeItemId,
  normalizeRawItemId,
  nowIso,
  pathExists,
  readSettings,
  resolveItemTypeRegistry,
  resolvePmRoot,
  runActiveOnReadHooks,
  selectImportAuthor,
  toEstimatedMinutesValue,
  toImportLinkedDocs,
  toImportLinkedFiles,
  toImportLinkedTests,
  toImportLogEntries,
  toImportPriority,
  toImportStatus,
  toImportTags,
  toNonEmptyImportString,
} = beadsSdk;

// Shared, behavior-identical value coercers are sourced from the SDK adapter
// surface; package-specific mappings (timestamps, item types, dependencies,
// linked artifacts) stay local below.
const toNonEmptyString = toNonEmptyImportString;
const toEstimatedMinutes = toEstimatedMinutesValue;
const toPriority = toImportPriority;
const toTags = toImportTags;

const BEADS_DEPENDENCY_KIND_ALIASES = new Map<string, Dependency["kind"]>([
  ["parent-child", "parent_child"],
  ["child-of", "child_of"],
  ["related-to", "related_to"],
  ["relates-to", "related_to"],
  ["discovered-from", "discovered_from"],
  ["blocked-by", "blocked_by"],
  ["incident-from", "incident_from"],
]);

const BEADS_LOG_ENTRY_OPTIONS = {
  allowScalar: true,
  textKeys: ["text", "comment", "note", "learning"],
  toIsoString,
} satisfies Partial<ToImportLogEntriesOptions>;

const BEADS_FILE_OPTIONS = {
  allowScalar: true,
  pathKeys: ["path", "file"],
} satisfies ToImportLinkedArtifactsOptions;

const BEADS_DOC_OPTIONS = {
  allowScalar: true,
  pathKeys: ["path", "doc"],
} satisfies ToImportLinkedArtifactsOptions;

const BEADS_TEST_OPTIONS = {
  allowScalar: true,
  commandKeys: ["command", "test"],
  requireCommand: true,
  integerTimeout: true,
  timeoutMinimum: 0,
  timeoutExclusiveMinimum: true,
} satisfies ToImportLinkedTestsOptions;

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

const toStatus: (value: unknown) => ItemStatus = toImportStatus;

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

  const aliasKind = BEADS_DEPENDENCY_KIND_ALIASES.get(normalized);
  if (aliasKind) {
    return preserveIfChanged(aliasKind);
  }

  return {
    kind: "related",
    sourceKind: raw,
  };
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
    const dependency = toDependency(entry, fallbackCreatedAt, prefix, preserveSourceIds);
    if (dependency) dependencies.push(dependency);
  }

  return dependencies.length > 0 ? dependencies : undefined;
}

function toDependency(
  value: unknown,
  fallbackCreatedAt: string,
  prefix: string,
  preserveSourceIds: boolean,
): Dependency | undefined {
  if (typeof value === "string") {
    return toDependencyFromString(value, fallbackCreatedAt, prefix, preserveSourceIds);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const id = toNonEmptyString(candidate.id) ?? toNonEmptyString(candidate.item_id) ?? toNonEmptyString(candidate.depends_on_id);
  if (!id) {
    return undefined;
  }
  const dependencyKind = toDependencyKind(candidate.type ?? candidate.kind);
  return {
    id: normalizeImportedId(id, prefix, preserveSourceIds),
    kind: dependencyKind.kind,
    created_at: toIsoString(candidate.created_at) ?? fallbackCreatedAt,
    author: toNonEmptyString(candidate.author) ?? toNonEmptyString(candidate.created_by),
    source_kind: dependencyKind.sourceKind,
  };
}

function toDependencyFromString(
  value: string,
  fallbackCreatedAt: string,
  prefix: string,
  preserveSourceIds: boolean,
): Dependency | undefined {
  const id = toNonEmptyString(value);
  if (!id) {
    return undefined;
  }
  return {
    id: normalizeImportedId(id, prefix, preserveSourceIds),
    kind: "related",
    created_at: fallbackCreatedAt,
  };
}

const selectAuthor = selectImportAuthor;
const ensureInitHasRun = ensureTrackerInitialized;

function resolveInputPath(rawPath: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw new PmCliError(
      '--file value "-" requires piped stdin input. Pipe JSONL content into the command, or end manual stdin with Ctrl+D (Unix/macOS) or Ctrl+Z then Enter (Windows).',
      EXIT_CODE.USAGE,
    );
  }
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

function parseBeadsLine(line: string, lineNumber: number): ParsedBeadsLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { warning: `beads_import_invalid_jsonl_line:${lineNumber}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { warning: `beads_import_invalid_record:${lineNumber}` };
  }
  return { record: parsed as BeadsRecord };
}

async function resolveBeadsImportId(record: BeadsRecord, runtime: BeadsImportRuntime): Promise<string> {
  const rawId = toNonEmptyString(record.id);
  return rawId
    ? normalizeImportedId(rawId, runtime.settings.id_prefix, runtime.preserveSourceIds)
    : await runtime.sdk.generateItemId(runtime.pmRoot, runtime.settings.id_prefix);
}

function buildBeadsImportedBody(record: BeadsRecord): string {
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
  return finalBody;
}

async function importBeadsRecord(record: BeadsRecord, lineNumber: number, runtime: BeadsImportRuntime): Promise<BeadsImportLineResult> {
  const title = toNonEmptyString(record.title);
  if (!title) {
    return { warning: `beads_import_missing_title:${lineNumber}` };
  }

  const createdAt = toIsoString(record.created_at) ?? nowIso();
  const updatedAt = toIsoString(record.updated_at) ?? createdAt;
  const id = await resolveBeadsImportId(record, runtime);
  const typeMapping = toItemType(record.issue_type ?? record.type);
  const type = typeMapping.type;
  const closedAt = toIsoString(record.closed_at);
  const assignee = toNonEmptyString(record.assignee) ?? toNonEmptyString(record.owner);
  const frontMatter = runtime.sdk.normalizeFrontMatter({
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
    author: toNonEmptyString(record.author) ?? toNonEmptyString(record.created_by) ?? runtime.author,
    estimated_minutes: toEstimatedMinutes(record.estimated_minutes),
    acceptance_criteria: toNonEmptyString(record.acceptance_criteria),
    design: toNonEmptyString(record.design),
    external_ref: toNonEmptyString(record.external_ref),
    close_reason: toNonEmptyString(record.close_reason),
    dependencies: toDependencies(record.dependencies, createdAt, runtime.settings.id_prefix, runtime.preserveSourceIds),
    comments: toImportLogEntries(record.comments, {
      ...BEADS_LOG_ENTRY_OPTIONS,
      fallbackCreatedAt: createdAt,
      fallbackAuthor: runtime.author,
    }),
    notes: toImportLogEntries(record.notes, {
      ...BEADS_LOG_ENTRY_OPTIONS,
      fallbackCreatedAt: createdAt,
      fallbackAuthor: runtime.author,
    }),
    learnings: toImportLogEntries(record.learnings, {
      ...BEADS_LOG_ENTRY_OPTIONS,
      fallbackCreatedAt: createdAt,
      fallbackAuthor: runtime.author,
    }),
    files: toImportLinkedFiles(record.files, BEADS_FILE_OPTIONS),
    tests: toImportLinkedTests(record.tests, BEADS_TEST_OPTIONS),
    docs: toImportLinkedDocs(record.docs, BEADS_DOC_OPTIONS),
  });
  const afterDocument = runtime.sdk.canonicalDocument({
    metadata: frontMatter,
    body: buildBeadsImportedBody(record),
  });
  const existing = await runtime.sdk.locateItem(
    runtime.pmRoot,
    id,
    runtime.settings.id_prefix,
    runtime.settings.item_format,
    runtime.typeRegistry.type_to_folder,
  );
  if (existing) {
    return { warning: `beads_import_item_exists:${id}` };
  }
  const itemPath = runtime.sdk.getItemPath(runtime.pmRoot, type, id, "toon", runtime.typeRegistry.type_to_folder);
  const commit = await runtime.sdk.commitImportedItem({
    pmRoot: runtime.pmRoot,
    id,
    itemPath,
    document: afterDocument,
    author: runtime.author,
    message: runtime.message,
    settings: runtime.settings,
    conflictWarningPrefix: "beads_import_lock_conflict",
  });
  return commit.committed ? { id, writeWarnings: commit.writeWarnings } : { warning: commit.conflictWarning };
}

export async function runBeadsImport(options: BeadsImportOptions, global: GlobalOptions): Promise<BeadsImportResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitHasRun(pmRoot);

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
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
  const runtime: BeadsImportRuntime = {
    sdk: beadsSdk,
    pmRoot,
    settings,
    typeRegistry,
    preserveSourceIds,
    author,
    message,
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const parsed = parseBeadsLine(lines[index], lineNumber);
    if (!parsed) {
      continue;
    }
    if ("warning" in parsed) {
      warnings.push(parsed.warning);
      skipped += 1;
      continue;
    }
    const importedLine = await importBeadsRecord(parsed.record, lineNumber, runtime);
    if ("warning" in importedLine) {
      warnings.push(importedLine.warning);
      skipped += 1;
      continue;
    }
    warnings.push(...importedLine.writeWarnings);
    ids.push(importedLine.id);
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
