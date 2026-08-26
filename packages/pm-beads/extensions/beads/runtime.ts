/**
 * Runtime contracts and behavior for packages/pm beads/extensions/beads/runtime.
 *
 * @module packages/pm-beads/extensions/beads/runtime
 */
import fs from "node:fs/promises";
import path from "node:path";
import * as pmSdk from "@unbrained/pm-cli/sdk";
import type {
  Dependency,
  GlobalOptions,
  ItemStatus,
  ItemType,
  LogNote,
  PmSettings,
  StructuredJsonValue,
  ToImportLinkedArtifactsOptions,
  ToImportLinkedTestsOptions,
  ToImportLogEntriesOptions,
} from "@unbrained/pm-cli/sdk";

const PRIMARY_AUTO_DISCOVERY_FILES = [
  ".beads/issues.jsonl",
  "issues.jsonl",
] as const;

const UNSAFE_AUTO_DISCOVERY_FILES = [
  ".beads/sync_base.jsonl",
  "sync_base.jsonl",
] as const;

const AUTO_DISCOVERY_WARNINGS = new Map<string, string[]>([
  ["issues.jsonl", ["beads_import_source_autodiscovered:issues.jsonl"]],
]);

/** Inputs that customize the beads import operation. */
export interface BeadsImportOptions {
  /** Value that configures or reports file for this contract. */
  file?: string;
  /** Path to a complete `bd backup` JSONL directory. */
  backupDir?: string;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports preserve source ids for this contract. */
  preserveSourceIds?: boolean;
}

/** Structured result returned by the beads import operation. */
export interface BeadsImportResult {
  /** Whether the operation completed without a blocking failure. */
  ok: boolean;
  /** Value that configures or reports source for this contract. */
  source: string;
  /** Value that configures or reports imported for this contract. */
  imported: number;
  /** Value that configures or reports skipped for this contract. */
  skipped: number;
  /** Value that configures or reports ids for this contract. */
  ids: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Whether source and imported relational counts prove lossless parity. */
  complete?: boolean;
  /** Source rows counted across a portable backup. */
  source_counts?: BeadsPortableCounts;
  /** Rows attached to imported pm items from a portable backup. */
  imported_counts?: BeadsPortableCounts;
  /** Complete source-to-imported identity receipt when source IDs are preserved. */
  id_mapping?: BeadsIdMapping[];
}

/** Relational row counts carried by a Beads portable-backup receipt. */
export interface BeadsPortableCounts {
  /** Issue rows in `issues.jsonl`. */
  issues: number;
  /** Event rows in `events.jsonl`. */
  events: number;
  /** Comment rows in `comments.jsonl`. */
  comments: number;
  /** Dependency rows in `dependencies.jsonl`. */
  dependencies: number;
  /** Label rows in `labels.jsonl`. */
  labels: number;
}

/** One exact source-to-imported ID mapping. */
export interface BeadsIdMapping {
  /** Authoritative source identifier. */
  source_id: string;
  /** Identifier committed to pm storage. */
  imported_id: string;
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
  resolution?: unknown;
  expected_result?: unknown;
  actual_result?: unknown;
  parent?: unknown;
  comment_count?: unknown;
  source_events?: unknown;
  dependencies?: unknown;
  comments?: unknown;
  notes?: unknown;
  learnings?: unknown;
  files?: unknown;
  tests?: unknown;
  docs?: unknown;
}

interface BeadsImportRuntime {
  sdk: Pick<
    typeof pmSdk,
    | "canonicalDocument"
    | "commitImportedItem"
    | "generateItemId"
    | "getItemPath"
    | "listAllItemMetadataLight"
    | "locateItem"
    | "normalizeItemMetadata"
  >;
  pmRoot: string;
  settings: PmSettings;
  typeRegistry: ReturnType<typeof pmSdk.resolveItemTypeRegistry>;
  preserveSourceIds: boolean;
  author: string;
  message: string;
}

