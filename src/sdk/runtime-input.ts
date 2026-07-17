/**
 * @module sdk/runtime-input
 *
 * Normalizes untyped action payload values at the SDK runtime boundary. These
 * primitives are shared by native action dispatchers and MCP-specific adapters.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { asRecordClone } from "../core/shared/primitives.js";
import {
  normalizeListOptions,
  normalizeUpdateOptions,
} from "../cli/registration-helpers.js";
import type { CloseManyCommandOptions } from "../cli/commands/close-many.js";
import type { UpdateManyCommandOptions } from "../cli/commands/update-many.js";
import { UPDATE_COMMANDER_STRING_OPTION_CONTRACTS } from "./cli-contracts/commander-mutation-options.js";
import type { GraphCommandOptions } from "./graph/run.js";
import type { ListOptions } from "./query/list.js";

/** Read a non-empty string without altering its caller-provided whitespace. */
export function readRuntimeString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/** Normalize a non-empty string or finite number into a scalar string. */
export function readRuntimeScalarString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : undefined;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

/** Normalize a string, including blank text, or a finite number into text. */
export function readRuntimeScalarStringAllowBlank(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

/** Narrow unknown values to plain record-shaped action payloads. */
export function isRuntimeRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse an integer-valued MCP option while retaining a caller-specific label. */
export function parseRuntimeInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new PmCliError(
        `${label} must be a finite integer.`,
        EXIT_CODE.USAGE,
      );
    }
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      throw new PmCliError(
        `${label} must be a finite integer.`,
        EXIT_CODE.USAGE,
      );
    }
    return parsed;
  }
  return undefined;
}

/** Fixed SDK-runtime global options derived from one untyped action payload. */
export function actionGlobalOptions(
  args: Record<string, unknown>,
): GlobalOptions {
  return {
    json: true,
    quiet: true,
    path: readRuntimeString(args, "path"),
    noExtensions: args.noExtensions === true || args.no_extensions === true,
    noPager: true,
  };
}

/** Fields whose MCP array values collapse into the CLI's CSV spelling. */
const ARRAY_TO_CSV_FIELDS = new Set([
  "tags",
  "blockedBy",
  "blocked_by",
  "skills",
  "fields",
]);

/** Fields whose scalar MCP values promote into the CLI's repeatable arrays. */
const SCALAR_TO_ARRAY_FIELDS = new Set([
  "comment",
  "note",
  "learning",
  "reminder",
  "event",
  "dep",
  "depRemove",
  "dep_remove",
  "file",
  "doc",
  "test",
  "unset",
  "addGlob",
  "add_glob",
  "migrate",
  "envSet",
  "env_set",
  "envClear",
  "env_clear",
]);

// Actions where the linked-resource fields `add` and `remove` are string[] arrays.
// For other actions (comments/notes/learnings) `add` and `remove` are scalar strings
// and must NOT be auto-promoted.
const ARRAY_ADD_REMOVE_ACTIONS = new Set([
  "files",
  "files-discover",
  "docs",
  "test",
  "test-all",
]);

/** Lifecycle actions where a top-level assignee argument aliases the author. */
const LIFECYCLE_AUTHOR_ALIAS_ACTIONS = new Set([
  "claim",
  "release",
  "start-task",
  "pause-task",
  "close-task",
]);

/** Reconcile MCP array/scalar option spellings with CLI flag expectations. */
export function normalizeMcpOptionsArrays(
  options: Record<string, unknown>,
  action?: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const promoteAddRemove =
    action !== undefined && ARRAY_ADD_REMOVE_ACTIONS.has(action);
  const preserveStandaloneNote =
    action === "files" || action === "files-discover" || action === "docs";
  for (const [key, value] of Object.entries(options)) {
    if (Array.isArray(value) && ARRAY_TO_CSV_FIELDS.has(key)) {
      result[key] = value.join(",");
      continue;
    }
    if (key === "note" && preserveStandaloneNote) {
      result[key] = value;
      continue;
    }
    if (typeof value === "string" && SCALAR_TO_ARRAY_FIELDS.has(key)) {
      result[key] = [value];
      continue;
    }
    if (
      typeof value === "string" &&
      promoteAddRemove &&
      (key === "add" || key === "remove")
    ) {
      result[key] = [value];
      continue;
    }
    result[key] = value;
  }
  return result;
}

