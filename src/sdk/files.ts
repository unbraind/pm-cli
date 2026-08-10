/**
 * @module sdk/files
 *
 * Implements the pm files command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../core/fs/fs-utils.js";
import {
  getActiveExtensionRegistrations,
  hasActiveOnReadHooks,
} from "../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import {
  locateItem,
  listAllItemMetadata,
  mutateItem,
  readLocatedItem,
} from "../core/store/item-store.js";
import { readItemMetadataDerivedIndexState } from "../core/store/item-metadata-cache.js";
import { queryLinkedFileMetadataIndex } from "../core/store/item-metadata-query-index.js";
import {
  getSettingsPath,
  resolvePmRoot,
  resolveWorkspaceRoot,
} from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import { resolveAuthor } from "../core/shared/author.js";
import { isPathWithinDirectory } from "../core/fs/path-utils.js";
import type {
  ItemDocument,
  ItemMetadata,
  LinkedFile,
  LinkScope,
} from "../types/index.js";
import {
  dedupeLinkedArtifacts,
  normalizeLinkedPath,
  renameArtifactsResultKey,
  runLinkedArtifacts,
  sortLinkedArtifacts,
  type LinkedArtifactResult,
  type LinkedPathValidation,
} from "./linked-artifacts.js";
import {
  explainSourceTraceability,
  type SourceLineRange,
  type SourceTraceabilityExplanation,
  type SourceTraceabilityReceipt,
} from "./traceability/source-traceability.js";

/** Documents the files command options payload exchanged by command, SDK, and package integrations. */
export interface FilesCommandOptions {
  /** Value that configures or reports add for this contract. */
  add?: string[];
  /** Value that configures or reports add glob for this contract. */
  addGlob?: string[];
  /** Value that configures or reports remove for this contract. */
  remove?: string[];
  /** Value that configures or reports migrate for this contract. */
  migrate?: string[];
  /** GH-170 (pm-pfnx): standalone note applied to every --add/--add-glob link in this invocation. */
  note?: string;
  /** Value that configures or reports list for this contract. */
  list?: boolean;
  /** Value that configures or reports append stable for this contract. */
  appendStable?: boolean;
  /** Value that configures or reports validate paths for this contract. */
  validatePaths?: boolean;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the files discover options payload exchanged by command, SDK, and package integrations. */
export interface FilesDiscoverOptions {
  /** Value that configures or reports apply for this contract. */
  apply?: boolean;
  /** Value that configures or reports append stable for this contract. */
  appendStable?: boolean;
  /** Value that configures or reports note for this contract. */
  note?: string;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the files discovery candidate payload exchanged by command, SDK, and package integrations. */
export interface FilesDiscoveryCandidate {
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports scope for this contract. */
  scope: LinkScope;
  /** Lifecycle state reported for status. */
  status: "addable" | "already_linked";
  /** Number of source entries represented by this result. */
  source_count: number;
  /** Value that configures or reports source fields for this contract. */
  source_fields: string[];
  /** Value that configures or reports original paths for this contract. */
  original_paths: string[];
}

/** Documents the files result payload exchanged by command, SDK, and package integrations. */
export interface FilesResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports files for this contract. */
  files: LinkedFile[];
  /** Value that configures or reports changed for this contract. */
  changed: boolean;
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Value that configures or reports migrations applied for this contract. */
  migrations_applied?: number;
  /** Value that configures or reports validation for this contract. */
  validation?: LinkedPathValidation;
}

/** Documents the files discover result payload exchanged by command, SDK, and package integrations. */
export interface FilesDiscoverResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports files for this contract. */
  files: LinkedFile[];
  /** Value that configures or reports changed for this contract. */
  changed: boolean;
  /** Value that configures or reports apply for this contract. */
  apply: boolean;
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Number of candidate entries represented by this result. */
  candidate_count: number;
  /** Number of addable entries represented by this result. */
  addable_count: number;
  /** Number of added entries represented by this result. */
  added_count: number;
  /** Number of skipped existing entries represented by this result. */
  skipped_existing_count: number;
  /** Value that configures or reports candidates for this contract. */
  candidates: FilesDiscoveryCandidate[];
  /** Value that configures or reports added for this contract. */
  added: LinkedFile[];
  /** Value that configures or reports skipped existing for this contract. */
  skipped_existing: FilesDiscoveryCandidate[];
}

