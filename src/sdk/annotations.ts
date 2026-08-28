/**
 * @module sdk/annotations
 *
 * Implements the pm annotation command command surface and its agent-facing runtime behavior.
 */
import { assertInitializedTracker } from "./environment/tracker-preflight.js";
import { readFile } from "node:fs/promises";
import { isFileAbsentError } from "../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import {
  createStdinTokenResolver,
  parseCsvKv,
  shouldResolveMutationStdinTokens,
  transferMutationStdinTokenPolicy,
} from "../core/item/parse.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { parseLimit } from "../core/shared/numeric-parsers.js";
import { nowIso } from "../core/shared/time.js";
import { resolveAuthor } from "../core/shared/author.js";
import {
  locateItem,
  mutateItem,
  readLocatedItem,
} from "../core/store/item-store.js";
import { resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import type { ItemDocument } from "../types.js";

/** Common persisted shape shared by comments, notes, and learnings. */
export interface AnnotationEntry {
  /** Creation timestamp for the persisted entry. */
  created_at: string;
  /** Stable author attribution recorded with the entry. */
  author: string;
  /** Human-readable annotation body. */
  text: string;
  /** Last edit timestamp when the entry was changed in place. */
  edited_at?: string;
}

/** Common options accepted by annotation primitive operations. */
export interface AnnotationCommandOptions {
  /** Maximum number of newest entries returned. */
  limit?: string;
  /** Author override for mutation attribution. */
  author?: string;
  /** Optional history message describing the mutation. */
  message?: string;
  /** Whether to override an active ownership conflict. */
  force?: boolean;
  /** Whether list results include paging metadata. */
  includeMeta?: boolean;
  /** Return the complete collection after a mutation instead of the bounded mutation receipt. */
  fullHistory?: boolean;
  /** Append only when no entry has the same resolved author and text. */
  ifAbsent?: boolean;
}

/** Identifies the single annotation mutation represented by a bounded response. */
export interface AnnotationMutationReceipt {
  /** Mutation applied to the annotation collection. */
  action: "add" | "edit" | "delete";
  /** Stable one-based collection position targeted by the mutation. */
  entry_index: number;
  /** Number of stored entries changed by the mutation attempt. */
  changed_count: 0 | 1;
  /** Whether the response includes the complete post-mutation collection. */
  full_history_included: boolean;
}

/** Transport-neutral selectors that restore a complete annotation collection. */
export interface AnnotationHistoryRestoration {
  /** Stable semantic selector shared by every transport. */
  selector: "full_history";
  /** Equivalent CLI flag. */
  cli_flag: "--full-history";
  /** Equivalent direct SDK option. */
  sdk_option: "fullHistory";
  /** Equivalent MCP tool option. */
  mcp_option: "full";
}

/** Describes annotation history withheld from a bounded mutation response. */
export interface AnnotationOmissionReceipt {
  /** Whether any historical collection entries were withheld. */
  has_omissions: boolean;
  /** Number of independently restorable field groups withheld. */
  omitted_field_group_count: number;
  /** Omitted groups and the transport-neutral selectors that restore them. */
  omitted_field_groups: Array<{
    name: string;
    restore_with: AnnotationHistoryRestoration;
  }>;
}

/** Map transport-level `full` onto the SDK annotation history option. */
export function normalizeAnnotationTransportOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...options,
    ...(options.full === true ? { fullHistory: true } : {}),
  };
  delete normalized.full;
  return transferMutationStdinTokenPolicy(options, normalized);
}

/** Presentation-layer inputs accepted by the shared annotation source resolver. */
export interface AnnotationSourceOptions {
  /** Inline annotation text or the stdin token (`-`). */
  add?: string;
  /** Read annotation text directly from stdin. */
  stdin?: boolean;
  /** Read annotation text from a UTF-8 file. */
  file?: string;
  /** One-based entry index to replace. */
  edit?: number;
  /** One-based entry index to delete. */
  delete?: number;
}

/** Normalized annotation operation supplied by a presentation layer. */
export interface AnnotationInput {
  /** Normalized operation selected by the presentation layer. */
  mode: "list" | "add" | "stdin" | "file" | "edit" | "delete";
  /** Resolved annotation text. */
  value?: string;
  /** Original input used for flag-like value validation. */
  rawValue?: string;
  /** Flag name used in validation messages. */
  emptyFlag?: string;
  /** One-based entry index for edit and delete operations. */
  index?: number;
}

