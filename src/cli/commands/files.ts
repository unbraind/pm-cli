import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { createStdinTokenResolver, parseCsvKv } from "../../core/item/parse.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { listAllFrontMatter, locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { SCOPE_VALUES } from "../../types/index.js";
import type { ItemDocument, LinkedFile, LinkScope } from "../../types/index.js";

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

interface PathMigration {
  from: string;
  to: string;
}

interface AddGlobEntry {
  pattern: string;
  scope: LinkScope;
  note?: string;
}

interface LinkedPathValidation {
  checked: number;
  existing_files: string[];
  missing_paths: string[];
  non_file_paths: string[];
}

interface LinkedPathAuditEntry {
  path: string;
  linked_by_count: number;
  linked_item_ids: string[];
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

function resolveAuthor(candidate: string | undefined, fallback: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? fallback;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function ensureScope(raw: string | undefined): LinkScope {
  const value = (raw ?? "project") as LinkScope;
  if (!SCOPE_VALUES.includes(value)) {
    throw new PmCliError(`Invalid scope "${raw}"`, EXIT_CODE.USAGE);
  }
  return value;
}

function looksLikeStructuredPathEntry(raw: string): boolean {
  if (raw.startsWith("```") || raw.includes("\n")) {
    return true;
  }
  return /^(?:[-*+]\s+)?(?:path|scope|note)\s*[:=]/i.test(raw);
}

function parseAddEntries(raw: string[] | undefined): LinkedFile[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const trimmed = entry.trim();
    const kv = looksLikeStructuredPathEntry(trimmed) ? parseCsvKv(entry, "--add") : { path: trimmed };
    if (!kv.path) {
      throw new PmCliError("--add requires path=<value> or a bare file path", EXIT_CODE.USAGE);
    }
    return {
      path: kv.path,
      scope: ensureScope(kv.scope),
      note: kv.note?.trim() || undefined,
    };
  });
}

function parseAddGlobEntries(raw: string[] | undefined): AddGlobEntry[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new PmCliError("--add-glob requires a glob pattern value", EXIT_CODE.USAGE);
    }
    if (trimmed.includes("=") || /^(?:[-*+]\s+)?(?:pattern|glob|path)\s*[:=]/i.test(trimmed) || trimmed.startsWith("```")) {
      const kv = parseCsvKv(trimmed, "--add-glob");
      const pattern = kv.pattern?.trim() || kv.glob?.trim() || kv.path?.trim();
      if (!pattern) {
        throw new PmCliError("--add-glob key/value form requires pattern=<glob>", EXIT_CODE.USAGE);
      }
      return {
        pattern,
        scope: ensureScope(kv.scope),
        note: kv.note?.trim() || undefined,
      };
    }
    return {
      pattern: trimmed,
      scope: "project",
    };
  });
}

function parseRemoveEntries(raw: string[] | undefined): string[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new PmCliError("--remove requires a path value", EXIT_CODE.USAGE);
    }
    if (trimmed.includes("=") || /^(?:[-*+]\s+)?path\s*[:=]/i.test(trimmed) || trimmed.startsWith("```")) {
      const kv = parseCsvKv(trimmed, "--remove");
      if (!kv.path) {
        throw new PmCliError("--remove key/value form requires path=<value>", EXIT_CODE.USAGE);
      }
      return kv.path;
    }
    return trimmed;
  });
}

function parseMigrateEntries(raw: string[] | undefined): PathMigration[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const kv = parseCsvKv(entry, "--migrate");
    const from = kv.from?.trim();
    const to = kv.to?.trim();
    if (!from || !to) {
      throw new PmCliError("--migrate requires from=<value> and to=<value>", EXIT_CODE.USAGE);
    }
    return { from, to };
  });
}

function applyPathMigrations(filePath: string, migrations: PathMigration[]): string {
  let next = filePath;
  for (const migration of migrations) {
    if (next.startsWith(migration.from)) {
      next = `${migration.to}${next.slice(migration.from.length)}`;
    }
  }
  return next;
}

function normalizeLinkedPath(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizeCandidatePathForOutput(value: string): string {
  return normalizeLinkedPath(path.normalize(value));
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

async function expandAddGlobEntries(entries: AddGlobEntry[]): Promise<LinkedFile[]> {
  const expanded: LinkedFile[] = [];
  for (const entry of entries) {
    const absolutePattern = path.isAbsolute(entry.pattern);
    const matches = await fg(entry.pattern, {
      cwd: process.cwd(),
      absolute: absolutePattern,
      onlyFiles: true,
      dot: true,
      unique: true,
      followSymbolicLinks: true,
    });
    const sortedMatches = [...new Set(matches.map((match) => normalizeLinkedPath(path.normalize(match))))].sort((left, right) =>
      left.localeCompare(right),
    );
    for (const matchedPath of sortedMatches) {
      expanded.push({
        path: matchedPath,
        scope: entry.scope,
        note: entry.note,
      });
    }
  }
  return expanded;
}

function fileKey(value: Pick<LinkedFile, "path" | "scope">): string {
  return `${value.path}::${value.scope}`;
}

function sortLinkedFiles(files: LinkedFile[]): LinkedFile[] {
  return [...files].sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    if (byPath !== 0) return byPath;
    return left.scope.localeCompare(right.scope);
  });
}

function dedupeLinkedFiles(files: LinkedFile[]): LinkedFile[] {
  return [...new Map(files.map((entry) => [fileKey(entry), entry])).values()].map((entry) => ({
    ...entry,
    note: entry.note?.trim() || undefined,
  }));
}