/** Documents reverse linked-file lookup options shared by CLI, SDK, and MCP. */
export interface FilesLookupOptions {
  /** Project-relative or absolute source paths to resolve. */
  paths: string[];
  /** Restrict matches to one linked-file scope. */
  scope?: LinkScope;
  /** Maximum referencing items returned. */
  limit?: number;
  /** Number of ordered referencing items skipped. */
  offset?: number;
  /** Return every match instead of applying the default output bound. */
  noTruncate?: boolean;
  /** Fail when any authoritative item cannot be read. */
  strictRead?: boolean;
  /** Include rationale, governing-decision paths, and ambiguity receipts. */
  explain?: boolean;
  /** Optional inclusive line range; implies explain and requires one path. */
  lineRange?: SourceLineRange;
  /** Maximum relationship depth searched for a governing decision. */
  decisionDepth?: number;
}

/** Token-efficient item identity returned by reverse linked-file lookup. */
export interface FilesLookupItem {
  /** Stable item identifier. */
  id: string;
  /** Human-readable item title. */
  title: string;
  /** Item kind. */
  type: string;
  /** Lifecycle status. */
  status: string;
  /** Numeric scheduling priority. */
  priority: number;
  /** Last authoritative update timestamp. */
  updated_at: string;
}

/** One item and its exact file links that matched a reverse lookup. */
export interface FilesLookupMatch {
  /** Referencing item identity. */
  item: FilesLookupItem;
  /** Matching linked-file evidence. */
  files: LinkedFile[];
  /** Optional bounded rationale and line-attribution explanation. */
  traceability?: SourceTraceabilityExplanation;
}

/** Reverse linked-file lookup result with bounded output and read provenance. */
export interface FilesLookupResult {
  /** Normalized paths used for matching. */
  paths: string[];
  /** Total referencing items before pagination. */
  total: number;
  /** Number of matches in this page. */
  count: number;
  /** Zero-based page offset. */
  offset: number;
  /** Effective result limit, or null when unbounded. */
  limit: number | null;
  /** Whether more matches remain after this page. */
  has_more: boolean;
  /** Whether the current page is bounded below the total match count. */
  truncated: boolean;
  /** Read source and completeness receipt. */
  completeness: {
    status: "complete" | "partial" | "unchecked";
    source: "index" | "source_scan";
  };
  /** Non-fatal authoritative read warnings. */
  warnings: string[];
  /** Ordered reverse-traceability matches. */
  matches: FilesLookupMatch[];
  /** Aggregate receipt for an explained source query. */
  traceability_receipt?: SourceTraceabilityReceipt;
}

interface TextReference {
  field: string;
  value: string;
}

interface RawPathReference {
  field: string;
  value: string;
}

/** Bounds fuzzy relative-path scanning while preserving full absolute-path discovery. */
const RELATIVE_REFERENCE_SCAN_MAX_CHARS = 32_768;

function normalizeCandidatePathForOutput(value: string): string {
  return normalizeLinkedPath(path.normalize(value));
}

async function realpathForContainment(inputPath: string): Promise<string> {
  try {
    return await fs.realpath(inputPath);
  } catch {
    return path.resolve(inputPath);
  }
}

function linkedFileResolvedKey(
  linkedFile: Pick<LinkedFile, "path" | "scope">,
  projectRoot: string,
): string {
  const resolvedPath = path.isAbsolute(linkedFile.path)
    ? path.resolve(linkedFile.path)
    : path.resolve(projectRoot, linkedFile.path);
  return `${normalizeCandidatePathForOutput(resolvedPath)}::${linkedFile.scope}`;
}