/** Merge hoisted top-level action arguments and author aliases into options. */
export function optionsWithAuthor(
  args: Record<string, unknown>,
  action?: string,
): Record<string, unknown> {
  const baseOptions = asRecordClone(args.options);
  const hoistedTopLevel: Record<string, unknown> = {};
  const hoistKey = (key: string): void => {
    if (baseOptions[key] !== undefined || args[key] === undefined) {
      return;
    }
    hoistedTopLevel[key] = args[key];
  };
  if (action === "list") {
    hoistKey("status");
    hoistKey("type");
    hoistKey("tag");
    hoistKey("priority");
    hoistKey("limit");
    hoistKey("offset");
  } else if (action === "search") {
    hoistKey("mode");
    hoistKey("status");
    hoistKey("type");
    hoistKey("tag");
    hoistKey("priority");
    hoistKey("limit");
  } else if (action === "create") {
    hoistKey("title");
    hoistKey("type");
    hoistKey("status");
    hoistKey("description");
    hoistKey("body");
    hoistKey("priority");
    hoistKey("tags");
    hoistKey("parent");
    hoistKey("createMode");
    hoistKey("create_mode");
    hoistKey("allowMissingParent");
  } else if (action === "close") {
    hoistKey("duplicateOf");
  } else if (action === "append") {
    // pm-7u9j: the narrow pm_append tool declares `body` top-level; runAppend
    // reads it from options, so hoist unless options.body already wins.
    // (pm_schema/pm_config top-level args are consumed directly by runAction's
    // schema/config cases, which read args before options — no hoist needed.)
    hoistKey("body");
  }
  const options = normalizeMcpOptionsArrays(
    { ...hoistedTopLevel, ...baseOptions },
    action,
  );
  const author = readRuntimeString(args, "author");
  const authorFromAssignee =
    action !== undefined && LIFECYCLE_AUTHOR_ALIAS_ACTIONS.has(action)
      ? (readRuntimeString(args, "assignee") ??
        readRuntimeString(options, "assignee"))
      : undefined;
  if (author && options.author === undefined) {
    return { ...options, author };
  }
  if (authorFromAssignee && options.author === undefined) {
    return { ...options, author: authorFromAssignee };
  }
  return options;
}

// GH-170 (pm-pfnx): the narrow pm_files/pm_docs tools spell the CLI --note flag
// as `addNote` (the shared `note` parameter is the array-typed create/update
// note seed). Translate it onto the runner's `note` option; an explicit
// options.note (pm_run callers) wins.
/** Translate the MCP-only addNote spelling onto the runner note option. */
export function withAddNoteOption(
  options: Record<string, unknown>,
): Record<string, unknown> {
  if (options.addNote === undefined) {
    return options;
  }
  const next: Record<string, unknown> = { ...options };
  if (next.note === undefined && typeof next.addNote === "string") {
    next.note = next.addNote;
  }
  delete next.addNote;
  return next;
}

/** Map files-discover MCP controls onto the files runner's option shape. */
export function withFilesDiscoveryOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...options };
  if (
    next.discoveryNote !== undefined &&
    next.note === undefined &&
    typeof next.discoveryNote === "string"
  ) {
    next.note = next.discoveryNote;
  }
  delete next.discover;
  delete next.discoveryNote;
  return next;
}

/** Canonicalize one action name into lower-kebab-case tokens. */
export function normalizeActionName(value: string): string {
  const chunks: string[] = [];
  let lastWasSeparator = true;
  for (const character of value.trim().toLowerCase()) {
    const isAlphaNumeric =
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9");
    if (isAlphaNumeric) {
      chunks.push(character);
      lastWasSeparator = false;
      continue;
    }
    if (!lastWasSeparator) {
      chunks.push("-");
      lastWasSeparator = true;
    }
  }
  if (chunks.at(-1) === "-") {
    chunks.pop();
  }
  return chunks.join("");
}

/** Canonicalize one space-separated command path for lookup comparisons. */
export function normalizeCommandPath(value: string): string {
  return value.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** Coerce an unknown payload value into a non-empty string array. */
export function readRuntimeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry))
    .filter((entry) => entry.length > 0);
}