/** Agent-facing recovery guidance for ownership conflicts. */
export interface OwnershipConflictGuidance {
  /** Actionable requirement shown to the caller. */
  required: string;
  /** Copyable retry examples. */
  examples: string[];
  /** Ordered recovery guidance. */
  nextSteps: string[];
}

/** Domain configuration for one annotation collection primitive. */
export interface AnnotationCommandConfig<
  TKey extends string,
  TEntry extends AnnotationEntry = AnnotationEntry,
> {
  /** Normalized annotation operation. */
  input: AnnotationInput;
  /** Metadata collection that stores this annotation family. */
  collectionKey: TKey;
  /** History operation used for additions. */
  op: Parameters<typeof mutateItem>[0]["op"];
  /** History operation used for edits. */
  editOp?: Parameters<typeof mutateItem>[0]["op"];
  /** History operation used for deletions. */
  deleteOp?: Parameters<typeof mutateItem>[0]["op"];
  /** Domain parser that normalizes resolved text. */
  parseText: (raw: string) => string;
  /** Whether this operation may bypass ownership for a caller-authorized annotation workflow. */
  bypassOwnershipConflict: boolean;
  /** Recovery guidance for ownership conflicts. */
  conflictGuidance: OwnershipConflictGuidance;
  /** Entry factory that preserves or enriches the collection's typed annotation shape. */
  createEntry: (input: {
    created_at: string;
    author: string;
    text: string;
  }) => TEntry;
}

/** Reject mutation of canonical structured events while allowing ordinary annotations. */
function assertAnnotationEntryMutable(
  entry: unknown,
  operation: "edited" | "deleted",
): void {
  if (
    typeof entry === "object" &&
    entry !== null &&
    "format" in entry &&
    entry.format === "json"
  ) {
    throw new PmCliError(
      `Structured context events are append-only and cannot be ${operation}.`,
      EXIT_CODE.USAGE,
      { code: "structured_event_immutable" },
    );
  }
}

/** Structured result returned by an annotation primitive. */
export type AnnotationCommandResult<
  TKey extends string,
  TEntry extends AnnotationEntry,
> = {
  id: string;
  count: number;
} & Record<TKey, TEntry[]> & {
    total_count?: number;
    returned_count?: number;
    has_more?: boolean;
    limit?: number;
    mutation_receipt?: AnnotationMutationReceipt;
    omission_receipt?: AnnotationOmissionReceipt;
    changed?: boolean;
  };

/** Implements limit annotation entries for the public runtime surface of this module. */
export function limitAnnotationEntries<TEntry>(
  values: TEntry[],
  limit: number | undefined,
): TEntry[] {
  if (limit === undefined) return values;
  if (limit === 0) return [];
  return values.slice(Math.max(0, values.length - limit));
}

/** Implements read annotation entries for the public runtime surface of this module. */
export function readAnnotationEntries<TEntry>(
  source: Record<string, unknown>,
  collectionKey: string,
): TEntry[] {
  const value = source[collectionKey];
  return Array.isArray(value) ? (value as TEntry[]) : [];
}

/** Implements parse annotation text input for the public runtime surface of this module. */
export function parseAnnotationTextInput(
  raw: string,
  options: { stripPlainTextPrefix?: boolean } = {},
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const textPrefixMatch = /^(?:[-*+]\s*)?text\s*[:=]/i.exec(trimmed);
  if (
    options.stripPlainTextPrefix === true &&
    textPrefixMatch &&
    !trimmed.startsWith("```")
  ) {
    const text = trimmed.slice(textPrefixMatch[0].length).trim();
    return text || trimmed;
  }
  const looksStructured =
    /^(?:[-*+]\s*)?text\s*[:=]/im.test(trimmed) || trimmed.startsWith("```");
  if (!looksStructured) {
    return trimmed;
  }
  try {
    const kv = parseCsvKv(trimmed, "--add");
    const keys = Object.keys(kv).map((key) => key.trim().toLowerCase());
    if (keys.some((key) => key !== "text")) {
      return trimmed;
    }
    const text = kv.text?.trim();
    return text || trimmed;
  } catch {
    return trimmed;
  }
}