function collectTextReferences(
  value: unknown,
  fieldPath: string,
  references: TextReference[],
): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      references.push({ field: fieldPath, value: trimmed });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectTextReferences(entry, `${fieldPath}[${index}]`, references),
    );
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      /* c8 ignore next -- root-level object traversal always carries a non-empty field path in current callers. */
      collectTextReferences(
        nested,
        fieldPath ? `${fieldPath}.${key}` : key,
        references,
      );
    }
  }
}

function collectItemTextReferences(document: ItemDocument): TextReference[] {
  const references: TextReference[] = [];
  collectTextReferences(document.metadata, "metadata", references);
  collectTextReferences(document.body, "body", references);
  return references;
}

function cleanupPathToken(value: string): string {
  let next = value.trim();
  next = next.replace(/^[`"'<([{]+/u, "");
  next = next.replace(/[`"'>)\]},;!?]+$/u, "");
  next = next.replace(/[.]+$/u, "");
  next = next.replace(/:(?:\d+)(?::\d+)?$/u, "");
  next = next.replace(/[.]+$/u, "");
  return next;
}

function extractRawPathReferences(
  references: TextReference[],
): RawPathReference[] {
  const rawReferences: RawPathReference[] = [];
  const absolutePattern = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>()[\]{},;]+/gu;
  const relativePattern =
    /(?:\.{1,2}[\\/])?(?:(?:[A-Za-z0-9_.@-]+[\\/])+[A-Za-z0-9_.@-]+|[A-Za-z0-9_.@-]+\.[A-Za-z0-9][A-Za-z0-9._-]*)/gu;
  for (const reference of references) {
    const seenInField = new Set<string>();
    const boundedRelativeValue = reference.value.slice(
      0,
      RELATIVE_REFERENCE_SCAN_MAX_CHARS,
    );
    for (const [pattern, input] of [
      [absolutePattern, reference.value],
      [relativePattern, boundedRelativeValue],
    ] as const) {
      pattern.lastIndex = 0;
      for (const match of input.matchAll(pattern)) {
        const token = cleanupPathToken(match[0]);
        if (!token || seenInField.has(token)) {
          continue;
        }
        seenInField.add(token);
        rawReferences.push({ field: reference.field, value: token });
      }
    }
  }
  return rawReferences;
}

async function resolveDiscoveredFile(
  rawPath: string,
  workspaceRoot: string,
  invocationRoot: string = workspaceRoot,
): Promise<Pick<LinkedFile, "path" | "scope"> | undefined> {
  const absolutePath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(invocationRoot, rawPath);
  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) {
    return undefined;
  }
  const [canonicalProjectRoot, canonicalAbsolutePath] = await Promise.all([
    realpathForContainment(workspaceRoot),
    realpathForContainment(absolutePath),
  ]);
  if (isPathWithinDirectory(canonicalProjectRoot, canonicalAbsolutePath)) {
    const relativePath = path.relative(
      canonicalProjectRoot,
      canonicalAbsolutePath,
    );
    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath)
    ) {
      return undefined;
    }
    return {
      path: normalizeCandidatePathForOutput(relativePath),
      scope: "project",
    };
  }
  return {
    path: normalizeCandidatePathForOutput(absolutePath),
    scope: "global",
  };
}

