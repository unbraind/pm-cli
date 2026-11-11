/**
 * @module sdk/linked-artifacts
 *
 * Implements the pm linked artifacts command surface and its agent-facing runtime behavior.
 */
import { assertInitializedTracker } from "./environment/tracker-preflight.js";
import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import { isFileAbsentError } from "../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../core/extensions/index.js";
import {
  assertNoAmbiguousBareCommaEntry,
  assertNoUnknownCsvKeys,
  createStdinTokenResolver,
  looksLikeGenericKeyValueEntry,
  parseCsvKv,
} from "../core/item/parse.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { isRemoteLinkedArtifactReference } from "../core/validate/linked-artifact-reference.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { stableValueEquals } from "../core/shared/serialization.js";
import {
  locateItem,
  mutateItem,
  readLocatedItem,
} from "../core/store/item-store.js";
import { resolvePmRoot, resolveWorkspaceRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import { SCOPE_VALUES } from "../types/index.js";
import { resolveAuthor } from "../core/shared/author.js";
import type { LinkScope } from "../types/index.js";
import type { AnnotationOmissionReceipt } from "./annotations.js";
import { renderPmCommand, resolvePmCommandScopeArgs } from "./command-line.js";

/** Restricts linked artifact values accepted by command, SDK, and storage contracts. */
export type LinkedArtifact = {
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports scope for this contract. */
  scope: LinkScope;
  /** Value that configures or reports note for this contract. */
  note?: string;
};

/** Allowed CSV/markdown keys for each structured linked-artifact option (GH-258). */
export const LINKED_ARTIFACT_ADD_KEYS = ["path", "scope", "note"] as const;
/** Public contract for linked artifact add glob keys, shared by SDK and presentation-layer consumers. */
export const LINKED_ARTIFACT_ADD_GLOB_KEYS = [
  "pattern",
  "glob",
  "path",
  "scope",
  "note",
] as const;
/** Public contract for linked artifact remove keys, shared by SDK and presentation-layer consumers. */
export const LINKED_ARTIFACT_REMOVE_KEYS = ["path"] as const;
/** Public contract for linked artifact migrate keys, shared by SDK and presentation-layer consumers. */
export const LINKED_ARTIFACT_MIGRATE_KEYS = ["from", "to"] as const;
/** Keys that are valid on --add but meaningless on --remove (GH-277). Rejected with audit-trail guidance (--message) rather than the generic unknown-key error so agents are not left believing a removal note was recorded. */
const LINKED_ARTIFACT_REMOVE_UNSUPPORTED_KEYS: ReadonlySet<string> = new Set([
  "note",
  "scope",
]);

/** Documents the linked artifact command options payload exchanged by command, SDK, and package integrations. */
export interface LinkedArtifactCommandOptions {
  /** Value that configures or reports add for this contract. */
  add?: string[];
  /** Value that configures or reports add glob for this contract. */
  addGlob?: string[];
  /** Value that configures or reports remove for this contract. */
  remove?: string[];
  /** Value that configures or reports migrate for this contract. */
  migrate?: string[];
  /** GH-170 (pm-pfnx): standalone note applied to every link added by --add / --add-glob in the same invocation. A per-entry embedded note (the `path=...,note=...` pair syntax) takes precedence over this flag. Requires at least one --add/--add-glob; rejected otherwise. */
  note?: string;
  /** Value that configures or reports list for this contract. */
  list?: boolean;
  /** Value that configures or reports append stable for this contract. */
  appendStable?: boolean;
  /** Value that configures or reports validate paths for this contract. */
  validatePaths?: boolean;
  /** Return the complete linked collection after a write instead of the bounded mutation receipt (pm-gh1700). */
  fullHistory?: boolean;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Describes the linked-collection entries one bounded mutation response carries (pm-gh1700). */
export interface LinkedCollectionMutationReceipt {
  /** Entries this mutation added or rewrote; a bounded response returns exactly these. */
  changed_count: number;
  /** Stored entries this mutation removed. */
  removed_count: number;
  /** Whether the response includes the complete post-mutation collection. */
  full_history_included: boolean;
}

/** Counts and receipts a linked-collection mutation response carries beside its entries. */
export interface LinkedCollectionMutationProjection<TEntry> {
  /** The written entries, or the whole collection when full history was requested. */
  entries: TEntry[];
  /** Number of entries stored after the mutation. */
  total_count: number;
  /** Number of entries this response carries. */
  returned_count: number;
  /** Whether stored entries exist beyond the ones returned. */
  has_more: boolean;
  /** What the mutation changed. */
  mutation_receipt: LinkedCollectionMutationReceipt;
  /** Stored entries withheld from this response and the selector that restores them. */
  omission_receipt: AnnotationOmissionReceipt;
}

/** Positions in `after` whose stored value is new: added, note-revised or migrated (pm-gh1700). */
export function writtenLinkedEntryIndexes<TEntry>(
  before: readonly TEntry[],
  after: readonly TEntry[],
): number[] {
  const unmatched = [...before];
  const written: number[] = [];
  after.forEach((entry, position) => {
    const index = unmatched.findIndex((candidate) => stableValueEquals(candidate, entry));
    if (index < 0) written.push(position);
    else unmatched.splice(index, 1);
  });
  return written;
}

/** Entries of `after` whose stored value is new: added, note-revised or migrated (pm-gh1700). */
export function writtenLinkedEntries<TEntry>(
  before: readonly TEntry[],
  after: readonly TEntry[],
): TEntry[] {
  return writtenLinkedEntryIndexes(before, after).map((position) => after[position]!);
}

/**
 * Bound a linked-collection mutation response to the entries it wrote
 * (pm-gh1700), as comments, notes and learnings bound theirs: the response
 * no longer grows with the stored list. `fullHistory` (CLI `--full-history`,
 * MCP `full`) returns the whole collection, and the omission receipt names
 * that selector whenever stored entries were withheld.
 */
export function projectLinkedCollectionMutation<TEntry>(params: {
  collectionKey: "files" | "docs" | "tests";
  stored: readonly TEntry[];
  written: readonly TEntry[];
  removedCount: number;
  fullHistory: boolean;
}): LinkedCollectionMutationProjection<TEntry> {
  const entries = params.fullHistory ? [...params.stored] : [...params.written];
  const withheld = entries.length < params.stored.length;
  return {
    entries,
    total_count: params.stored.length,
    returned_count: entries.length,
    has_more: withheld,
    mutation_receipt: {
      changed_count: params.written.length,
      removed_count: params.removedCount,
      full_history_included: !withheld,
    },
    omission_receipt: {
      has_omissions: withheld,
      omitted_field_group_count: withheld ? 1 : 0,
      omitted_field_groups: withheld
        ? [
            {
              name: `${params.collectionKey}_history`,
              restore_with: {
                selector: "full_history",
                cli_flag: "--full-history",
                sdk_option: "fullHistory",
                mcp_option: "full",
              },
            },
          ]
        : [],
    },
  };
}

/** Documents the path migration payload exchanged by command, SDK, and package integrations. */
export interface PathMigration {
  /** Value that configures or reports from for this contract. */
  from: string;
  /** Value that configures or reports to for this contract. */
  to: string;
}

/** Documents the add glob entry payload exchanged by command, SDK, and package integrations. */
export interface AddGlobEntry {
  /** Value that configures or reports pattern for this contract. */
  pattern: string;
  /** Value that configures or reports scope for this contract. */
  scope: LinkScope;
  /** Value that configures or reports note for this contract. */
  note?: string;
}

/** Documents the linked path validation payload exchanged by command, SDK, and package integrations. */
export interface LinkedPathValidation {
  /** Value that configures or reports checked for this contract. */
  checked: number;
  /** Value that configures or reports existing files for this contract. */
  existing_files: string[];
  /** Value that configures or reports missing paths for this contract. */
  missing_paths: string[];
  /** Value that configures or reports non file paths for this contract. */
  non_file_paths: string[];
  /** Remote references (https:// URLs and other `scheme://` paths) recorded as links — most often a PR/issue/design-doc URL added via `pm docs --add`. These are not local files, so they bypass the existence probe and are reported here rather than counted as missing. */
  remote_references: string[];
}

/** Documents the linked artifact result payload exchanged by command, SDK, and package integrations. */
export interface LinkedArtifactResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports changed for this contract. */
  changed: boolean;
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Value that configures or reports migrations applied for this contract. */
  migrations_applied?: number;
  /** Value that configures or reports validation for this contract. */
  validation?: LinkedPathValidation;
  /** Value that configures or reports artifacts for this contract. */
  artifacts: LinkedArtifact[];
  /** Mutations only: entries stored after the write (pm-gh1700). */
  total_count?: number;
  /** Mutations only: entries this response carries. */
  returned_count?: number;
  /** Mutations only: whether stored entries exist beyond the ones returned. */
  has_more?: boolean;
  /** Mutations only: what the write changed. */
  mutation_receipt?: LinkedCollectionMutationReceipt;
  /** Mutations only: withheld entries and the selector that restores them. */
  omission_receipt?: AnnotationOmissionReceipt;
}

/** Replaces the generic artifacts field with a resource-specific result key while retaining the remaining result contract. */
export type RenamedLinkedArtifactResult<
  Result extends LinkedArtifactResult,
  Key extends "files" | "docs",
> = Omit<Result, "artifacts"> & { [Field in Key]: Result["artifacts"] };

/** Configuration that adapts the shared linked-artifact command core to a specific resource kind (files or docs) while preserving every behavioral detail of the original twin implementations. */
export interface LinkedArtifactKindConfig {
  /** Metadata key under which the artifacts are stored (e.g. "files" | "docs"). */
  metadataKey: "files" | "docs";
  /** Mutation op recorded in history (e.g. "files_add" | "docs_add"). */
  op: "files_add" | "docs_add";
  /** Noun used in the "bare <noun> path" --add usage error (e.g. "file" | "doc"). */
  bareNoun: "file" | "doc";
  /** Whether this kind honors the append-stable option. files supports it; docs always sorts and must never expose append-stable behavior. */
  supportsAppendStable: boolean;
}

/** Implements ensure scope for the public runtime surface of this module. */
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

/** Implements looks like structured path entry for the public runtime surface of this module. */
export function looksLikeStructuredPathEntry(raw: string): boolean {
  if (raw.startsWith("```") || raw.includes("\n")) {
    return true;
  }
  if (/^(?:[-*+]\s+)?(?:path|scope|note)\s*[:=]/i.test(raw)) {
    return true;
  }
  // An equals sign is valid inside filesystem paths and URL query strings.
  // Preserve unmistakable whitespace-free path/URL shapes while routing
  // leading assignment syntax through the structured-key allowlist so typos
  // and malformed URL-plus-note input remain atomic failures (GH-258,
  // GH-1000).
  const firstCommaIndex = raw.indexOf(",");
  const leadingSegment = raw.slice(
    0,
    firstCommaIndex >= 0 ? firstCommaIndex : raw.length,
  );
  const equalsIndex = leadingSegment.indexOf("=");
  if (
    equalsIndex >= 0 &&
    !/\s/u.test(raw) &&
    (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(raw) ||
      /^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|\.\.?(?:[\\/]))/u.test(raw) ||
      [raw.indexOf("/"), raw.indexOf("\\")].some(
        (separatorIndex) => separatorIndex >= 0 && separatorIndex < equalsIndex,
      ))
  ) {
    return false;
  }
  return leadingSegment.includes("=") || looksLikeGenericKeyValueEntry(raw);
}