interface ResolvedBeadsSource {
  source: string;
  sourcePaths: string[];
  raw: string;
  warnings: string[];
  records?: BeadsRecord[];
  counts?: BeadsPortableCounts;
}

interface BeadsPortableBackupState {
  counts?: Partial<BeadsPortableCounts> & { config?: number };
}

type BeadsImportLineResult =
  | { id: string; writeWarnings: string[] }
  | { warning: string };
type ParsedBeadsLine = { record: BeadsRecord } | { warning: string } | null;

const {
  DEPENDENCY_KIND_VALUES,
  EXIT_CODE,
  PmCliError,
  ensureTrackerInitialized,
  getActiveExtensionRegistrations,
  isTimestampLiteral,
  normalizeItemId,
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
} = pmSdk;

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

function toDependencyKind(value: unknown): {
  kind: Dependency["kind"];
  sourceKind?: string;
} {
  const raw = toNonEmptyString(value);
  const normalized = raw?.toLowerCase();
  if (!normalized) {
    return { kind: "related" };
  }

  const preserveIfChanged = (
    kind: Dependency["kind"],
  ): { kind: Dependency["kind"]; sourceKind?: string } => ({
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

function normalizeImportedId(
  id: string,
  prefix: string,
  preserveSourceIds: boolean,
): string {
  return preserveSourceIds
    ? preserveBeadsSourceId(id)
    : normalizeItemId(id, prefix);
}

function preserveBeadsSourceId(id: string): string {
  if (
    id.length === 0 ||
    id !== id.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)
  ) {
    throw new PmCliError(
      `Beads source ID ${JSON.stringify(id)} cannot be preserved safely; IDs must contain only letters, digits, dots, underscores, and hyphens with no surrounding whitespace.`,
      EXIT_CODE.USAGE,
    );
  }
  return id;
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
    const dependency = toDependency(
      entry,
      fallbackCreatedAt,
      prefix,
      preserveSourceIds,
    );
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
    return toDependencyFromString(
      value,
      fallbackCreatedAt,
      prefix,
      preserveSourceIds,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const id =
    toNonEmptyString(candidate.id) ??
    toNonEmptyString(candidate.item_id) ??
    toNonEmptyString(candidate.depends_on_id);
  if (!id) {
    return undefined;
  }
  const dependencyKind = toDependencyKind(candidate.type ?? candidate.kind);
  return {
    id: normalizeImportedId(id, prefix, preserveSourceIds),
    kind: dependencyKind.kind,
    created_at: toIsoString(candidate.created_at) ?? fallbackCreatedAt,
    author:
      toNonEmptyString(candidate.author) ??
      toNonEmptyString(candidate.created_by),
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
  return path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(process.cwd(), rawPath);
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

async function resolveBeadsSource(
  rawPath: string | undefined,
  rawBackupDir: string | undefined,
): Promise<ResolvedBeadsSource> {
  const backupDir = toNonEmptyString(rawBackupDir);
  const explicitSource = toNonEmptyString(rawPath);
  if (backupDir && explicitSource) {
    throw new PmCliError(
      'Options "--file" and "--backup-dir" are mutually exclusive.',
      EXIT_CODE.USAGE,
    );
  }
  if (backupDir) {
    return resolvePortableBackup(backupDir);
  }
  if (explicitSource) {
    if (explicitSource === "-") {
      return {
        source: "-",
        sourcePaths: [],
        raw: await readStdin(),
        warnings: [],
      };
    }

    const explicitPath = resolveInputPath(explicitSource);
    if (!(await pathExists(explicitPath))) {
      throw new PmCliError(
        `Beads source file not found at ${explicitPath}`,
        EXIT_CODE.NOT_FOUND,
      );
    }
    return {
      source: explicitSource,
      sourcePaths: [explicitPath],
      raw: await fs.readFile(explicitPath, "utf8"),
      warnings: [],
    };
  }

  for (const candidate of PRIMARY_AUTO_DISCOVERY_FILES) {
    const candidatePath = resolveInputPath(candidate);
    if (await pathExists(candidatePath)) {
      return {
        source: candidate,
        sourcePaths: [candidatePath],
        raw: await fs.readFile(candidatePath, "utf8"),
        warnings: AUTO_DISCOVERY_WARNINGS.get(candidate) ?? [],
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

async function readPortableJsonl(
  backupPath: string,
  filename: string,
): Promise<{ path: string; records: Record<string, unknown>[] }> {
  const filePath = path.join(backupPath, filename);
  if (!(await pathExists(filePath))) {
    throw new PmCliError(
      `Beads portable backup is incomplete: missing ${filePath}. Run bd backup --force and pass its backup directory with --backup-dir.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const records: Record<string, unknown>[] = [];
  const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new PmCliError(
        `Beads portable backup contains invalid JSON in ${filename}:${index + 1}.`,
        EXIT_CODE.USAGE,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new PmCliError(
        `Beads portable backup contains a non-record row in ${filename}:${index + 1}.`,
        EXIT_CODE.USAGE,
      );
    }
    records.push(parsed as Record<string, unknown>);
  }
  return { path: filePath, records };
}

function portableRelationIssueId(
  record: Record<string, unknown>,
  filename: string,
): string {
  const issueId = toNonEmptyString(record.issue_id);
  if (!issueId) {
    throw new PmCliError(
      `Beads portable backup relation in ${filename} is missing issue_id.`,
      EXIT_CODE.USAGE,
    );
  }
  return issueId;
}

function attachPortableRelations(
  issues: BeadsRecord[],
  comments: Record<string, unknown>[],
  events: Record<string, unknown>[],
  dependencies: Record<string, unknown>[],
  labels: Record<string, unknown>[],
): void {
  const byId = new Map<string, BeadsRecord>();
  for (const issue of issues) {
    const id = toNonEmptyString(issue.id);
    if (!id) {
      throw new PmCliError(
        "Beads portable backup issue is missing id.",
        EXIT_CODE.USAGE,
      );
    }
    if (byId.has(id)) {
      throw new PmCliError(
        `Beads portable backup contains duplicate issue ID ${id}.`,
        EXIT_CODE.CONFLICT,
      );
    }
    if (!toNonEmptyString(issue.title)) {
      throw new PmCliError(
        `Beads portable backup issue ${id} is missing title.`,
        EXIT_CODE.USAGE,
      );
    }
    byId.set(id, issue);
  }
  attachPortableRelationRows(
    byId,
    comments,
    "comments.jsonl",
    "comments",
    (row, issueId) => {
      if (!toNonEmptyString(row.text)) {
        throw new PmCliError(
          `Beads portable backup comment for ${issueId} is missing text.`,
          EXIT_CODE.USAGE,
        );
      }
      return row;
    },
  );
  attachPortableRelationRows(
    byId,
    events,
    "events.jsonl",
    "source_events",
    (row, issueId) => {
      if (!toNonEmptyString(row.event_type)) {
        throw new PmCliError(
          `Beads portable backup event for ${issueId} is missing event_type.`,
          EXIT_CODE.USAGE,
        );
      }
      return row;
    },
  );
  attachPortableRelationRows(
    byId,
    dependencies,
    "dependencies.jsonl",
    "dependencies",
    (row, issueId) => {
      const targetId = toNonEmptyString(row.depends_on_id);
      if (!targetId) {
        throw new PmCliError(
          `Beads portable backup dependency for ${issueId} is missing depends_on_id.`,
          EXIT_CODE.USAGE,
        );
      }
      if (!byId.has(targetId)) {
        throw new PmCliError(
          `Beads portable backup dependency for ${issueId} references missing target ${targetId}.`,
          EXIT_CODE.CONFLICT,
        );
      }
      return row;
    },
  );
  attachPortableRelationRows(
    byId,
    labels,
    "labels.jsonl",
    "labels",
    (row, issueId) => {
      const label = toNonEmptyString(row.label);
      if (!label) {
        throw new PmCliError(
          `Beads portable backup label for ${issueId} is missing label.`,
          EXIT_CODE.USAGE,
        );
      }
      return label;
    },
  );
}

function attachPortableRelationRows(
  byId: ReadonlyMap<string, BeadsRecord>,
  rows: Record<string, unknown>[],
  filename: string,
  field: "comments" | "dependencies" | "labels" | "source_events",
  normalize: (row: Record<string, unknown>, issueId: string) => unknown,
): void {
  for (const row of rows) {
    const issueId = portableRelationIssueId(row, filename);
    const issue = byId.get(issueId);
    if (!issue) {
      throw new PmCliError(
        `Beads portable backup ${filename} references missing issue ${issueId}.`,
        EXIT_CODE.CONFLICT,
      );
    }
    const current = Array.isArray(issue[field]) ? issue[field] : [];
    issue[field] = [...current, normalize(row, issueId)];
  }
}

function verifyPortableCounts(
  expected: BeadsPortableBackupState["counts"],
  actual: BeadsPortableCounts,
): void {
  if (!expected) {
    throw new PmCliError(
      "Beads portable backup_state.json is missing counts.",
      EXIT_CODE.USAGE,
    );
  }
  for (const key of Object.keys(actual) as Array<keyof BeadsPortableCounts>) {
    if (expected[key] !== actual[key]) {
      throw new PmCliError(
        `Beads portable backup count mismatch for ${key}: backup_state=${String(expected[key])}, observed=${actual[key]}.`,
        EXIT_CODE.CONFLICT,
      );
    }
  }
}

async function resolvePortableBackup(
  rawBackupDir: string,
): Promise<ResolvedBeadsSource> {
  const backupPath = resolveInputPath(rawBackupDir);
  if (!(await pathExists(backupPath))) {
    throw new PmCliError(
      `Beads portable backup directory not found at ${backupPath}`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const [issuesFile, eventsFile, commentsFile, dependenciesFile, labelsFile] =
    await Promise.all([
      readPortableJsonl(backupPath, "issues.jsonl"),
      readPortableJsonl(backupPath, "events.jsonl"),
      readPortableJsonl(backupPath, "comments.jsonl"),
      readPortableJsonl(backupPath, "dependencies.jsonl"),
      readPortableJsonl(backupPath, "labels.jsonl"),
    ]);
  const statePath = path.join(backupPath, "backup_state.json");
  if (!(await pathExists(statePath))) {
    throw new PmCliError(
      `Beads portable backup is incomplete: missing ${statePath}.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  let state: BeadsPortableBackupState;
  try {
    state = JSON.parse(
      await fs.readFile(statePath, "utf8"),
    ) as BeadsPortableBackupState;
  } catch {
    throw new PmCliError(
      `Beads portable backup contains invalid JSON in ${statePath}.`,
      EXIT_CODE.USAGE,
    );
  }
  const records = issuesFile.records.map((record) => ({ ...record }));
  attachPortableRelations(
    records,
    commentsFile.records,
    eventsFile.records,
    dependenciesFile.records,
    labelsFile.records,
  );
  const counts: BeadsPortableCounts = {
    issues: records.length,
    events: eventsFile.records.length,
    comments: commentsFile.records.length,
    dependencies: dependenciesFile.records.length,
    labels: labelsFile.records.length,
  };
  verifyPortableCounts(state.counts, counts);
  return {
    source: backupPath,
    sourcePaths: [
      issuesFile.path,
      eventsFile.path,
      commentsFile.path,
      dependenciesFile.path,
      labelsFile.path,
      statePath,
    ],
    raw: "",
    warnings: [],
    records,
    counts,
  };
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

function parseBeadsRecords(source: ResolvedBeadsSource): {
  records: Array<{ record: BeadsRecord; lineNumber: number }>;
  warnings: string[];
  skipped: number;
} {
  if (source.records) {
    return {
      records: source.records.map((record, index) => ({
        record,
        lineNumber: index + 1,
      })),
      warnings: [],
      skipped: 0,
    };
  }
  const records: Array<{ record: BeadsRecord; lineNumber: number }> = [];
  const warnings: string[] = [];
  let skipped = 0;
  const lines = source.raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const parsed = parseBeadsLine(lines[index]!, lineNumber);
    if (!parsed) continue;
    if ("warning" in parsed) {
      warnings.push(parsed.warning);
      skipped += 1;
    } else {
      records.push({ record: parsed.record, lineNumber });
    }
  }
  return { records, warnings, skipped };
}

function assertLosslessSourceFormat(
  source: ResolvedBeadsSource,
  records: Array<{ record: BeadsRecord }>,
): void {
  if (
    source.counts === undefined &&
    records.some(({ record }) => Object.hasOwn(record, "comment_count"))
  ) {
    throw new PmCliError(
      "This Beads issue export advertises comment counts but omits the relational comment/event tables. Run `bd backup --force` and import the resulting directory with `pm beads import --backup-dir <path>`; no pm items were written.",
      EXIT_CODE.USAGE,
    );
  }
}

async function assertPreservedIdSafety(
  records: Array<{ record: BeadsRecord; lineNumber: number }>,
  runtime: BeadsImportRuntime,
): Promise<void> {
  if (!runtime.preserveSourceIds) return;
  const sourceByFoldedId = new Map<
    string,
    { id: string; lineNumber: number }
  >();
  for (const { record, lineNumber } of records) {
    if (typeof record.id !== "string" || record.id.trim().length === 0) {
      continue;
    }
    const id = preserveBeadsSourceId(record.id);
    const folded = id.toLocaleLowerCase("en-US");
    const previous = sourceByFoldedId.get(folded);
    if (previous) {
      throw new PmCliError(
        `Beads preserve-source-ids case-insensitive ID collision: ${previous.id} (line ${previous.lineNumber}) conflicts with ${id} (line ${lineNumber}); no pm items were written.`,
        EXIT_CODE.CONFLICT,
      );
    }
    sourceByFoldedId.set(folded, { id, lineNumber });
  }
  const existingItems = await runtime.sdk.listAllItemMetadataLight(
    runtime.pmRoot,
    runtime.settings.item_format,
    runtime.typeRegistry.type_to_folder,
  );
  const existingByFoldedId = new Map(
    existingItems.map(({ id }) => [id.toLocaleLowerCase("en-US"), id]),
  );
  for (const { id } of sourceByFoldedId.values()) {
    const existingId = existingByFoldedId.get(id.toLocaleLowerCase("en-US"));
    if (existingId) {
      throw new PmCliError(
        `Beads preserve-source-ids target collision: source ${id} conflicts case-insensitively with existing pm item ${existingId}; no pm items were written.`,
        EXIT_CODE.CONFLICT,
      );
    }
  }
}

function countImportedPortableRelations(
  records: Array<{ record: BeadsRecord }>,
  importedSourceIds: ReadonlySet<string>,
): BeadsPortableCounts {
  const importedRecords = records
    .map(({ record }) => record)
    .filter(
      (record) =>
        typeof record.id === "string" && importedSourceIds.has(record.id),
    );
  const count = (field: keyof BeadsRecord): number =>
    importedRecords.reduce(
      (total, record) =>
        total + (Array.isArray(record[field]) ? record[field].length : 0),
      0,
    );
  return {
    issues: importedRecords.length,
    events: count("source_events"),
    comments: count("comments"),
    dependencies: count("dependencies"),
    labels: count("labels"),
  };
}

async function resolveBeadsImportId(
  record: BeadsRecord,
  runtime: BeadsImportRuntime,
): Promise<string> {
  const rawId =
    typeof record.id === "string" && record.id.trim().length > 0
      ? record.id
      : undefined;
  return rawId
    ? normalizeImportedId(
        rawId,
        runtime.settings.id_prefix,
        runtime.preserveSourceIds,
      )
    : await runtime.sdk.generateItemId(
        runtime.pmRoot,
        runtime.settings.id_prefix,
      );
}

function toBeadsEventNotes(
  value: unknown,
  fallbackCreatedAt: string,
  fallbackAuthor: string,
): LogNote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LogNote[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const eventType = toNonEmptyString(record.event_type);
    if (!eventType) {
      return [];
    }
    const data = {
      source: "beads-portable-backup",
      ...record,
    } as Record<string, StructuredJsonValue>;
    return [
      {
        created_at: toIsoString(record.created_at) ?? fallbackCreatedAt,
        author: toNonEmptyString(record.actor) ?? fallbackAuthor,
        text: toNonEmptyString(record.comment) ?? eventType,
        format: "json",
        event_type: `beads:${eventType}`,
        data,
      },
    ];
  });
}

function collectBeadsNotes(
  record: BeadsRecord,
  createdAt: string,
  author: string,
): LogNote[] | undefined {
  const notes =
    toImportLogEntries(record.notes, {
      ...BEADS_LOG_ENTRY_OPTIONS,
      fallbackCreatedAt: createdAt,
      fallbackAuthor: author,
    }) ?? [];
  notes.push(...toBeadsEventNotes(record.source_events, createdAt, author));
  return notes.length > 0 ? notes : undefined;
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
    finalBody +=
      (finalBody ? "\n\n" : "") + "## External Reference\n" + externalRef;
  }
  return finalBody;
}

async function importBeadsRecord(
  record: BeadsRecord,
  lineNumber: number,
  runtime: BeadsImportRuntime,
): Promise<BeadsImportLineResult> {
  const title = toNonEmptyString(record.title);
  if (!title) {
    return { warning: `beads_import_missing_title:${lineNumber}` };
  }

  const id = await resolveBeadsImportId(record, runtime);
  const itemMetadata = buildBeadsItemMetadata(record, id, title, runtime);
  const afterDocument = runtime.sdk.canonicalDocument({
    metadata: itemMetadata,
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
  const itemPath = runtime.sdk.getItemPath(
    runtime.pmRoot,
    itemMetadata.type,
    id,
    "toon",
    runtime.typeRegistry.type_to_folder,
  );
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
  return commit.committed
    ? { id, writeWarnings: commit.writeWarnings }
    : { warning: commit.conflictWarning };
}

function buildBeadsItemMetadata(
  record: BeadsRecord,
  id: string,
  title: string,
  runtime: BeadsImportRuntime,
): ReturnType<typeof pmSdk.normalizeItemMetadata> {
  const createdAt = toIsoString(record.created_at) ?? nowIso();
  const updatedAt = toIsoString(record.updated_at) ?? createdAt;
  const typeMapping = toItemType(record.issue_type ?? record.type);
  const type = typeMapping.type;
  const status = toStatus(record.status);
  const closedAt = toIsoString(record.closed_at);
  const closeReason = toNonEmptyString(record.close_reason);
  const assignee =
    toNonEmptyString(record.assignee) ?? toNonEmptyString(record.owner);
  return runtime.sdk.normalizeItemMetadata({
    id,
    title,
    description: toNonEmptyString(record.description) ?? "",
    type,
    source_type: typeMapping.sourceType,
    status,
    priority: toPriority(record.priority),
    tags: toTags(record.tags ?? record.labels),
    created_at: createdAt,
    updated_at: updatedAt,
    deadline: toIsoString(record.due_at ?? record.deadline),
    closed_at: closedAt,
    assignee,
    source_owner: toNonEmptyString(record.owner),
    author:
      toNonEmptyString(record.author) ??
      toNonEmptyString(record.created_by) ??
      runtime.author,
    estimated_minutes: toEstimatedMinutes(record.estimated_minutes),
    acceptance_criteria: toNonEmptyString(record.acceptance_criteria),
    design: toNonEmptyString(record.design),
    external_ref: toNonEmptyString(record.external_ref),
    parent:
      typeof record.parent === "string" && record.parent.trim().length > 0
        ? normalizeImportedId(
            record.parent,
            runtime.settings.id_prefix,
            runtime.preserveSourceIds,
          )
        : undefined,
    close_reason: closeReason,
    resolution:
      toNonEmptyString(record.resolution) ??
      (status === "closed" || status === "canceled" ? closeReason : undefined),
    expected_result: toNonEmptyString(record.expected_result),
    actual_result: toNonEmptyString(record.actual_result),
    dependencies: toDependencies(
      record.dependencies,
      createdAt,
      runtime.settings.id_prefix,
      runtime.preserveSourceIds,
    ),
    comments: toImportLogEntries(record.comments, {
      ...BEADS_LOG_ENTRY_OPTIONS,
      fallbackCreatedAt: createdAt,
      fallbackAuthor: runtime.author,
    }),
    notes: collectBeadsNotes(record, createdAt, runtime.author),
    learnings: toImportLogEntries(record.learnings, {
      ...BEADS_LOG_ENTRY_OPTIONS,
      fallbackCreatedAt: createdAt,
      fallbackAuthor: runtime.author,
    }),
    files: toImportLinkedFiles(record.files, BEADS_FILE_OPTIONS),
    tests: toImportLinkedTests(record.tests, BEADS_TEST_OPTIONS),
    docs: toImportLinkedDocs(record.docs, BEADS_DOC_OPTIONS),
  });
}

/** Executes the beads import operation through the package runtime. */
export async function runBeadsImport(
  options: BeadsImportOptions,
  global: GlobalOptions,
): Promise<BeadsImportResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitHasRun(pmRoot);

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const preserveSourceIds = options.preserveSourceIds === true;
  const resolvedSource = await resolveBeadsSource(
    options.file,
    options.backupDir,
  );
  const {
    source,
    sourcePaths,
    warnings: sourceWarnings,
    counts: sourceCounts,
  } = resolvedSource;
  const warnings: string[] = [...sourceWarnings];
  for (const sourcePath of sourcePaths) {
    warnings.push(
      ...(await runActiveOnReadHooks({
        path: sourcePath,
        scope: "project",
      })),
    );
  }
  const parsed = parseBeadsRecords(resolvedSource);
  warnings.push(...parsed.warnings);
  assertLosslessSourceFormat(resolvedSource, parsed.records);
  const author = selectAuthor(
    toNonEmptyString(options.author),
    settings.author_default,
  );
  const message =
    toNonEmptyString(options.message) ?? "Import from Beads JSONL";
  const ids: string[] = [];
  const idMapping: BeadsIdMapping[] = [];
  const importedSourceIds = new Set<string>();
  let imported = 0;
  let skipped = parsed.skipped;
  const runtime: BeadsImportRuntime = {
    sdk: pmSdk,
    pmRoot,
    settings,
    typeRegistry,
    preserveSourceIds,
    author,
    message,
  };
  await assertPreservedIdSafety(parsed.records, runtime);

  for (const { record, lineNumber } of parsed.records) {
    const importedLine = await importBeadsRecord(record, lineNumber, runtime);
    if ("warning" in importedLine) {
      warnings.push(importedLine.warning);
      skipped += 1;
      continue;
    }
    warnings.push(...importedLine.writeWarnings);
    ids.push(importedLine.id);
    if (typeof record.id === "string" && record.id.trim().length > 0) {
      importedSourceIds.add(record.id);
      if (preserveSourceIds) {
        idMapping.push({
          source_id: record.id,
          imported_id: importedLine.id,
        });
      }
    }
    imported += 1;
  }

  const importedCounts = sourceCounts
    ? countImportedPortableRelations(parsed.records, importedSourceIds)
    : undefined;

  return {
    ok: true,
    source,
    imported,
    skipped,
    ids,
    warnings,
    ...(sourceCounts
      ? {
          complete:
            skipped === 0 &&
            Object.keys(sourceCounts).every(
              (key) =>
                sourceCounts[key as keyof BeadsPortableCounts] ===
                importedCounts?.[key as keyof BeadsPortableCounts],
            ),
          source_counts: sourceCounts,
          imported_counts: importedCounts,
        }
      : {}),
    ...(preserveSourceIds ? { id_mapping: idMapping } : {}),
  };
}