async function discoverReferencedFiles(
  document: ItemDocument,
  workspaceRoot: string,
  invocationRoot: string = workspaceRoot,
): Promise<FilesDiscoveryCandidate[]> {
  const existingResolvedKeys = new Set(
    (document.metadata.files ?? []).map((entry) =>
      linkedFileResolvedKey(entry, workspaceRoot),
    ),
  );
  const grouped = new Map<
    string,
    {
      path: string;
      scope: LinkScope;
      sourceFields: Set<string>;
      originalPaths: Set<string>;
      sourceCount: number;
    }
  >();
  const rawReferences = extractRawPathReferences(
    collectItemTextReferences(document),
  );
  const resolvedByValue = new Map<
    string,
    Pick<LinkedFile, "path" | "scope"> | undefined
  >();
  await Promise.all(
    [...new Set(rawReferences.map((reference) => reference.value))].map(
      async (value) => {
        resolvedByValue.set(
          value,
          await resolveDiscoveredFile(value, workspaceRoot, invocationRoot),
        );
      },
    ),
  );
  const resolvedReferences = rawReferences.map((reference) => ({
    reference,
    resolved: resolvedByValue.get(reference.value),
  }));
  for (const { reference, resolved } of resolvedReferences) {
    if (!resolved) {
      continue;
    }
    const key = linkedFileResolvedKey(resolved, workspaceRoot);
    const existing = grouped.get(key) ?? {
      path: resolved.path,
      scope: resolved.scope,
      sourceFields: new Set<string>(),
      originalPaths: new Set<string>(),
      sourceCount: 0,
    };
    existing.sourceFields.add(reference.field);
    existing.originalPaths.add(reference.value);
    existing.sourceCount += 1;
    grouped.set(key, existing);
  }
  return [...grouped.entries()]
    .map(([key, entry]) => ({
      path: entry.path,
      scope: entry.scope,
      status: existingResolvedKeys.has(key)
        ? ("already_linked" as const)
        : ("addable" as const),
      source_count: entry.sourceCount,
      source_fields: [...entry.sourceFields].sort((left, right) =>
        left.localeCompare(right),
      ),
      original_paths: [...entry.originalPaths].sort((left, right) =>
        left.localeCompare(right),
      ),
    }))
    .sort((left, right) => {
      const byStatus = left.status.localeCompare(right.status);
      if (byStatus !== 0) return byStatus;
      const byPath = left.path.localeCompare(right.path);
      if (byPath !== 0) return byPath;
      /* c8 ignore next -- path+status collisions are uncommon in deterministic fixtures. */
      return left.scope.localeCompare(right.scope);
    });
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  relativeReferenceScanMaxChars: RELATIVE_REFERENCE_SCAN_MAX_CHARS,
  normalizeCandidatePathForOutput,
  realpathForContainment,
  linkedFileResolvedKey,
  collectTextReferences,
  collectItemTextReferences,
  cleanupPathToken,
  extractRawPathReferences,
  resolveDiscoveredFile,
  discoverReferencedFiles,
};

/** Implements run files for the public runtime surface of this module. */
export async function runFiles(
  id: string,
  options: FilesCommandOptions,
  global: GlobalOptions,
): Promise<FilesResult> {
  const result: LinkedArtifactResult = await runLinkedArtifacts(
    id,
    options,
    global,
    {
      metadataKey: "files",
      op: "files_add",
      bareNoun: "file",
      supportsAppendStable: true,
    },
  );
  return renameArtifactsResultKey(result, "files");
}

async function normalizeFilesLookupPaths(
  values: readonly string[],
  workspaceRoot: string,
): Promise<string[]> {
  const canonicalWorkspaceRoot = await realpathForContainment(workspaceRoot);
  const paths = await Promise.all(
    values.map(async (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        throw new PmCliError(
          "Files lookup paths must not be empty.",
          EXIT_CODE.USAGE,
        );
      }
      if (!path.isAbsolute(trimmed)) return normalizeLinkedPath(trimmed);
      const canonicalAbsolutePath = await realpathForContainment(trimmed);
      return isPathWithinDirectory(
        canonicalWorkspaceRoot,
        canonicalAbsolutePath,
      )
        ? normalizeLinkedPath(
            path.relative(canonicalWorkspaceRoot, canonicalAbsolutePath),
          )
        : normalizeLinkedPath(canonicalAbsolutePath);
    }),
  );
  const uniquePaths = [...new Set(paths)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (uniquePaths.length === 0) {
    throw new PmCliError(
      "Files lookup requires at least one path.",
      EXIT_CODE.USAGE,
    );
  }
  return uniquePaths;
}

function resolveFilesLookupWindow(options: FilesLookupOptions): {
  offset: number;
  limit: number | undefined;
} {
  for (const [label, value] of [
    ["limit", options.limit],
    ["offset", options.offset],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new PmCliError(
        `Files lookup ${label} must be a non-negative integer.`,
        EXIT_CODE.USAGE,
      );
    }
  }
  const { offset = 0, limit = 50 } = options;
  return {
    offset: Math.max(0, Math.floor(offset)),
    limit: options.noTruncate ? undefined : Math.max(0, Math.floor(limit)),
  };
}