/** Whether a Markdown destination contains only balanced parentheses. */
function hasBalancedParentheses(value: string): boolean {
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Parse one lossless bare, Markdown, or CSV-label remote documentation reference. */
function parseDocumentationReference(
  trimmed: string,
): LinkedArtifact | undefined {
  if (
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed) &&
    !looksLikeStructuredPathEntry(trimmed)
  ) {
    return { path: trimmed, scope: "project", note: undefined };
  }
  const labelEnd = trimmed.indexOf("](");
  if (trimmed.startsWith("[") && labelEnd > 0 && trimmed.endsWith(")")) {
    const destination = trimmed.slice(labelEnd + 2, -1).trim();
    if (destination.length > 0 && hasBalancedParentheses(destination)) {
      return {
        path: destination,
        scope: "project",
        note: trimmed.slice(1, labelEnd).trim() || undefined,
      };
    }
  }
  const delimiterIndex = trimmed.indexOf(",");
  if (delimiterIndex < 0) return undefined;
  const label = trimmed.slice(0, delimiterIndex).trim();
  const destination = trimmed.slice(delimiterIndex + 1).trim();
  if (
    label.length === 0 ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(destination)
  ) {
    return undefined;
  }
  return { path: destination, scope: "project", note: label };
}

/** Implements parse add entries for the public runtime surface of this module. */
export function parseAddEntries(
  raw: string[] | undefined,
  bareNoun: "file" | "doc",
): LinkedArtifact[] {
  if (!raw) return [];
  return raw.flatMap((entry) => {
    const trimmed = entry.trim();
    if (bareNoun === "doc") {
      const reference = parseDocumentationReference(trimmed);
      if (reference !== undefined) return [reference];
    }
    assertNoAmbiguousBareCommaEntry(
      trimmed,
      "--add",
      `${bareNoun} path`,
      looksLikeStructuredPathEntry(trimmed),
    );
    const kv = looksLikeStructuredPathEntry(trimmed)
      ? parseCsvKv(entry, "--add")
      : { path: trimmed };
    assertNoUnknownCsvKeys(kv, "--add", LINKED_ARTIFACT_ADD_KEYS);
    if (!kv.path) {
      throw new PmCliError(
        `--add requires path=<value> or a bare ${bareNoun} path`,
        EXIT_CODE.USAGE,
      );
    }
    return [
      {
        path: kv.path,
        scope: ensureScope(kv.scope),
        note: kv.note?.trim() || undefined,
      },
    ];
  });
}