async function validateLinkedFilePaths(paths: string[]): Promise<LinkedPathValidation> {
  const uniquePaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  const existingFiles: string[] = [];
  const missingPaths: string[] = [];
  const nonFilePaths: string[] = [];
  for (const relativePath of uniquePaths) {
    const resolvedPath = path.isAbsolute(relativePath) ? relativePath : path.resolve(process.cwd(), relativePath);
    try {
      const stats = await fs.stat(resolvedPath);
      if (stats.isFile()) {
        existingFiles.push(relativePath);
      } else {
        nonFilePaths.push(relativePath);
      }
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
        missingPaths.push(relativePath);
        continue;
      }
      nonFilePaths.push(relativePath);
    }
  }
  return {
    checked: uniquePaths.length,
    existing_files: existingFiles,
    missing_paths: missingPaths,
    non_file_paths: nonFilePaths,
  };
}

function buildLinkedFileAudit(paths: string[], allItems: Array<{ id: string; files?: LinkedFile[] }>): LinkedPathAuditEntry[] {
  const index = new Map<string, Set<string>>();
  for (const item of allItems) {
    for (const linkedFile of item.files ?? []) {
      const seen = index.get(linkedFile.path) ?? new Set<string>();
      seen.add(item.id);
      index.set(linkedFile.path, seen);
    }
  }
  return [...new Set(paths)]
    .sort((left, right) => left.localeCompare(right))
    .map((linkedPath) => {
      const linkedIds = [...(index.get(linkedPath) ?? new Set<string>())].sort((left, right) => left.localeCompare(right));
      return {
        path: linkedPath,
        linked_by_count: linkedIds.length,
        linked_item_ids: linkedIds,
      };
    });
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
  if (isPathInside(canonicalProjectRoot, canonicalAbsolutePath)) {
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
  const stdinResolver = createStdinTokenResolver();
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const resolvedAdds = await stdinResolver.resolveList(options.add, "--add");
  const resolvedAddGlobs = await stdinResolver.resolveList(options.addGlob, "--add-glob");
  const resolvedRemoves = await stdinResolver.resolveList(options.remove, "--remove");
  const resolvedMigrations = await stdinResolver.resolveList(options.migrate, "--migrate");
  const parsedAdds = parseAddEntries(resolvedAdds);
  const addGlobs = parseAddGlobEntries(resolvedAddGlobs);
  const expandedGlobAdds = await expandAddGlobEntries(addGlobs);
  const adds = [...parsedAdds, ...expandedGlobAdds];
  const removes = parseRemoveEntries(resolvedRemoves);
  const migrations = parseMigrateEntries(resolvedMigrations);
  const shouldMutate = adds.length > 0 || removes.length > 0 || migrations.length > 0;

  if (!shouldMutate) {
    const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
    if (!located) {
      throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
    }
    const loaded = await readLocatedItem(located, { schema: settings.schema });
    const files = loaded.document.metadata.files ?? [];
    return {
      id: located.id,
      files,
      changed: false,
      count: files.length,
      validation: options.validatePaths ? await validateLinkedFilePaths(files.map((entry) => entry.path)) : undefined,
      audit: options.audit
        ? buildLinkedFileAudit(
            files.map((entry) => entry.path),
            (await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder, undefined, settings.schema)).map((entry) => ({
              id: entry.id,
              files: entry.files,
            })),
          )
        : undefined,
    };
  }

  const author = resolveAuthor(options.author, settings.author_default);
  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "files_add",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      const next = [...(document.metadata.files ?? [])];
      let migrationCount = 0;
      if (migrations.length > 0) {
        for (let index = 0; index < next.length; index += 1) {
          const migratedPath = applyPathMigrations(next[index].path, migrations);
          if (migratedPath !== next[index].path) {
            next[index] = { ...next[index], path: migratedPath };
            migrationCount += 1;
          }
        }
      }
      const migratedAdds = adds.map((entry) => {
        const migratedPath = applyPathMigrations(entry.path, migrations);
        if (migratedPath !== entry.path) {
          migrationCount += 1;
        }
        return {
          ...entry,
          path: migratedPath,
        };
      });
      const migratedRemoves = removes.map((entry) => applyPathMigrations(entry, migrations));
      for (const add of migratedAdds) {
        const exists = next.some((entry) => entry.path === add.path && entry.scope === add.scope);
        if (!exists) {
          next.push(add);
        }
      }
      if (migratedRemoves.length > 0) {
        for (let i = next.length - 1; i >= 0; i -= 1) {
          if (migratedRemoves.includes(next[i].path)) {
            next.splice(i, 1);
          }
        }
      }
      const deduped = dedupeLinkedFiles(next);
      const normalized = options.appendStable ? deduped : sortLinkedFiles(deduped);
      if (normalized.length > 0) {
        document.metadata.files = normalized;
      } else {
        delete document.metadata.files;
      }
      return { changedFields: ["files"], warnings: migrationCount > 0 ? [`path_migrations_applied:${migrationCount}`] : [] };
    },
  });

  const files = result.item.files ?? [];
  const migrationWarning = result.warnings.find((warning) => warning.startsWith("path_migrations_applied:"));
  const migrationCount = migrationWarning ? Number(migrationWarning.split(":")[1] ?? "0") : 0;
  const allItems = options.audit
    ? (await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder, undefined, settings.schema)).map((entry) => ({
        id: entry.id,
        files: entry.files,
      }))
    : [];
  return {
    id: result.item.id,
    files,
    changed: true,
    count: files.length,
    migrations_applied: migrationCount > 0 ? migrationCount : undefined,
    validation: options.validatePaths ? await validateLinkedFilePaths(files.map((entry) => entry.path)) : undefined,
    audit: options.audit ? buildLinkedFileAudit(files.map((entry) => entry.path), allItems) : undefined,
  };
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
      const deduped = dedupeLinkedFiles(next);
      const normalized = options.appendStable ? deduped : sortLinkedFiles(deduped);
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