function projectFilesLookupItem(item: ItemMetadata): FilesLookupItem {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    priority: item.priority,
    updated_at: item.updated_at,
  };
}

interface FilesLookupCandidate {
  item: ItemMetadata;
  files: LinkedFile[];
}

function compareFilesLookupCandidates(
  left: FilesLookupCandidate,
  right: FilesLookupCandidate,
): number {
  const byPriority = left.item.priority - right.item.priority;
  if (byPriority !== 0) return byPriority;
  const byUpdated = right.item.updated_at.localeCompare(left.item.updated_at);
  return byUpdated === 0
    ? left.item.id.localeCompare(right.item.id)
    : byUpdated;
}

function matchingFilesLookupCandidates(params: {
  metadata: readonly ItemMetadata[];
  paths: readonly string[];
  scope: LinkScope | undefined;
}): FilesLookupCandidate[] {
  return params.metadata
    .map((item) => ({
      item,
      files: (item.files ?? [])
        .filter(
          (file) =>
            params.paths.includes(normalizeLinkedPath(file.path)) &&
            (params.scope === undefined || file.scope === params.scope),
        )
        .sort((left, right) => {
          const byPath = left.path.localeCompare(right.path);
          return byPath === 0 ? left.scope.localeCompare(right.scope) : byPath;
        }),
    }))
    .filter((match) => match.files.length > 0)
    .sort(compareFilesLookupCandidates);
}

async function resolveFilesLookupTraceability(params: {
  explain: boolean;
  workspaceRoot: string;
  paths: readonly string[];
  matching: readonly FilesLookupCandidate[];
  metadata: readonly ItemMetadata[];
  lineRange: SourceLineRange | undefined;
  decisionDepth: number | undefined;
}): Promise<Awaited<ReturnType<typeof explainSourceTraceability>> | undefined> {
  if (!params.explain) return undefined;
  return explainSourceTraceability({
    workspaceRoot: params.workspaceRoot,
    paths: params.paths,
    candidates: params.matching,
    corpus: params.metadata,
    ...(params.lineRange ? { lineRange: params.lineRange } : {}),
    ...(params.decisionDepth === undefined
      ? {}
      : { decisionDepth: params.decisionDepth }),
  });
}

async function queryFilesLookupIndex(params: {
  pmRoot: string;
  typeToFolder: Record<string, string>;
  paths: string[];
  scope: LinkScope | undefined;
  limit: number | undefined;
  offset: number;
  strictRead: boolean;
  noTruncate: boolean;
  explain: boolean;
}): Promise<Awaited<ReturnType<typeof queryLinkedFileMetadataIndex>>> {
  if (
    [
      params.strictRead,
      params.noTruncate,
      params.explain,
      hasActiveOnReadHooks(),
    ].includes(true)
  ) {
    return null;
  }
  const indexState = await readItemMetadataDerivedIndexState(params.pmRoot, [
    ...new Set(Object.values(params.typeToFolder)),
  ]);
  if (!indexState) return null;
  return queryLinkedFileMetadataIndex({
    pmRoot: params.pmRoot,
    expectedSourceCursor: indexState.source_cursor,
    paths: params.paths,
    scope: params.scope,
    limit: params.limit,
    offset: params.offset,
  });
}