/** Implements parse add glob entries for the public runtime surface of this module. */
export function parseAddGlobEntries(raw: string[] | undefined): AddGlobEntry[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new PmCliError(
        "--add-glob requires a glob pattern value",
        EXIT_CODE.USAGE,
      );
    }
    if (
      trimmed.includes("=") ||
      /^(?:[-*+]\s+)?(?:pattern|glob|path)\s*[:=]/i.test(trimmed) ||
      trimmed.startsWith("```")
    ) {
      const kv = parseCsvKv(trimmed, "--add-glob");
      assertNoUnknownCsvKeys(kv, "--add-glob", LINKED_ARTIFACT_ADD_GLOB_KEYS);
      const pattern = kv.pattern?.trim() || kv.glob?.trim() || kv.path?.trim();
      if (!pattern) {
        throw new PmCliError(
          "--add-glob key/value form requires pattern=<glob>",
          EXIT_CODE.USAGE,
        );
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

/** Implements parse remove entries for the public runtime surface of this module. */
export function parseRemoveEntries(raw: string[] | undefined): string[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new PmCliError("--remove requires a path value", EXIT_CODE.USAGE);
    }
    if (
      trimmed.includes("=") ||
      /^(?:[-*+]\s+)?path\s*[:=]/i.test(trimmed) ||
      trimmed.startsWith("```")
    ) {
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
            .join(
              ", ",
            )}. Pass just the path (path=<value>, path:<value>, or a bare path); record removal context with --message "<why removed>".`,
          EXIT_CODE.USAGE,
        );
      }
      assertNoUnknownCsvKeys(kv, "--remove", LINKED_ARTIFACT_REMOVE_KEYS);
      if (!kv.path) {
        throw new PmCliError(
          "--remove key/value form requires path=<value>",
          EXIT_CODE.USAGE,
        );
      }
      return kv.path;
    }
    return trimmed;
  });
}

/** Implements parse migrate entries for the public runtime surface of this module. */
export function parseMigrateEntries(
  raw: string[] | undefined,
): PathMigration[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const kv = parseCsvKv(entry, "--migrate");
    assertNoUnknownCsvKeys(kv, "--migrate", LINKED_ARTIFACT_MIGRATE_KEYS);
    const from = kv.from?.trim();
    const to = kv.to?.trim();
    if (!from || !to) {
      throw new PmCliError(
        "--migrate requires from=<value> and to=<value>",
        EXIT_CODE.USAGE,
      );
    }
    return { from, to };
  });
}

/** Implements apply path migrations for the public runtime surface of this module. */
export function applyPathMigrations(
  artifactPath: string,
  migrations: PathMigration[],
): string {
  let next = artifactPath;
  for (const migration of migrations) {
    if (next.startsWith(migration.from)) {
      next = `${migration.to}${next.slice(migration.from.length)}`;
    }
  }
  return next;
}

/** Reject a transaction that resolves the same linked path into both add and remove sets. */
export function assertLinkedArtifactMutationIsUnambiguous(
  adds: LinkedArtifact[],
  removes: string[],
  migrations: PathMigration[] = [],
): void {
  if (adds.length === 0 || removes.length === 0) {
    return;
  }
  const addedPaths = new Set(
    adds.map((entry) => applyPathMigrations(entry.path, migrations)),
  );
  const conflicts = [
    ...new Set(
      removes
        .map((entry) => applyPathMigrations(entry, migrations))
        .filter((entry) => addedPaths.has(entry)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (conflicts.length === 0) {
    return;
  }
  throw new PmCliError(
    `Linked artifact mutation cannot add and remove the same normalized path in one transaction: ${conflicts.join(", ")}. Split the replacement into separate commands so each history event has one unambiguous intent.`,
    EXIT_CODE.USAGE,
    {
      code: "linked_artifact_mutation_conflict",
      reason: "same_path_added_and_removed",
      required:
        "Use distinct normalized paths for --add and --remove in one invocation.",
      why: "Conflicting batch intent cannot be applied deterministically without silently discarding metadata or a removal.",
      nextSteps: [
        "Run the removal and addition as separate commands with a --message describing each intent.",
      ],
    },
  );
}

/** Implements normalize linked path for the public runtime surface of this module. */
export function normalizeLinkedPath(value: string): string {
  return value.split(path.sep).join("/");
}

/** Anchor a local linked path to the project workspace while preserving remote references and absolute paths. */
export function anchorLinkedPath(
  value: string,
  workspaceRoot: string,
  invocationRoot: string = process.cwd(),
): string {
  const trimmed = value.trim();
  if (isRemoteLinkedArtifactReference(trimmed)) {
    return trimmed;
  }
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return normalizeLinkedPath(trimmed.replaceAll("\\", path.sep));
  }
  const invocationRelativeToWorkspace = path.relative(
    workspaceRoot,
    invocationRoot,
  );
  if (
    invocationRelativeToWorkspace.startsWith(`..${path.sep}`) ||
    invocationRelativeToWorkspace === ".." ||
    path.isAbsolute(invocationRelativeToWorkspace)
  ) {
    return normalizeLinkedPath(path.normalize(trimmed));
  }
  return normalizeLinkedPath(
    path.relative(workspaceRoot, path.resolve(invocationRoot, trimmed)),
  );
}

/** Match files from the invocation directory, then anchor and sort each entry while retaining its scope and note. Literal directories never expand recursively. */
export async function expandAddGlobEntries(
  entries: AddGlobEntry[],
  workspaceRoot: string = process.cwd(),
  invocationRoot: string = process.cwd(),
): Promise<LinkedArtifact[]> {
  const expanded: LinkedArtifact[] = [];
  for (const entry of entries) {
    // A literal invocation directory cannot match a file; tinyglobby otherwise normalizes it to an invalid empty pattern.
    if (path.resolve(invocationRoot, entry.pattern) === path.resolve(invocationRoot)) continue;
    const absolutePattern = path.isAbsolute(entry.pattern);
    const matches = await glob(entry.pattern, {
      cwd: invocationRoot,
      absolute: absolutePattern,
      onlyFiles: true,
      dot: true,
      expandDirectories: false,
      followSymbolicLinks: true,
    });
    const sortedMatches = [
      ...new Set(
        matches.map((match) =>
          anchorLinkedPath(match, workspaceRoot, invocationRoot),
        ),
      ),
    ].sort((left, right) => left.localeCompare(right));
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

/** GH-170 (pm-pfnx): apply a standalone --note to the links added in this invocation. Semantics (documented on pm-pfnx): the note is attached to EVERY entry added via --add/--add-glob so a single flag annotates the whole batch predictably; a per-entry embedded `note=` wins over the standalone flag; and --note without any --add/--add-glob flag is a usage error because there is nothing to annotate (it never retro-edits existing links). `hasAddFlags` reflects flag presence, not match count, so a glob that legitimately matches zero files is not an error. */
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
  return adds.map((entry) =>
    entry.note === undefined ? { ...entry, note: trimmed } : entry,
  );
}

/** Implements artifact key for the public runtime surface of this module. */
export function artifactKey(
  value: Pick<LinkedArtifact, "path" | "scope">,
): string {
  return `${value.path}::${value.scope}`;
}

/** Implements sort linked artifacts for the public runtime surface of this module. */
export function sortLinkedArtifacts(
  artifacts: LinkedArtifact[],
): LinkedArtifact[] {
  return [...artifacts].sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    if (byPath !== 0) return byPath;
    return left.scope.localeCompare(right.scope);
  });
}

/** Implements dedupe linked artifacts for the public runtime surface of this module. */
export function dedupeLinkedArtifacts(
  artifacts: LinkedArtifact[],
): LinkedArtifact[] {
  return [
    ...new Map(artifacts.map((entry) => [artifactKey(entry), entry])).values(),
  ].map((entry) => ({
    ...entry,
    note: entry.note?.trim() || undefined,
  }));
}

/** Implements validate linked paths for the public runtime surface of this module. */
export async function validateLinkedPaths(
  paths: string[],
  workspaceRoot: string = process.cwd(),
): Promise<LinkedPathValidation> {
  const uniquePaths = [...new Set(paths)].sort((left, right) =>
    left.localeCompare(right),
  );
  const existingFiles: string[] = [];
  const missingPaths: string[] = [];
  const nonFilePaths: string[] = [];
  const remoteReferences: string[] = [];
  for (const relativePath of uniquePaths) {
    // Remote references (https:// PR/issue/design-doc URLs) are not local
    // files; report them separately (trimmed, to match buildFilesCheck's
    // output shape) instead of probing a meaningless path.
    if (isRemoteLinkedArtifactReference(relativePath)) {
      remoteReferences.push(relativePath.trim());
      continue;
    }
    const resolvedPath = path.isAbsolute(relativePath)
      ? relativePath
      : path.resolve(workspaceRoot, relativePath);
    try {
      const stats = await fs.stat(resolvedPath);
      if (stats.isFile()) {
        existingFiles.push(relativePath);
      } else {
        nonFilePaths.push(relativePath);
      }
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        isFileAbsentError(error)
      ) {
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
    remote_references: remoteReferences,
  };
}

function applyLinkedArtifactMigrations(
  current: LinkedArtifact[],
  adds: LinkedArtifact[],
  removes: string[],
  migrations: PathMigration[],
): { adds: LinkedArtifact[]; removes: string[]; count: number } {
  let count = 0;
  for (let index = 0; index < current.length; index += 1) {
    const migratedPath = applyPathMigrations(current[index].path, migrations);
    if (migratedPath !== current[index].path) {
      current[index] = { ...current[index], path: migratedPath };
      count += 1;
    }
  }
  const migratedAdds = adds.map((entry) => {
    const migratedPath = applyPathMigrations(entry.path, migrations);
    if (migratedPath !== entry.path) count += 1;
    return { ...entry, path: migratedPath };
  });
  return {
    adds: migratedAdds,
    removes: removes.map((entry) => applyPathMigrations(entry, migrations)),
    count,
  };
}

/** Collapse migration collisions with existing last-wins semantics, then apply explicit note revisions without reordering retries. */
function mergeLinkedArtifactChanges(
  current: LinkedArtifact[],
  adds: LinkedArtifact[],
  removes: string[],
  appendStable: boolean,
): LinkedArtifact[] {
  const merged = dedupeLinkedArtifacts(current);
  for (const add of adds) {
    const index = merged.findIndex(
      /** Match normalized identity after migration collisions have been resolved. */
      (entry) => entry.path === add.path && entry.scope === add.scope,
    );
    if (index < 0) {
      merged.push(add);
    } else if (add.note !== undefined) {
      merged[index] = { ...merged[index], note: add.note };
    }
  }
  if (removes.length > 0) {
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      if (removes.includes(merged[index].path)) merged.splice(index, 1);
    }
  }
  return appendStable ? merged : sortLinkedArtifacts(merged);
}

async function buildLinkedArtifactResult(params: {
  id: string;
  artifacts: LinkedArtifact[];
  changed: boolean;
  migrationsApplied?: number;
  options: LinkedArtifactCommandOptions;
  workspaceRoot: string;
  mutation?: LinkedCollectionMutationProjection<LinkedArtifact>;
}): Promise<LinkedArtifactResult> {
  const returned = params.mutation?.entries ?? params.artifacts;
  // --validate-paths judges the whole stored list; the implicit post-write check judges what this response returns.
  const validated = params.options.validatePaths ? params.artifacts : returned;
  const { counts, receipts } = linkedCollectionMutationFields(params.mutation);
  return {
    id: params.id,
    artifacts: returned,
    changed: params.changed,
    count: returned.length,
    ...counts,
    migrations_applied:
      params.migrationsApplied && params.migrationsApplied > 0
        ? params.migrationsApplied
        : undefined,
    validation:
      params.options.validatePaths || (params.changed && validated.length > 0)
        ? await validateLinkedPaths(validated.map((entry) => entry.path), params.workspaceRoot)
        : undefined,
    ...receipts,
  };
}

/** Stored entries a write removed: each prior entry, after its path migration, that no stored entry still carries. */
function countRemovedLinkedArtifacts(
  before: readonly LinkedArtifact[],
  after: readonly LinkedArtifact[],
  migrations: PathMigration[],
): number {
  const remaining = new Map<string, number>();
  for (const entry of after) {
    const key = artifactKey(entry);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  let removed = 0;
  for (const entry of before) {
    const key = artifactKey({ ...entry, path: applyPathMigrations(entry.path, migrations) });
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else removed += 1;
  }
  return removed;
}

/** Note prose of a refused `--add` entry and the key-shaped segment parsing misread inside it (pm-pwqiao). */
interface MisreadNoteSegment {
  /** The entry with the note removed: the link itself. */
  link: string;
  /** The intended note text, verbatim. */
  note: string;
  /** The comma segment read as a new key. */
  segment: string;
  /** The key that segment opened. */
  key: string;
}

/**
 * Find the note segment a refused `--add` entry misread as a key (pm-pwqiao).
 * After a comma, an identifier followed by `=` or `:` opens a new key, so
 * GH-258 can refuse typos such as `lable=main`; note prose such as
 * `host:port` trips the same rule. Returns undefined unless the entry carries
 * a note followed by such a segment and the link alone parses cleanly, so
 * every other refusal keeps its own message.
 */
export function findMisreadNoteSegment(
  entry: string,
  bareNoun: "file" | "doc",
): MisreadNoteSegment | undefined {
  const marker = /(^|,)\s*note\s*[=:]/iu.exec(entry);
  if (marker === null) return undefined;
  const link = entry.slice(0, marker.index).trim();
  const note = entry.slice(marker.index + marker[0].length).trim();
  if (link.length === 0 || note.length === 0) return undefined;
  const misread = note
    .split(",")
    .slice(1)
    .map((segment) => ({ segment: segment.trim(), match: /^([A-Za-z0-9_.-]+)\s*[=:](?!\/\/)/u.exec(segment.trim()) }))
    .find((candidate) => candidate.match !== null);
  if (misread === undefined) return undefined;
  try {
    parseAddEntries([link], bareNoun);
  } catch {
    return undefined;
  }
  return { link, note, segment: misread.segment, key: misread.match![1]! };
}

/** One-based position of the first `--add` entry that refuses on its own; entries parse independently, so a refused batch always has one. */
function firstRefusedAddEntry(entries: readonly string[], bareNoun: "file" | "doc"): number {
  return entries.findIndex((entry) => {
    try {
      parseAddEntries([entry], bareNoun);
      return false;
    } catch {
      return true;
    }
  }) + 1;
}

/** The single-entry retry that links the refused entry with its prose moved to `--note`, carrying the invocation's controls. */
function noteRecoveryRetryArgs(params: {
  id: string;
  misread: MisreadNoteSegment;
  options: LinkedArtifactCommandOptions;
  global: GlobalOptions;
  config: LinkedArtifactKindConfig;
}): string[] {
  const { options } = params;
  return [
    ...resolvePmCommandScopeArgs(params.global),
    params.config.metadataKey,
    params.id,
    "--add",
    params.misread.link,
    "--note",
    params.misread.note,
    ...(params.config.supportsAppendStable && options.appendStable === true ? ["--append-stable"] : []),
    ...(options.author ? ["--author", options.author] : []),
    ...(options.message ? ["--message", options.message] : []),
    ...(options.force === true ? ["--force"] : []),
  ];
}

/** What to do about the misread key if it really was meant as one: it is either unknown or repeated. */
function misreadKeyHint(key: string): string {
  return LINKED_ARTIFACT_ADD_KEYS.some((allowed) => allowed === key.toLowerCase())
    ? `If "${key}" was meant as a key, give it once per entry.`
    : `If "${key}" was meant as a key, it is not one of: ${LINKED_ARTIFACT_ADD_KEYS.join(", ")}.`;
}

/**
 * Parse `--add` entries, turning a refusal caused by note prose into one that
 * names the misread segment and offers the same link with the note moved to
 * the standalone `--note` flag, which takes its text verbatim (pm-pwqiao).
 */
function parseAddEntriesWithNoteRecovery(params: {
  id: string;
  entries: string[] | undefined;
  options: LinkedArtifactCommandOptions;
  global: GlobalOptions;
  config: LinkedArtifactKindConfig;
}): LinkedArtifact[] {
  const entries = params.entries ?? [];
  try {
    return parseAddEntries(entries, params.config.bareNoun);
  } catch (error: unknown) {
    // parseAddEntries refuses only with PmCliError; any other failure has no misread note to explain.
    const cause = error as PmCliError;
    const position = firstRefusedAddEntry(entries, params.config.bareNoun);
    const misread = findMisreadNoteSegment(entries[position - 1]!, params.config.bareNoun);
    if (misread === undefined) throw error;
    const retryArgs = noteRecoveryRetryArgs({ ...params, misread });
    const others = entries.length > 1 || (params.options.addGlob?.length ?? 0) > 0;
    throw new PmCliError(
      `--add read the note segment "${misread.segment}" as a new key "${misread.key}", so the ${params.config.bareNoun} link was refused (${cause.message})`,
      EXIT_CODE.USAGE,
      {
        code: "linked_artifact_note_key_misread",
        flag: "--add",
        value: entries[position - 1],
        required: `Pass the note through --note, which takes its text verbatim, or quote the note value.${others ? " The refused invocation wrote nothing, so re-run its other entries too." : ""} ${misreadKeyHint(misread.key)}`,
        why: "After a comma, an identifier followed by = or : opens a new key, so that a typo such as lable=main is refused instead of being stored as note text (GH-258).",
        nextSteps: [renderPmCommand(retryArgs)],
        details: {
          entry_index: position,
          misread_segment: misread.segment,
          misread_key: misread.key,
          note: misread.note,
          cause: cause.context.code ?? "invalid_argument_value",
        },
        recovery: { suggested_retry: renderPmCommand(retryArgs), suggested_retry_args: retryArgs },
      },
    );
  }
}

/**
 * Split a linked-collection mutation projection into the count fields that
 * follow `count` and the receipts that close the result, or nothing for a
 * list read (pm-gh1700). Shared by the files, docs and test result builders.
 */
export function linkedCollectionMutationFields(
  mutation: LinkedCollectionMutationProjection<unknown> | undefined,
): {
  counts: Partial<Pick<LinkedCollectionMutationProjection<unknown>, "total_count" | "returned_count" | "has_more">>;
  receipts: Partial<Pick<LinkedCollectionMutationProjection<unknown>, "mutation_receipt" | "omission_receipt">>;
} {
  if (mutation === undefined) return { counts: {}, receipts: {} };
  return {
    counts: {
      total_count: mutation.total_count,
      returned_count: mutation.returned_count,
      has_more: mutation.has_more,
    },
    receipts: {
      mutation_receipt: mutation.mutation_receipt,
      omission_receipt: mutation.omission_receipt,
    },
  };
}

/** Shared linked-artifact list/mutate command core used by runFiles and runDocs. The kind config selects metadata key, op, bare-path noun, and whether append-stable ordering is honored, preserving each twin's exact semantics. */
export async function runLinkedArtifacts(
  id: string,
  options: LinkedArtifactCommandOptions,
  global: GlobalOptions,
  config: LinkedArtifactKindConfig,
): Promise<LinkedArtifactResult> {
  const { metadataKey } = config;
  const stdinResolver = createStdinTokenResolver();
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const workspaceRoot = resolveWorkspaceRoot(pmRoot);
  const invocationRoot = process.cwd();
  await assertInitializedTracker(pmRoot);
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const resolvedAdds = await stdinResolver.resolveList(options.add, "--add");
  const resolvedAddGlobs = await stdinResolver.resolveList(
    options.addGlob,
    "--add-glob",
  );
  const resolvedRemoves = await stdinResolver.resolveList(
    options.remove,
    "--remove",
  );
  const resolvedMigrations = await stdinResolver.resolveList(
    options.migrate,
    "--migrate",
  );
  const parsedAdds = parseAddEntriesWithNoteRecovery({
    id,
    entries: resolvedAdds,
    options,
    global,
    config,
  }).map((entry) => ({
    ...entry,
    path: anchorLinkedPath(entry.path, workspaceRoot, invocationRoot),
  }));
  const addGlobs = parseAddGlobEntries(resolvedAddGlobs);
  const expandedGlobAdds = await expandAddGlobEntries(
    addGlobs,
    workspaceRoot,
    invocationRoot,
  );
  const adds = applyStandaloneNote(
    [...parsedAdds, ...expandedGlobAdds],
    options.note,
    parsedAdds.length > 0 || addGlobs.length > 0,
  );
  const removes = parseRemoveEntries(resolvedRemoves).map((entry) =>
    anchorLinkedPath(entry, workspaceRoot, invocationRoot),
  );
  const migrations = parseMigrateEntries(resolvedMigrations);
  assertLinkedArtifactMutationIsUnambiguous(adds, removes, migrations);
  const shouldMutate =
    adds.length > 0 || removes.length > 0 || migrations.length > 0;

  if (!shouldMutate) {
    const located = await locateItem(
      pmRoot,
      id,
      settings.id_prefix,
      settings.item_format,
      typeRegistry.type_to_folder,
    );
    if (!located) {
      throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
    }
    const loaded = await readLocatedItem(located, { schema: settings.schema });
    const artifacts =
      ((loaded.document.metadata as Record<string, unknown>)[metadataKey] as
        | LinkedArtifact[]
        | undefined) ?? [];
    return buildLinkedArtifactResult({
      id: located.id,
      artifacts,
      changed: false,
      options,
      workspaceRoot,
    });
  }

  const author = resolveAuthor(options.author, settings.author_default);
  let writtenIndexes: number[] = [];
  let removedCount = 0;
  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: config.op,
    author,
    message: options.message,
    force: options.force,
    skipNoop: true,
    mutate(document) {
      const metadata = document.metadata as Record<string, unknown>;
      const current =
        (metadata[metadataKey] as LinkedArtifact[] | undefined) ?? [];
      const next = [...current];
      const migrated = applyLinkedArtifactMigrations(
        next,
        adds,
        removes,
        migrations,
      );
      const normalized = mergeLinkedArtifactChanges(
        next,
        migrated.adds,
        migrated.removes,
        config.supportsAppendStable && options.appendStable === true,
      );
      if (normalized.length > 0) {
        metadata[metadataKey] = normalized;
      } else {
        delete metadata[metadataKey];
      }
      const changed = !stableValueEquals(current, normalized);
      writtenIndexes = writtenLinkedEntryIndexes(current, normalized);
      removedCount = countRemovedLinkedArtifacts(current, normalized, migrations);
      return {
        changedFields: changed ? [metadataKey] : [],
        warnings:
          changed && migrated.count > 0
            ? [`path_migrations_applied:${migrated.count}`]
            : [],
      };
    },
  });

  const artifacts =
    ((result.item as Record<string, unknown>)[metadataKey] as
      | LinkedArtifact[]
      | undefined) ?? [];
  const migrationWarning = result.warnings.find((warning) =>
    warning.startsWith("path_migrations_applied:"),
  );
  const migrationCount = migrationWarning
    ? Number(migrationWarning.slice("path_migrations_applied:".length))
    : 0;
  return buildLinkedArtifactResult({
    id: result.item.id,
    artifacts,
    changed: result.changedFields.includes(metadataKey),
    migrationsApplied: migrationCount,
    options,
    workspaceRoot,
    mutation: projectLinkedCollectionMutation({
      collectionKey: metadataKey,
      stored: artifacts,
      // Report the persisted entries, not the in-memory drafts, so the receipt matches a later read.
      written: writtenIndexes.map((position) => artifacts[position]!),
      removedCount,
      fullHistory: options.fullHistory === true,
    }),
  });
}

/** Re-key the generic `artifacts` field to the resource-specific name (files/docs) while preserving the original key order and presence so kind-specific result shapes (and their deterministic JSON key ordering) stay byte-identical. */
export function renameArtifactsResultKey<
  Result extends LinkedArtifactResult,
  const Key extends "files" | "docs",
>(result: Result, key: Key): RenamedLinkedArtifactResult<Result, Key> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(result)) {
    out[field === "artifacts" ? key : field] = value;
  }
  return out as RenamedLinkedArtifactResult<Result, Key>;
}
