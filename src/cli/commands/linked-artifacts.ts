/**
 * @module cli/commands/linked-artifacts
 *
 * Implements the pm linked artifacts command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import {
  assertNoUnknownCsvKeys,
  createStdinTokenResolver,
  looksLikeGenericKeyValueEntry,
  parseCsvKv,
} from "../../core/item/parse.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { splitCommaList } from "../../core/shared/split-comma-list.js";
import { listAllFrontMatter, locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { SCOPE_VALUES } from "../../types/index.js";
import { resolveAuthor } from "../../core/shared/author.js";
import type { LinkScope } from "../../types/index.js";

/**
 * Restricts linked artifact values accepted by command, SDK, and storage contracts.
 */
export type LinkedArtifact = {
  path: string;
  scope: LinkScope;
  note?: string;
};

/** Allowed CSV/markdown keys for each structured linked-artifact option (GH-258). */
export const LINKED_ARTIFACT_ADD_KEYS = ["path", "scope", "note"] as const;
export const LINKED_ARTIFACT_ADD_GLOB_KEYS = ["pattern", "glob", "path", "scope", "note"] as const;
export const LINKED_ARTIFACT_REMOVE_KEYS = ["path"] as const;
export const LINKED_ARTIFACT_MIGRATE_KEYS = ["from", "to"] as const;
/**
 * Keys that are valid on --add but meaningless on --remove (GH-277). Rejected
 * with audit-trail guidance (--message) rather than the generic unknown-key
 * error so agents are not left believing a removal note was recorded.
 */
const LINKED_ARTIFACT_REMOVE_UNSUPPORTED_KEYS: ReadonlySet<string> = new Set(["note", "scope"]);

/**
 * Documents the linked artifact command options payload exchanged by command, SDK, and package integrations.
 */
export interface LinkedArtifactCommandOptions {
  add?: string[];
  addGlob?: string[];
  remove?: string[];
  migrate?: string[];
  /**
   * GH-170 (pm-pfnx): standalone note applied to every link added by --add /
   * --add-glob in the same invocation. A per-entry embedded note (the
   * `path=...,note=...` pair syntax) takes precedence over this flag.
   * Requires at least one --add/--add-glob; rejected otherwise.
   */
  note?: string;
  list?: boolean;
  appendStable?: boolean;
  validatePaths?: boolean;
  audit?: boolean;
  author?: string;
  message?: string;
  force?: boolean;
}

/**
 * Documents the path migration payload exchanged by command, SDK, and package integrations.
 */
export interface PathMigration {
  from: string;
  to: string;
}

/**
 * Documents the add glob entry payload exchanged by command, SDK, and package integrations.
 */
export interface AddGlobEntry {
  pattern: string;
  scope: LinkScope;
  note?: string;
}

/**
 * Documents the linked path validation payload exchanged by command, SDK, and package integrations.
 */
export interface LinkedPathValidation {
  checked: number;
  existing_files: string[];
  missing_paths: string[];
  non_file_paths: string[];
}

/**
 * Documents the linked path audit entry payload exchanged by command, SDK, and package integrations.
 */
export interface LinkedPathAuditEntry {
  path: string;
  linked_by_count: number;
  linked_item_ids: string[];
}

/**
 * Documents the linked artifact result payload exchanged by command, SDK, and package integrations.
 */
export interface LinkedArtifactResult {
  id: string;
  changed: boolean;
  count: number;
  migrations_applied?: number;
  validation?: LinkedPathValidation;
  audit?: LinkedPathAuditEntry[];
  artifacts: LinkedArtifact[];
}

/**
 * Configuration that adapts the shared linked-artifact command core to a
 * specific resource kind (files or docs) while preserving every behavioral
 * detail of the original twin implementations.
 */
export interface LinkedArtifactKindConfig {
  /** Metadata key under which the artifacts are stored (e.g. "files" | "docs"). */
  metadataKey: "files" | "docs";
  /** Mutation op recorded in history (e.g. "files_add" | "docs_add"). */
  op: "files_add" | "docs_add";
  /** Noun used in the "bare <noun> path" --add usage error (e.g. "file" | "doc"). */
  bareNoun: "file" | "doc";
  /**
   * Whether this kind honors the append-stable option. files supports it;
   * docs always sorts and must never expose append-stable behavior.
   */
  supportsAppendStable: boolean;
}