async function queryFilesLookupSource(params: {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeToFolder: Record<string, string>;
  paths: string[];
  scope: LinkScope | undefined;
  limit: number | undefined;
  offset: number;
  strictRead: boolean;
  workspaceRoot: string;
  explain: boolean;
  lineRange: SourceLineRange | undefined;
  decisionDepth: number | undefined;
}): Promise<FilesLookupResult> {
  const warnings: string[] = [];
  const metadata = await listAllItemMetadata(
    params.pmRoot,
    params.settings.item_format,
    params.typeToFolder,
    warnings,
    params.settings.schema,
  );
  const matching = matchingFilesLookupCandidates({
    metadata,
    paths: params.paths,
    scope: params.scope,
  });
  const readWarnings = warnings.filter((warning) =>
    /^item_list_(?:item|directory)_read_failed:/u.test(warning),
  );
  if (params.strictRead && readWarnings.length > 0) {
    throw new PmCliError(
      `Files lookup could not read every item: ${readWarnings.join("; ")}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const traceability = await resolveFilesLookupTraceability({
    explain: params.explain,
    workspaceRoot: params.workspaceRoot,
    paths: params.paths,
    matching,
    metadata,
    lineRange: params.lineRange,
    decisionDepth: params.decisionDepth,
  });
  const ranked = traceability
    ? [...matching].sort((left, right) => {
        const byScore =
          traceability.explanations.get(right.item.id)!.score -
          traceability.explanations.get(left.item.id)!.score;
        if (byScore !== 0) return byScore;
        return compareFilesLookupCandidates(left, right);
      })
    : matching;
  const page = ranked.slice(
    params.offset,
    params.limit === undefined ? undefined : params.offset + params.limit,
  );
  return {
    paths: params.paths,
    total: matching.length,
    count: page.length,
    offset: params.offset,
    limit: params.limit ?? null,
    has_more: params.offset + page.length < matching.length,
    truncated: params.offset + page.length < matching.length,
    completeness: {
      status: readWarnings.length === 0 ? "complete" : "partial",
      source: "source_scan",
    },
    warnings,
    matches: page.map((match) => ({
      item: projectFilesLookupItem(match.item),
      files: match.files,
      ...(traceability
        ? { traceability: traceability.explanations.get(match.item.id)! }
        : {}),
    })),
    ...(traceability ? { traceability_receipt: traceability.receipt } : {}),
  };
}

/** Resolve the pm items that reference one or more source paths. */
export async function runFilesLookup(
  options: FilesLookupOptions,
  global: GlobalOptions,
): Promise<FilesLookupResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const workspaceRoot = resolveWorkspaceRoot(pmRoot);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const paths = await normalizeFilesLookupPaths(options.paths, workspaceRoot);
  if (options.lineRange && paths.length !== 1) {
    throw new PmCliError(
      "Files lookup line attribution requires exactly one source path.",
      EXIT_CODE.USAGE,
    );
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const { offset, limit } = resolveFilesLookupWindow(options);
  const indexed = await queryFilesLookupIndex({
    pmRoot,
    typeToFolder: typeRegistry.type_to_folder,
    paths,
    scope: options.scope,
    limit,
    offset,
    strictRead: options.strictRead === true,
    noTruncate: options.noTruncate === true,
    explain: options.explain === true || options.lineRange !== undefined,
  });
  if (indexed) {
    return {
      paths,
      total: indexed.total,
      count: indexed.matches.length,
      offset,
      limit: limit!,
      has_more: offset + indexed.matches.length < indexed.total,
      truncated: offset + indexed.matches.length < indexed.total,
      completeness: { status: "unchecked", source: "index" },
      warnings: [],
      matches: indexed.matches.map((match) => ({
        item: projectFilesLookupItem(match.item),
        files: match.files,
      })),
    };
  }
  return queryFilesLookupSource({
    pmRoot,
    settings,
    typeToFolder: typeRegistry.type_to_folder,
    paths,
    scope: options.scope,
    limit,
    offset,
    strictRead: options.strictRead === true,
    workspaceRoot,
    explain: options.explain === true || options.lineRange !== undefined,
    lineRange: options.lineRange,
    decisionDepth: options.decisionDepth,
  });
}

/** Implements run files discover for the public runtime surface of this module. */
export async function runFilesDiscover(
  id: string,
  options: FilesDiscoverOptions,
  global: GlobalOptions,
): Promise<FilesDiscoverResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const workspaceRoot = resolveWorkspaceRoot(pmRoot);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const located = await locateItem(
    pmRoot,
    id,
    settings.id_prefix,
    settings.item_format,
    typeRegistry.type_to_folder,
  );
  /* c8 ignore next -- not-found behavior is validated by CLI integration coverage. */
  if (!located) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
  }
  const loaded = await readLocatedItem(located, { schema: settings.schema });
  const candidates = await discoverReferencedFiles(
    loaded.document,
    workspaceRoot,
    process.cwd(),
  );
  const addableCandidates = candidates.filter(
    (candidate) => candidate.status === "addable",
  );
  const skippedExisting = candidates.filter(
    (candidate) => candidate.status === "already_linked",
  );
  const requestedApply = options.apply === true;
  const note = options.note?.trim() || "discovered from item text";

  if (!requestedApply || addableCandidates.length === 0) {
    const files = loaded.document.metadata.files ?? [];
    return {
      id: located.id,
      files,
      changed: false,
      apply: requestedApply,
      count: files.length,
      candidate_count: candidates.length,
      addable_count: addableCandidates.length,
      added_count: 0,
      skipped_existing_count: skippedExisting.length,
      candidates,
      added: [],
      skipped_existing: skippedExisting,
    };
  }

  const author = resolveAuthor(options.author, settings.author_default);
  const discoveredAdds: LinkedFile[] = addableCandidates.map((candidate) => ({
    path: candidate.path,
    scope: candidate.scope,
    note,
  }));
  let appliedAdds: LinkedFile[] = [];
  const appliedCandidateIndices = new Set<number>();
  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "files_discover",
    author,
    message: options.message ?? "Discover referenced file links",
    force: options.force,
    mutate(document) {
      const next = [...(document.metadata.files ?? [])];
      const existingResolvedKeys = new Set(
        next.map((entry) => linkedFileResolvedKey(entry, workspaceRoot)),
      );
      appliedAdds = [];
      appliedCandidateIndices.clear();
      for (const [index, add] of discoveredAdds.entries()) {
        const resolvedKey = linkedFileResolvedKey(add, workspaceRoot);
        /* c8 ignore next -- duplicate-key race paths are exercised in broader CLI race tests. */
        if (existingResolvedKeys.has(resolvedKey)) {
          continue;
        }
        next.push(add);
        existingResolvedKeys.add(resolvedKey);
        appliedAdds.push(add);
        appliedCandidateIndices.add(index);
      }
      const deduped = dedupeLinkedArtifacts(next);
      /* c8 ignore next -- appendStable branch is covered through runFiles command contract tests. */
      const normalized = options.appendStable
        ? deduped
        : sortLinkedArtifacts(deduped);
      if (normalized.length > 0) {
        document.metadata.files = normalized;
      } else {
        delete document.metadata.files;
      }
      return {
        /* c8 ignore next -- no-op mutation responses may emit empty changedFields for skipped discover batches. */
        changedFields: appliedAdds.length > 0 ? ["files"] : [],
        /* c8 ignore next -- warning emission is exercised by race-aware integration tests. */
        warnings:
          appliedAdds.length !== discoveredAdds.length
            ? [
                `files_discover_skipped_existing:${discoveredAdds.length - appliedAdds.length}`,
              ]
            : [],
      };
    },
  });

  const files = result.item.files ?? [];
  const addedResolvedKeys = new Set(
    appliedAdds.map((entry) => linkedFileResolvedKey(entry, workspaceRoot)),
  );
  const added = files.filter((entry) =>
    addedResolvedKeys.has(linkedFileResolvedKey(entry, workspaceRoot)),
  );
  const skippedDuringApply = addableCandidates.filter(
    (_candidate, index) => !appliedCandidateIndices.has(index),
  );
  const allSkippedExisting = [...skippedExisting, ...skippedDuringApply];
  return {
    id: result.item.id,
    files,
    changed: added.length > 0,
    apply: true,
    count: files.length,
    candidate_count: candidates.length,
    addable_count: addableCandidates.length,
    added_count: added.length,
    skipped_existing_count: allSkippedExisting.length,
    candidates,
    added,
    skipped_existing: allSkippedExisting,
  };
}
