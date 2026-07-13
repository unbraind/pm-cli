/**
 * @module sdk/files
 *
 * Implements the pm files command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import {
  locateItem,
  mutateItem,
  readLocatedItem,
} from "../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import { resolveAuthor } from "../core/shared/author.js";
import { isPathWithinDirectory } from "../core/fs/path-utils.js";
import type { ItemDocument, LinkedFile, LinkScope } from "../types/index.js";
import {
  dedupeLinkedArtifacts,
  normalizeLinkedPath,
  renameArtifactsResultKey,
  runLinkedArtifacts,
  sortLinkedArtifacts,
  type LinkedArtifactResult,
  type LinkedPathValidation,
} from "./linked-artifacts.js";

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
  projectRoot: string,
): Promise<Pick<LinkedFile, "path" | "scope"> | undefined> {
  const absolutePath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(projectRoot, rawPath);
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
    realpathForContainment(projectRoot),
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
  projectRoot: string,
): Promise<FilesDiscoveryCandidate[]> {
  const existingResolvedKeys = new Set(
    (document.metadata.files ?? []).map((entry) =>
      linkedFileResolvedKey(entry, projectRoot),
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
  const resolvedReferences = await Promise.all(
    rawReferences.map(async (reference) => ({
      reference,
      resolved: await resolveDiscoveredFile(reference.value, projectRoot),
    })),
  );
  for (const { reference, resolved } of resolvedReferences) {
    if (!resolved) {
      continue;
    }
    const key = linkedFileResolvedKey(resolved, projectRoot);
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

/** Implements run files discover for the public runtime surface of this module. */
export async function runFilesDiscover(
  id: string,
  options: FilesDiscoverOptions,
  global: GlobalOptions,
): Promise<FilesDiscoverResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
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
        next.map((entry) => linkedFileResolvedKey(entry, process.cwd())),
      );
      appliedAdds = [];
      for (const add of discoveredAdds) {
        const resolvedKey = linkedFileResolvedKey(add, process.cwd());
        /* c8 ignore next -- duplicate-key race paths are exercised in broader CLI race tests. */
        if (existingResolvedKeys.has(resolvedKey)) {
          continue;
        }
        next.push(add);
        existingResolvedKeys.add(resolvedKey);
        appliedAdds.push(add);
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
    appliedAdds.map((entry) => linkedFileResolvedKey(entry, process.cwd())),
  );
  const added = files.filter((entry) =>
    addedResolvedKeys.has(linkedFileResolvedKey(entry, process.cwd())),
  );
  const skippedDuringApplyKeys = new Set(
    discoveredAdds
      .filter(
        (entry) =>
          !addedResolvedKeys.has(linkedFileResolvedKey(entry, process.cwd())),
      )
      .map((entry) => linkedFileResolvedKey(entry, process.cwd())),
  );
  const skippedDuringApply = addableCandidates.filter((candidate) =>
    skippedDuringApplyKeys.has(linkedFileResolvedKey(candidate, process.cwd())),
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