/**
 * Implements ensure scope for the public runtime surface of this module.
 */
export function ensureScope(raw: string | undefined): LinkScope {
  const value = (raw ?? "project") as LinkScope;
  if (!SCOPE_VALUES.includes(value)) {
    throw new PmCliError(
      `Invalid scope "${raw}". Valid scopes: ${SCOPE_VALUES.join(", ")} (default: project).`,
      EXIT_CODE.USAGE,
    );
  }
  return value;
}

/**
 * Implements looks like structured path entry for the public runtime surface of this module.
 */
export function looksLikeStructuredPathEntry(raw: string): boolean {
  if (raw.startsWith("```") || raw.includes("\n")) {
    return true;
  }
  if (/^(?:[-*+]\s+)?(?:path|scope|note)\s*[:=]/i.test(raw)) {
    return true;
  }
  // A first-key typo (e.g. `lable=main,path=…`) must still be parsed so the
  // unknown key is rejected rather than swallowed as a bare path (GH-258).
  return looksLikeGenericKeyValueEntry(raw);
}

function expandBareCommaSeparatedAddEntries(raw: string[]): string[] {
  return raw.flatMap((entry) => {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || looksLikeStructuredPathEntry(trimmed) || !trimmed.includes(",")) {
      return [entry];
    }
    return splitCommaList(trimmed);
  });
}

/**
 * Implements parse add entries for the public runtime surface of this module.
 */
export function parseAddEntries(raw: string[] | undefined, bareNoun: "file" | "doc"): LinkedArtifact[] {
  if (!raw) return [];
  return expandBareCommaSeparatedAddEntries(raw).map((entry) => {
    const trimmed = entry.trim();
    const kv = looksLikeStructuredPathEntry(trimmed) ? parseCsvKv(entry, "--add") : { path: trimmed };
    assertNoUnknownCsvKeys(kv, "--add", LINKED_ARTIFACT_ADD_KEYS);
    if (!kv.path) {
      throw new PmCliError(`--add requires path=<value> or a bare ${bareNoun} path`, EXIT_CODE.USAGE);
    }
    return {
      path: kv.path,
      scope: ensureScope(kv.scope),
      note: kv.note?.trim() || undefined,
    };
  });
}

/**
 * Implements parse add glob entries for the public runtime surface of this module.
 */
export function parseAddGlobEntries(raw: string[] | undefined): AddGlobEntry[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new PmCliError("--add-glob requires a glob pattern value", EXIT_CODE.USAGE);
    }
    if (trimmed.includes("=") || /^(?:[-*+]\s+)?(?:pattern|glob|path)\s*[:=]/i.test(trimmed) || trimmed.startsWith("```")) {
      const kv = parseCsvKv(trimmed, "--add-glob");
      assertNoUnknownCsvKeys(kv, "--add-glob", LINKED_ARTIFACT_ADD_GLOB_KEYS);
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

/**
 * Implements parse remove entries for the public runtime surface of this module.
 */
export function parseRemoveEntries(raw: string[] | undefined): string[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new PmCliError("--remove requires a path value", EXIT_CODE.USAGE);
    }
    if (trimmed.includes("=") || /^(?:[-*+]\s+)?path\s*[:=]/i.test(trimmed) || trimmed.startsWith("```")) {
      const kv = parseCsvKv(trimmed, "--remove");
      // GH-277: --remove identifies an existing link by path only; it does not
      // attach per-link metadata. Reject the --add-only keys with guidance toward
      // the audit-trail path (--message) rather than the generic "unrecognized
      // key" error, which left agents believing they had recorded a removal note.
      const unsupportedRemoveKeys = Object.keys(kv).filter((key) =>
        LINKED_ARTIFACT_REMOVE_UNSUPPORTED_KEYS.has(key.toLowerCase()),
      );
      if (unsupportedRemoveKeys.length > 0) {
        throw new PmCliError(
          `--remove identifies a linked artifact by path only and does not accept ${unsupportedRemoveKeys
            .map((key) => `"${key}"`)
            .join(", ")}. Pass just the path (path=<value>, path:<value>, or a bare path); record removal context with --message "<why removed>".`,
          EXIT_CODE.USAGE,
        );
      }
      assertNoUnknownCsvKeys(kv, "--remove", LINKED_ARTIFACT_REMOVE_KEYS);
      if (!kv.path) {
        throw new PmCliError("--remove key/value form requires path=<value>", EXIT_CODE.USAGE);
      }
      return kv.path;
    }
    return trimmed;
  });
}