/** Merge non-reserved top-level extension arguments into the options record. */
export function extensionOptionsFromArgs(
  args: Record<string, unknown>,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const reserved = new Set([
    "action",
    "args",
    "author",
    "cwd",
    "fullChangedFields",
    "id",
    "options",
    "path",
    "query",
    "reason",
    "target",
  ]);
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!reserved.has(key)) {
      passthrough[key] = value;
    }
  }
  const normalizedOptions = { ...passthrough, ...options };
  delete normalizedOptions.args;
  return normalizedOptions;
}

/** Mutation tools (create/update/close/append/update-many) return a verbose `changed_fields` array. On the agent path we drop it to a `changed_field_count` by default for token efficiency, restoring the full array only when the caller explicitly passes the MCP-level fullChangedFields=true control. Mutation options are forwarded unchanged so runtime fields named `full` remain valid user data. */
export function withMutationCompaction(
  args: Record<string, unknown>,
  options?: Record<string, unknown> | null,
): {
  changedFields: "full" | "compact";
  idOnly: boolean;
  runnerOptions: Record<string, unknown>;
} {
  return {
    changedFields: args.fullChangedFields === true ? "full" : "compact",
    idOnly: args.idOnly === true,
    runnerOptions: { ...options },
  };
}

/** Translate flat MCP filter parameters into the shared list-option shape. */
export function mutationListOptions(
  options: Record<string, unknown>,
): ListOptions {
  return {
    type: readRuntimeScalarString(options, "filterType"),
    tag: readRuntimeScalarString(options, "filterTag"),
    priority: readRuntimeScalarString(options, "filterPriority"),
    deadlineBefore: readRuntimeScalarString(options, "filterDeadlineBefore"),
    deadlineAfter: readRuntimeScalarString(options, "filterDeadlineAfter"),
    updatedAfter: readRuntimeScalarString(options, "filterUpdatedAfter"),
    updatedBefore: readRuntimeScalarString(options, "filterUpdatedBefore"),
    createdAfter: readRuntimeScalarString(options, "filterCreatedAfter"),
    createdBefore: readRuntimeScalarString(options, "filterCreatedBefore"),
    ids: readRuntimeScalarStringAllowBlank(options, "ids"),
    assignee: readRuntimeScalarString(options, "filterAssignee"),
    assigneeFilter:
      readRuntimeScalarString(options, "filterAssigneeFilter") ??
      readRuntimeScalarString(options, "filterAssignee_filter"),
    parent: readRuntimeScalarString(options, "filterParent"),
    sprint: readRuntimeScalarString(options, "filterSprint"),
    release: readRuntimeScalarString(options, "filterRelease"),
    limit: readRuntimeScalarString(options, "limit"),
    offset: readRuntimeScalarString(options, "offset"),
  };
}

/** Read one graph option that accepts scalar strings or repeatable arrays. */
function readGraphIdListOption(value: unknown): string | string[] | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (Array.isArray(value)) return readRuntimeStringArray(value);
  return undefined;
}

/** Read one graph bound that accepts integer numbers or numeric strings. */
function readGraphBoundOption(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) return value;
  return undefined;
}

/** Build graph command options from one flat MCP parameter payload. */
export function graphOptionsFromFlat(
  options: Record<string, unknown>,
): GraphCommandOptions {
  const kind = readGraphIdListOption(options.kind);
  const exemptIsolate = readGraphIdListOption(options.exemptIsolate);
  return {
    ...(kind === undefined ? {} : { kind }),
    maxDepth: readGraphBoundOption(options.maxDepth),
    limit: readGraphBoundOption(options.limit),
    after: readRuntimeString(options, "after"),
    direction: readRuntimeString(options, "direction"),
    maxPaths: readGraphBoundOption(options.maxPaths),
    sample: readGraphBoundOption(options.sample),
    ...(exemptIsolate === undefined ? {} : { exemptIsolate }),
    summary: options.summary === true,
  };
}

