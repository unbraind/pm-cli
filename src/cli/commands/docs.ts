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
import type { LinkedDoc, LinkScope } from "../../types/index.js";

export interface DocsCommandOptions {
  add?: string[];
  addGlob?: string[];
  remove?: string[];
  migrate?: string[];
  validatePaths?: boolean;
  audit?: boolean;
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

export interface DocsResult {
  id: string;
  docs: LinkedDoc[];
  changed: boolean;
  count: number;
  migrations_applied?: number;
  validation?: LinkedPathValidation;
  audit?: LinkedPathAuditEntry[];
}

function resolveAuthor(candidate: string | undefined, fallback: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? fallback;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function ensureScope(raw: string | undefined): LinkScope {
  const value = (raw ?? "project") as LinkScope;
  if (!SCOPE_VALUES.includes(value)) {
    throw new PmCliError(
      `Invalid scope "${raw}". Valid scopes: ${SCOPE_VALUES.join(", ")} (default: project).`,
      EXIT_CODE.USAGE,
    );
  }
  return value;
}

function looksLikeStructuredPathEntry(raw: string): boolean {
  if (raw.startsWith("```") || raw.includes("\n")) {
    return true;
  }
  return /^(?:[-*+]\s+)?(?:path|scope|note)\s*[:=]/i.test(raw);
}

function parseAddEntries(raw: string[] | undefined): LinkedDoc[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const trimmed = entry.trim();
    const kv = looksLikeStructuredPathEntry(trimmed) ? parseCsvKv(entry, "--add") : { path: trimmed };
    if (!kv.path) {
      throw new PmCliError("--add requires path=<value> or a bare doc path", EXIT_CODE.USAGE);
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

function applyPathMigrations(docPath: string, migrations: PathMigration[]): string {
  let next = docPath;
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

async function expandAddGlobEntries(entries: AddGlobEntry[]): Promise<LinkedDoc[]> {
  const expanded: LinkedDoc[] = [];
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

function docKey(value: Pick<LinkedDoc, "path" | "scope">): string {
  return `${value.path}::${value.scope}`;
}

function sortLinkedDocs(docs: LinkedDoc[]): LinkedDoc[] {
  return [...docs].sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    if (byPath !== 0) return byPath;
    return left.scope.localeCompare(right.scope);
  });
}

async function validateLinkedDocPaths(paths: string[]): Promise<LinkedPathValidation> {
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

function buildLinkedDocAudit(paths: string[], allItems: Array<{ id: string; docs?: LinkedDoc[] }>): LinkedPathAuditEntry[] {
  const index = new Map<string, Set<string>>();
  for (const item of allItems) {
    for (const linkedDoc of item.docs ?? []) {
      const seen = index.get(linkedDoc.path) ?? new Set<string>();
      seen.add(item.id);
      index.set(linkedDoc.path, seen);
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

export async function runDocs(id: string, options: DocsCommandOptions, global: GlobalOptions): Promise<DocsResult> {
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
    const docs = loaded.document.metadata.docs ?? [];
    return {
      id: located.id,
      docs,
      changed: false,
      count: docs.length,
      validation: options.validatePaths ? await validateLinkedDocPaths(docs.map((entry) => entry.path)) : undefined,
      audit: options.audit
        ? buildLinkedDocAudit(
            docs.map((entry) => entry.path),
            (await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder, undefined, settings.schema)).map((entry) => ({
              id: entry.id,
              docs: entry.docs,
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
    op: "docs_add",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      const next = [...(document.metadata.docs ?? [])];
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
      const deduped = sortLinkedDocs(
        [...new Map(next.map((entry) => [docKey(entry), entry])).values()].map((entry) => ({
          ...entry,
          note: entry.note?.trim() || undefined,
        })),
      );
      if (deduped.length > 0) {
        document.metadata.docs = deduped;
      } else {
        delete document.metadata.docs;
      }
      return { changedFields: ["docs"], warnings: migrationCount > 0 ? [`path_migrations_applied:${migrationCount}`] : [] };
    },
  });

  const docs = result.item.docs ?? [];
  const migrationWarning = result.warnings.find((warning) => warning.startsWith("path_migrations_applied:"));
  const migrationCount = migrationWarning ? Number(migrationWarning.split(":")[1] ?? "0") : 0;
  const allItems = options.audit
    ? (await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder, undefined, settings.schema)).map((entry) => ({
        id: entry.id,
        docs: entry.docs,
      }))
    : [];
  return {
    id: result.item.id,
    docs,
    changed: true,
    count: docs.length,
    migrations_applied: migrationCount > 0 ? migrationCount : undefined,
    validation: options.validatePaths ? await validateLinkedDocPaths(docs.map((entry) => entry.path)) : undefined,
    audit: options.audit ? buildLinkedDocAudit(docs.map((entry) => entry.path), allItems) : undefined,
  };
}