/**
 * Implements parse migrate entries for the public runtime surface of this module.
 */
export function parseMigrateEntries(raw: string[] | undefined): PathMigration[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const kv = parseCsvKv(entry, "--migrate");
    assertNoUnknownCsvKeys(kv, "--migrate", LINKED_ARTIFACT_MIGRATE_KEYS);
    const from = kv.from?.trim();
    const to = kv.to?.trim();
    if (!from || !to) {
      throw new PmCliError("--migrate requires from=<value> and to=<value>", EXIT_CODE.USAGE);
    }
    return { from, to };
  });
}

/**
 * Implements apply path migrations for the public runtime surface of this module.
 */
export function applyPathMigrations(artifactPath: string, migrations: PathMigration[]): string {
  let next = artifactPath;
  for (const migration of migrations) {
    if (next.startsWith(migration.from)) {
      next = `${migration.to}${next.slice(migration.from.length)}`;
    }
  }
  return next;
}

/**
 * Implements normalize linked path for the public runtime surface of this module.
 */
export function normalizeLinkedPath(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Implements expand add glob entries for the public runtime surface of this module.
 */
export async function expandAddGlobEntries(entries: AddGlobEntry[]): Promise<LinkedArtifact[]> {
  const expanded: LinkedArtifact[] = [];
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

/**
 * GH-170 (pm-pfnx): apply a standalone --note to the links added in this
 * invocation. Semantics (documented on pm-pfnx): the note is attached to EVERY
 * entry added via --add/--add-glob so a single flag annotates the whole batch
 * predictably; a per-entry embedded `note=` wins over the standalone flag; and
 * --note without any --add/--add-glob flag is a usage error because there is
 * nothing to annotate (it never retro-edits existing links). `hasAddFlags`
 * reflects flag presence, not match count, so a glob that legitimately matches
 * zero files is not an error.
 */
export function applyStandaloneNote(
  adds: LinkedArtifact[],
  note: string | undefined,
  hasAddFlags: boolean,
): LinkedArtifact[] {
  if (note === undefined) {
    return adds;
  }
  if (!hasAddFlags) {
    throw new PmCliError(
      "--note requires --add or --add-glob in the same invocation (the note annotates the links being added)",
      EXIT_CODE.USAGE,
    );
  }
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    return adds;
  }
  return adds.map((entry) => (entry.note === undefined ? { ...entry, note: trimmed } : entry));
}

/**
 * Implements artifact key for the public runtime surface of this module.
 */
export function artifactKey(value: Pick<LinkedArtifact, "path" | "scope">): string {
  return `${value.path}::${value.scope}`;
}

/**
 * Implements sort linked artifacts for the public runtime surface of this module.
 */
export function sortLinkedArtifacts(artifacts: LinkedArtifact[]): LinkedArtifact[] {
  return [...artifacts].sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    if (byPath !== 0) return byPath;
    return left.scope.localeCompare(right.scope);
  });
}

/**
 * Implements dedupe linked artifacts for the public runtime surface of this module.
 */
export function dedupeLinkedArtifacts(artifacts: LinkedArtifact[]): LinkedArtifact[] {
  return [...new Map(artifacts.map((entry) => [artifactKey(entry), entry])).values()].map((entry) => ({
    ...entry,
    note: entry.note?.trim() || undefined,
  }));
}

/**
 * Implements validate linked paths for the public runtime surface of this module.
 */