/** Returns whether an unknown file-system failure exposes an errno-like code. */
export function isErrnoError(error: unknown): error is { code?: unknown } {
  return typeof error === "object" && error !== null && "code" in error;
}

/** Refuse presentation-level stdin directives when JSON-RPC owns the process stream. */
export function assertAnnotationStdinTransportAvailable(
  options: AnnotationSourceOptions,
  optionName: string,
): void {
  if (shouldResolveMutationStdinTokens(options)) return;
  throw new PmCliError(
    `${optionName} cannot read process stdin through the MCP JSON-RPC transport. Pass annotation text in options.add instead.`,
    EXIT_CODE.USAGE,
    {
      code: "mcp_stdin_unavailable",
      required:
        "Pass annotation text as JSON data; the MCP protocol already owns process stdin.",
    },
  );
}

async function resolveAnnotationTextSource(
  options: AnnotationSourceOptions,
  noun: string,
): Promise<
  { value: string; rawValue?: string; emptyFlag: string } | undefined
> {
  const sourceCount =
    Number(options.add !== undefined) +
    Number(options.stdin === true) +
    Number(typeof options.file === "string");
  if (sourceCount > 1) {
    throw new PmCliError(
      `Specify ${noun} text using only one input source: --add, --stdin, or --file`,
      EXIT_CODE.USAGE,
    );
  }
  const stdinResolver = createStdinTokenResolver();
  const resolveStdinTokens = shouldResolveMutationStdinTokens(options);
  if (options.add !== undefined) {
    return {
      value:
        (await stdinResolver.resolveValue(
          options.add,
          "--add",
          resolveStdinTokens,
        )) ?? "",
      rawValue: options.add,
      emptyFlag: "--add",
    };
  }
  if (options.stdin === true) {
    assertAnnotationStdinTransportAvailable(options, "--stdin");
    return {
      value: (await stdinResolver.resolveValue("-", "--stdin")) ?? "",
      emptyFlag: "--stdin",
    };
  }
  if (typeof options.file !== "string") return undefined;
  const filePath = options.file.trim();
  if (!filePath) {
    throw new PmCliError("--file path cannot be empty", EXIT_CODE.USAGE);
  }
  if (filePath === "-") {
    assertAnnotationStdinTransportAvailable(options, "--file -");
    return {
      value: (await stdinResolver.resolveValue("-", "--file")) ?? "",
      emptyFlag: "--file",
    };
  }
  try {
    return { value: await readFile(filePath, "utf8"), emptyFlag: "--file" };
  } catch (error: unknown) {
    if (isErrnoError(error) && isFileAbsentError(error)) {
      throw new PmCliError(
        `--file path not found: ${filePath}. Use --file - to read stdin.`,
        EXIT_CODE.USAGE,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new PmCliError(
      `Failed to read --file path "${filePath}": ${detail}. Use --file - to read stdin.`,
      EXIT_CODE.USAGE,
    );
  }
}

/** Resolves mutually exclusive annotation input flags into one normalized SDK operation. */
export async function resolveAnnotationInput(
  options: AnnotationSourceOptions,
  noun: string,
): Promise<AnnotationInput> {
  if (options.edit !== undefined && options.delete !== undefined) {
    throw new PmCliError(
      "Specify only one of --edit or --delete",
      EXIT_CODE.USAGE,
    );
  }
  if (options.delete !== undefined) {
    if (
      options.add !== undefined ||
      options.stdin === true ||
      typeof options.file === "string"
    ) {
      throw new PmCliError(
        "--delete cannot be combined with replacement text",
        EXIT_CODE.USAGE,
      );
    }
    if (!Number.isInteger(options.delete) || options.delete < 1) {
      throw new PmCliError(
        "--delete must be a positive integer",
        EXIT_CODE.USAGE,
      );
    }
    return { mode: "delete", index: options.delete };
  }
  if (
    options.edit !== undefined &&
    (!Number.isInteger(options.edit) || options.edit < 1)
  ) {
    throw new PmCliError("--edit must be a positive integer", EXIT_CODE.USAGE);
  }
  const resolved = await resolveAnnotationTextSource(options, noun);
  if (options.edit !== undefined) {
    if (!resolved) {
      throw new PmCliError(
        "--edit requires replacement text from --add, --stdin, or --file",
        EXIT_CODE.USAGE,
      );
    }
    return { mode: "edit", index: options.edit, ...resolved };
  }
  return resolved ? { mode: "add", ...resolved } : { mode: "list" };
}

/** Implements wrap ownership conflict for the public runtime surface of this module. */
export function wrapOwnershipConflict(
  error: unknown,
  guidance: OwnershipConflictGuidance,
): never {
  if (
    error instanceof PmCliError &&
    error.exitCode === EXIT_CODE.CONFLICT &&
    error.message.includes("is assigned to") &&
    error.message.includes("Use --force to override")
  ) {
    throw new PmCliError(error.message, error.exitCode, {
      code: "ownership_conflict",
      required: guidance.required,
      examples: guidance.examples,
      nextSteps: guidance.nextSteps,
    });
  }
  throw error;
}

function annotationStdinHint(collectionKey: string): string {
  return collectionKey === "comments" ? "--stdin" : "--add -";
}

function assertAnnotationAddValueIsNotFlagLike(
  raw: string,
  config: AnnotationCommandConfig<string, AnnotationEntry>,
): void {
  const emptyFlag = config.input.emptyFlag ?? "--add";
  if (emptyFlag !== "--add") {
    return;
  }
  const trimmed = raw.trim();
  if (!/^-{1,2}[A-Za-z][\w-]*(?:=.*)?$/.test(trimmed)) {
    return;
  }
  const stdinHint = annotationStdinHint(config.collectionKey);
  const commandPrefix =
    config.input.mode === "edit"
      ? `pm ${config.collectionKey} <id> --edit <index>`
      : `pm ${config.collectionKey} <id>`;
  throw new PmCliError(
    `--add value "${trimmed}" looks like an option, not annotation text. Use ${stdinHint} to read stdin, or use text=${trimmed} for literal dash-leading text.`,
    EXIT_CODE.USAGE,
    {
      code: "annotation_flag_like_value",
      required: `Use ${stdinHint} for stdin input, pass plain text, or use text=${trimmed} when the text really starts with "-".`,
      examples: [
        `${commandPrefix} ${stdinHint}`,
        `${commandPrefix} --add text=${trimmed}`,
      ],
    },
  );
}

/**
 * Reject list-mode invocations that pass `--message` without any content
 * source. `--message` only labels a mutation's history entry, so accepting it
 * alone would exit 0 while recording nothing — the GH-588/GH-615 silent
 * data-loss trap. Shared here so comments, notes, and learnings all fail fast
 * with the same structured recovery bundle.
 */
function assertAnnotationMessageHasTextSource(
  config: AnnotationCommandConfig<string, AnnotationEntry>,
  options: AnnotationCommandOptions,
): void {
  if (
    options.ifAbsent === true &&
    !["add", "stdin", "file"].includes(config.input.mode)
  ) {
    throw new PmCliError(
      `--if-absent requires a ${config.collectionKey.replace(/s$/, "")} append`,
      EXIT_CODE.USAGE,
      {
        code: "annotation_if_absent_without_append",
        required:
          "Combine --if-absent with one append text source; omit it for list, edit, and delete operations.",
      },
    );
  }
  if (config.input.mode !== "list" || options.message === undefined) {
    return;
  }
  const noun = config.collectionKey.replace(/s$/, "");
  throw new PmCliError(
    `--message labels a ${noun} mutation but does not provide ${noun} text. Pass text positionally or with --add, --stdin, or --file.`,
    EXIT_CODE.USAGE,
    {
      code: "annotation_message_without_text",
      required: `Provide ${noun} text through a content source; --message only annotates the history entry of a mutation.`,
      examples: [
        `pm ${config.collectionKey} <id> --add "text" --message "why"`,
        `pm ${config.collectionKey} <id> ${annotationStdinHint(config.collectionKey)}`,
      ],
    },
  );
}

/** Append one annotation entry or return the matching entry for an idempotent retry. */
function appendAnnotationEntry<
  TKey extends string,
  TEntry extends AnnotationEntry,
>(
  document: ItemDocument,
  collectionKey: TKey,
  author: string,
  text: string,
  ifAbsent: boolean,
  createEntry: AnnotationCommandConfig<TKey, TEntry>["createEntry"],
): { changedFields: string[]; entryIndex: number } {
  const entries = readAnnotationEntries<TEntry>(
    document.metadata,
    collectionKey,
  );
  const existingIndex = ifAbsent
    ? entries.findIndex(
        (entry) => entry.author === author && entry.text === text,
      )
    : -1;
  if (existingIndex >= 0) {
    return { changedFields: [], entryIndex: existingIndex + 1 };
  }
  entries.push(createEntry({ created_at: nowIso(), author, text }));
  document.metadata[collectionKey] = entries as never;
  return { changedFields: [collectionKey], entryIndex: entries.length };
}

/** Implements run annotation command for the public runtime surface of this module. */
export async function runAnnotationCommand<
  TKey extends string,
  TEntry extends AnnotationEntry,
>(
  id: string,
  options: AnnotationCommandOptions,
  global: GlobalOptions,
  config: AnnotationCommandConfig<TKey, TEntry>,
): Promise<AnnotationCommandResult<TKey, TEntry>> {
  assertAnnotationMessageHasTextSource(config, options);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await assertInitializedTracker(pmRoot);
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const limit = parseLimit(options.limit);

  if (config.input.mode === "list") {
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
    const allEntries = readAnnotationEntries<TEntry>(
      loaded.document.metadata,
      config.collectionKey,
    );
    return renderAnnotationResult(
      located.id,
      config.collectionKey,
      allEntries,
      limit,
      options.includeMeta === true,
    );
  }

  const author = resolveAuthor(options.author, settings.author_default);

  if (config.input.mode === "delete") {
    const op = config.deleteOp ?? config.op;
    let result: Awaited<ReturnType<typeof mutateItem>>;
    try {
      result = await mutateItem({
        pmRoot,
        settings,
        id,
        op,
        author,
        message: options.message,
        force: options.force,
        bypassAssigneeConflict: config.bypassOwnershipConflict,
        mutate(document) {
          const entries = readAnnotationEntries<TEntry>(
            document.metadata,
            config.collectionKey,
          );
          const arrayIndex = resolveAnnotationIndex(
            config.input.index,
            entries.length,
            config.collectionKey,
          );
          assertAnnotationEntryMutable(entries[arrayIndex], "deleted");
          entries.splice(arrayIndex, 1);
          document.metadata[config.collectionKey] = entries as never;
          return { changedFields: [config.collectionKey] };
        },
      });
    } catch (error: unknown) {
      wrapOwnershipConflict(error, config.conflictGuidance);
    }
    const allEntries = readAnnotationEntries<TEntry>(
      result.item,
      config.collectionKey,
    );
    return renderAnnotationResult(
      result.item.id,
      config.collectionKey,
      allEntries,
      limit,
      options.includeMeta === true,
      {
        action: "delete",
        entryIndex: config.input.index as number,
      },
      options.fullHistory === true,
    );
  }

  const rawText = config.input.rawValue ?? config.input.value ?? "";
  assertAnnotationAddValueIsNotFlagLike(rawText, config);
  const text = config.parseText(config.input.value ?? "");
  if (!text.trim()) {
    throw new PmCliError(
      `${config.input.emptyFlag ?? "--add"} text cannot be empty`,
      EXIT_CODE.USAGE,
    );
  }

  if (config.input.mode === "edit") {
    const op = config.editOp ?? config.op;
    let result: Awaited<ReturnType<typeof mutateItem>>;
    try {
      result = await mutateItem({
        pmRoot,
        settings,
        id,
        op,
        author,
        message: options.message,
        force: options.force,
        bypassAssigneeConflict: config.bypassOwnershipConflict,
        mutate(document) {
          const entries = readAnnotationEntries<TEntry>(
            document.metadata,
            config.collectionKey,
          );
          const arrayIndex = resolveAnnotationIndex(
            config.input.index,
            entries.length,
            config.collectionKey,
          );
          const existing = entries[arrayIndex];
          assertAnnotationEntryMutable(existing, "edited");
          entries[arrayIndex] = {
            ...existing,
            text,
            edited_at: nowIso(),
          } as TEntry;
          document.metadata[config.collectionKey] = entries as never;
          return { changedFields: [config.collectionKey] };
        },
      });
    } catch (error: unknown) {
      wrapOwnershipConflict(error, config.conflictGuidance);
    }
    const allEntries = readAnnotationEntries<TEntry>(
      result.item,
      config.collectionKey,
    );
    return renderAnnotationResult(
      result.item.id,
      config.collectionKey,
      allEntries,
      limit,
      options.includeMeta === true,
      {
        action: "edit",
        entryIndex: config.input.index as number,
        entry: allEntries[(config.input.index as number) - 1],
      },
      options.fullHistory === true,
    );
  }

  let result: Awaited<ReturnType<typeof mutateItem>>;
  let entryIndex = 0;
  try {
    result = await mutateItem({
      pmRoot,
      settings,
      id,
      op: config.op,
      author,
      message: options.message,
      force: options.force,
      bypassAssigneeConflict: config.bypassOwnershipConflict,
      skipNoop: options.ifAbsent === true,
      mutate(document) {
        const appended = appendAnnotationEntry(
          document,
          config.collectionKey,
          author,
          text,
          options.ifAbsent === true,
          config.createEntry,
        );
        entryIndex = appended.entryIndex;
        return { changedFields: appended.changedFields };
      },
    });
  } catch (error: unknown) {
    wrapOwnershipConflict(error, config.conflictGuidance);
  }

  const allEntries = readAnnotationEntries<TEntry>(
    result.item,
    config.collectionKey,
  );
  return renderAnnotationResult(
    result.item.id,
    config.collectionKey,
    allEntries,
    limit,
    options.includeMeta === true,
    {
      action: "add",
      entryIndex,
      entry: allEntries[entryIndex - 1],
      changedCount:
        options.ifAbsent === true
          ? (Math.min(result.changedFields.length, 1) as 0 | 1)
          : undefined,
    },
    options.fullHistory === true,
  );
}

/** Implements resolve annotation index for the public runtime surface of this module. */
export function resolveAnnotationIndex(
  oneBasedIndex: number | undefined,
  count: number,
  collectionKey: string,
): number {
  if (
    oneBasedIndex === undefined ||
    !Number.isInteger(oneBasedIndex) ||
    oneBasedIndex < 1 ||
    oneBasedIndex > count
  ) {
    const singular = collectionKey.replace(/s$/, "");
    const label = `${singular.charAt(0).toUpperCase()}${singular.slice(1)}`;
    const noun = count === 1 ? `1 ${singular}` : `${count} ${collectionKey}`;
    throw new PmCliError(
      `${label} index ${oneBasedIndex ?? "(missing)"} out of range (item has ${noun})`,
      EXIT_CODE.USAGE,
    );
  }
  return oneBasedIndex - 1;
}

function renderAnnotationResult<
  TKey extends string,
  TEntry extends AnnotationEntry,
>(
  id: string,
  collectionKey: TKey,
  allEntries: TEntry[],
  limit: number | undefined,
  includeMeta: boolean,
  mutation?: {
    action: "add" | "edit" | "delete";
    entryIndex: number;
    entry?: TEntry;
    changedCount?: 0 | 1;
  },
  fullHistory = false,
): AnnotationCommandResult<TKey, TEntry> {
  const entries =
    mutation === undefined || fullHistory
      ? limitAnnotationEntries(
          allEntries,
          mutation !== undefined && fullHistory ? undefined : limit,
        )
      : mutation.entry === undefined
        ? []
        : [mutation.entry];
  const historyOmitted =
    mutation !== undefined && entries.length < allEntries.length;
  return {
    id,
    [collectionKey]: entries,
    count: entries.length,
    ...(mutation?.changedCount === undefined
      ? {}
      : { changed: mutation.changedCount === 1 }),
    ...([includeMeta, mutation !== undefined].includes(true)
      ? {
          total_count: allEntries.length,
          returned_count: entries.length,
          has_more: historyOmitted || entries.length < allEntries.length,
          ...(limit !== undefined ? { limit } : {}),
        }
      : {}),
    ...(mutation === undefined
      ? {}
      : {
          mutation_receipt: {
            action: mutation.action,
            entry_index: mutation.entryIndex,
            changed_count: mutation.changedCount ?? 1,
            full_history_included: !historyOmitted,
          },
          omission_receipt: {
            has_omissions: historyOmitted,
            omitted_field_group_count: historyOmitted ? 1 : 0,
            omitted_field_groups: historyOmitted
              ? [
                  {
                    name: `${collectionKey}_history`,
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
        }),
  } as AnnotationCommandResult<TKey, TEntry>;
}