/** Build close-many command options from one flat MCP parameter payload. */
export function closeManyOptionsFromFlat(
  options: Record<string, unknown>,
): CloseManyCommandOptions {
  return {
    status: readRuntimeString(options, "filterStatus"),
    list: isRuntimeRecord(options.list)
      ? normalizeListOptions(options.list)
      : mutationListOptions(options),
    reason: readRuntimeString(options, "reason"),
    resolution: readRuntimeString(options, "resolution"),
    expectedResult:
      readRuntimeString(options, "expectedResult") ??
      readRuntimeString(options, "expected_result") ??
      readRuntimeString(options, "expected"),
    actualResult:
      readRuntimeString(options, "actualResult") ??
      readRuntimeString(options, "actual_result") ??
      readRuntimeString(options, "actual"),
    validateClose:
      readRuntimeString(options, "validateClose") ??
      readRuntimeString(options, "validate_close"),
    author: readRuntimeString(options, "author"),
    message: readRuntimeString(options, "message"),
    force: options.force === true ? true : undefined,
    dryRun:
      options.dryRun === true || options.dry_run === true ? true : undefined,
    rollback: readRuntimeString(options, "rollback"),
    checkpoint:
      options.checkpoint === false ||
      options.noCheckpoint === true ||
      options.no_checkpoint === true
        ? false
        : undefined,
  };
}

/** Flat update-many parameters that steer batching instead of item fields. */
const UPDATE_MANY_FLAT_CONTROL_KEYS = new Set([
  "filterStatus",
  "filterType",
  "filterTag",
  "filterPriority",
  "filterDeadlineBefore",
  "filterDeadlineAfter",
  "filterUpdatedAfter",
  "filterUpdatedBefore",
  "filterCreatedAfter",
  "filterCreatedBefore",
  "filterAssignee",
  "filterAssigneeFilter",
  "filterAssignee_filter",
  "filterParent",
  "filterSprint",
  "filterRelease",
  "ids",
  "list",
  "update",
  "limit",
  "offset",
  "dryRun",
  "dry_run",
  "rollback",
  "checkpoint",
  "noCheckpoint",
  "no_checkpoint",
]);

/** Extract per-item update fields from one flat update-many payload. */
export function updateManyUpdateOptionsFromFlat(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (UPDATE_MANY_FLAT_CONTROL_KEYS.has(key)) {
      continue;
    }
    update[key] = value;
  }
  return normalizeMcpUpdateOptions(update);
}

/** Normalize MCP update fields onto the CLI update option contract. */
export function normalizeMcpUpdateOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedInput: Record<string, unknown> = normalizeMcpOptionsArrays(
    options,
    "update-many",
  );
  for (const contract of UPDATE_COMMANDER_STRING_OPTION_CONTRACTS) {
    for (const key of contract.keys) {
      const value = normalizedInput[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        normalizedInput[key] = String(value);
      }
    }
  }
  return normalizeUpdateOptions(normalizedInput);
}

/** Build update-many command options from one flat MCP parameter payload. */
export function updateManyOptionsFromFlat(
  options: Record<string, unknown>,
): UpdateManyCommandOptions {
  if (isRuntimeRecord(options.list) || isRuntimeRecord(options.update)) {
    const updateSource = isRuntimeRecord(options.update)
      ? options.update
      : updateManyUpdateOptionsFromFlat(options);
    return {
      status: readRuntimeScalarString(options, "filterStatus"),
      list: isRuntimeRecord(options.list)
        ? normalizeListOptions(options.list)
        : mutationListOptions(options),
      update: normalizeMcpUpdateOptions(updateSource) as never,
      dryRun:
        options.dryRun === true || options.dry_run === true ? true : undefined,
      rollback: readRuntimeString(options, "rollback"),
      checkpoint:
        options.checkpoint === false ||
        options.noCheckpoint === true ||
        options.no_checkpoint === true
          ? false
          : undefined,
    };
  }
  return {
    status: readRuntimeScalarString(options, "filterStatus"),
    list: mutationListOptions(options),
    update: updateManyUpdateOptionsFromFlat(options) as never,
    dryRun:
      options.dryRun === true || options.dry_run === true ? true : undefined,
    rollback: readRuntimeString(options, "rollback"),
    checkpoint:
      options.checkpoint === false ||
      options.noCheckpoint === true ||
      options.no_checkpoint === true
        ? false
        : undefined,
  };
}