export async function validateLinkedPaths(paths: string[]): Promise<LinkedPathValidation> {
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

/**
 * Implements build linked path audit for the public runtime surface of this module.
 */
export function buildLinkedPathAudit(
  paths: string[],
  allItems: Array<{ id: string; artifacts?: LinkedArtifact[] }>,
): LinkedPathAuditEntry[] {
  const index = new Map<string, Set<string>>();
  for (const item of allItems) {
    for (const linkedArtifact of item.artifacts ?? []) {
      const seen = index.get(linkedArtifact.path) ?? new Set<string>();
      seen.add(item.id);
      index.set(linkedArtifact.path, seen);
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

/**
 * Shared linked-artifact list/mutate command core used by runFiles and runDocs.
 * The kind config selects metadata key, op, bare-path noun, and whether
 * append-stable ordering is honored, preserving each twin's exact semantics.
 */
export async function runLinkedArtifacts(
  id: string,
  options: LinkedArtifactCommandOptions,
  global: GlobalOptions,
  config: LinkedArtifactKindConfig,
): Promise<LinkedArtifactResult> {
  const { metadataKey } = config;
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
  const parsedAdds = parseAddEntries(resolvedAdds, config.bareNoun);
  const addGlobs = parseAddGlobEntries(resolvedAddGlobs);
  const expandedGlobAdds = await expandAddGlobEntries(addGlobs);
  const adds = applyStandaloneNote(
    [...parsedAdds, ...expandedGlobAdds],
    options.note,
    parsedAdds.length > 0 || addGlobs.length > 0,
  );
  const removes = parseRemoveEntries(resolvedRemoves);
  const migrations = parseMigrateEntries(resolvedMigrations);
  const shouldMutate = adds.length > 0 || removes.length > 0 || migrations.length > 0;

  const collectAuditItems = async (): Promise<Array<{ id: string; artifacts?: LinkedArtifact[] }>> =>
    (await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder, undefined, settings.schema)).map((entry) => ({
      id: entry.id,
      artifacts: (entry as Record<string, unknown>)[metadataKey] as LinkedArtifact[] | undefined,
    }));

  if (!shouldMutate) {
    const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
    if (!located) {
      throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
    }
    const loaded = await readLocatedItem(located, { schema: settings.schema });
    const artifacts = ((loaded.document.metadata as Record<string, unknown>)[metadataKey] as LinkedArtifact[] | undefined) ?? [];
    return {
      id: located.id,
      artifacts,
      changed: false,
      count: artifacts.length,
      validation: options.validatePaths ? await validateLinkedPaths(artifacts.map((entry) => entry.path)) : undefined,
      audit: options.audit ? buildLinkedPathAudit(artifacts.map((entry) => entry.path), await collectAuditItems()) : undefined,
    };
  }

  const author = resolveAuthor(options.author, settings.author_default);
  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: config.op,
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      const metadata = document.metadata as Record<string, unknown>;
      const next = [...((metadata[metadataKey] as LinkedArtifact[] | undefined) ?? [])];
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
      const deduped = dedupeLinkedArtifacts(next);
      const normalized = config.supportsAppendStable && options.appendStable ? deduped : sortLinkedArtifacts(deduped);
      if (normalized.length > 0) {
        metadata[metadataKey] = normalized;
      } else {
        delete metadata[metadataKey];
      }
      return { changedFields: [metadataKey], warnings: migrationCount > 0 ? [`path_migrations_applied:${migrationCount}`] : [] };
    },
  });

  const artifacts = ((result.item as Record<string, unknown>)[metadataKey] as LinkedArtifact[] | undefined) ?? [];
  const migrationWarning = result.warnings.find((warning) => warning.startsWith("path_migrations_applied:"));
  const migrationCount = migrationWarning ? Number(migrationWarning.slice("path_migrations_applied:".length)) : 0;
  const allItems = options.audit ? await collectAuditItems() : [];
  return {
    id: result.item.id,
    artifacts,
    changed: true,
    count: artifacts.length,
    migrations_applied: migrationCount > 0 ? migrationCount : undefined,
    validation: options.validatePaths ? await validateLinkedPaths(artifacts.map((entry) => entry.path)) : undefined,
    audit: options.audit ? buildLinkedPathAudit(artifacts.map((entry) => entry.path), allItems) : undefined,
  };
}

/**
 * Re-key the generic `artifacts` field to the resource-specific name (files/docs)
 * while preserving the original key order and presence so kind-specific result
 * shapes (and their deterministic JSON key ordering) stay byte-identical.
 */
export function renameArtifactsResultKey(result: LinkedArtifactResult, key: "files" | "docs"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(result)) {
    out[field === "artifacts" ? key : field] = value;
  }
  return out;
}
