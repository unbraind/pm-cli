import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { isPathWithinDirectory } from "../../core/fs/path-utils.js";
import type { ItemDocument, LinkedFile, LinkScope } from "../../types/index.js";
import {
  dedupeLinkedArtifacts,
  normalizeLinkedPath,
  renameArtifactsResultKey,
  runLinkedArtifacts,
  sortLinkedArtifacts,
  type LinkedArtifactResult,
  type LinkedPathAuditEntry,
  type LinkedPathValidation,
} from "./linked-artifacts.js";

export interface FilesCommandOptions {
  add?: string[];
  addGlob?: string[];
  remove?: string[];
  migrate?: string[];
  list?: boolean;
  appendStable?: boolean;
  validatePaths?: boolean;
  audit?: boolean;
  author?: string;
  message?: string;
  force?: boolean;
}

export interface FilesDiscoverOptions {
  apply?: boolean;
  appendStable?: boolean;
  note?: string;
  author?: string;
  message?: string;
  force?: boolean;
}

export interface FilesDiscoveryCandidate {
  path: string;
  scope: LinkScope;
  status: "addable" | "already_linked";
  source_count: number;
  source_fields: string[];
  original_paths: string[];
}

export interface FilesResult {
  id: string;
  files: LinkedFile[];
  changed: boolean;
  count: number;
  migrations_applied?: number;
  validation?: LinkedPathValidation;
  audit?: LinkedPathAuditEntry[];
}

export interface FilesDiscoverResult {
  id: string;
  files: LinkedFile[];
  changed: boolean;
  apply: boolean;
  count: number;
  candidate_count: number;
  addable_count: number;
  added_count: number;
  skipped_existing_count: number;
  candidates: FilesDiscoveryCandidate[];
  added: LinkedFile[];
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

function linkedFileResolvedKey(linkedFile: Pick<LinkedFile, "path" | "scope">, projectRoot: string): string {
  const resolvedPath = path.isAbsolute(linkedFile.path)
    ? path.resolve(linkedFile.path)
    : path.resolve(projectRoot, linkedFile.path);
  return `${normalizeCandidatePathForOutput(resolvedPath)}::${linkedFile.scope}`;
}

function collectTextReferences(value: unknown, fieldPath: string, references: TextReference[]): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      references.push({ field: fieldPath, value: trimmed });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectTextReferences(entry, `${fieldPath}[${index}]`, references));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      collectTextReferences(nested, fieldPath ? `${fieldPath}.${key}` : key, references);
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

function extractRawPathReferences(references: TextReference[]): RawPathReference[] {
  const rawReferences: RawPathReference[] = [];
  const absolutePattern = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>()\[\]{},;]+/gu;
  const relativePattern =
    /(?:\.{1,2}[\\/])?(?:(?:[A-Za-z0-9_.@-]+[\\/])+[A-Za-z0-9_.@-]+|[A-Za-z0-9_.@-]+\.[A-Za-z0-9][A-Za-z0-9._-]*)/gu;
  for (const reference of references) {
    const seenInField = new Set<string>();
    for (const pattern of [absolutePattern, relativePattern]) {
      pattern.lastIndex = 0;
      for (const match of reference.value.matchAll(pattern)) {
        const token = cleanupPathToken(match[0] ?? "");
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
  const absolutePath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(projectRoot, rawPath);
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
    const relativePath = path.relative(canonicalProjectRoot, canonicalAbsolutePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
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

async function discoverReferencedFiles(document: ItemDocument, projectRoot: string): Promise<FilesDiscoveryCandidate[]> {
  const existingResolvedKeys = new Set((document.metadata.files ?? []).map((entry) => linkedFileResolvedKey(entry, projectRoot)));
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
  const rawReferences = extractRawPathReferences(collectItemTextReferences(document));
  for (const reference of rawReferences) {
    const resolved = await resolveDiscoveredFile(reference.value, projectRoot);
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
      status: existingResolvedKeys.has(key) ? ("already_linked" as const) : ("addable" as const),
      source_count: entry.sourceCount,
      source_fields: [...entry.sourceFields].sort((left, right) => left.localeCompare(right)),
      original_paths: [...entry.originalPaths].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => {
      const byStatus = left.status.localeCompare(right.status);
      if (byStatus !== 0) return byStatus;
      const byPath = left.path.localeCompare(right.path);
      if (byPath !== 0) return byPath;
      return left.scope.localeCompare(right.scope);
    });
}

export async function runFiles(id: string, options: FilesCommandOptions, global: GlobalOptions): Promise<FilesResult> {
  const result: LinkedArtifactResult = await runLinkedArtifacts(id, options, global, {
    metadataKey: "files",
    op: "files_add",
    bareNoun: "file",
    supportsAppendStable: true,
  });
  return renameArtifactsResultKey(result, "files") as unknown as FilesResult;
}

export async function runFilesDiscover(
  id: string,
  options: FilesDiscoverOptions,
  global: GlobalOptions,
): Promise<FilesDiscoverResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
  if (!located) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
  }
  const loaded = await readLocatedItem(located, { schema: settings.schema });
  const candidates = await discoverReferencedFiles(loaded.document, process.cwd());
  const addableCandidates = candidates.filter((candidate) => candidate.status === "addable");
  const skippedExisting = candidates.filter((candidate) => candidate.status === "already_linked");
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
      const existingResolvedKeys = new Set(next.map((entry) => linkedFileResolvedKey(entry, process.cwd())));
      const appliedAdds: LinkedFile[] = [];
      for (const add of discoveredAdds) {
        const resolvedKey = linkedFileResolvedKey(add, process.cwd());
        if (existingResolvedKeys.has(resolvedKey)) {
          continue;
        }
        next.push(add);
        existingResolvedKeys.add(resolvedKey);
        appliedAdds.push(add);
      }
      const deduped = dedupeLinkedArtifacts(next);
      const normalized = options.appendStable ? deduped : sortLinkedArtifacts(deduped);
      if (normalized.length > 0) {
        document.metadata.files = normalized;
      } else {
        delete document.metadata.files;
      }
      return {
        changedFields: appliedAdds.length > 0 ? ["files"] : [],
        warnings: appliedAdds.length !== discoveredAdds.length ? [`files_discover_skipped_existing:${discoveredAdds.length - appliedAdds.length}`] : [],
      };
    },
  });

  const files = result.item.files ?? [];
  const addedResolvedKeys = new Set(discoveredAdds.map((entry) => linkedFileResolvedKey(entry, process.cwd())));
  const added = files.filter((entry) => addedResolvedKeys.has(linkedFileResolvedKey(entry, process.cwd())));
  return {
    id: result.item.id,
    files,
    changed: added.length > 0,
    apply: true,
    count: files.length,
    candidate_count: candidates.length,
    addable_count: addableCandidates.length,
    added_count: added.length,
    skipped_existing_count: skippedExisting.length,
    candidates,
    added,
    skipped_existing: skippedExisting,
  };
}
