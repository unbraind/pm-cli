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
import { renderPmCommand } from "../core/shared/command-line.js";
import { resolvePmCommandScopeArgs } from "./command-line.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { parseLimit } from "../core/shared/numeric-parsers.js";
import { nowIso } from "../core/shared/time.js";
import { readCompactionMarker } from "../core/shared/text-normalization.js";
import { resolveAuthor } from "../core/shared/author.js";
import {
  locateItem,
  mutateItem,
  readLocatedItem,
} from "../core/store/item-store.js";
import { resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import { CANONICALLY_ORDERED_LOG_COLLECTIONS, compareLogValues } from "../core/item/item-format.js";
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
  /**
   * For `--edit`/`--delete`: the `created_at` of the entry the caller read at
   * that index. The write is refused when the addressed entry has a different
   * `created_at`; this compares timestamps, not entry identities.
   */
  expectAt?: string;
}

/**
 * One listed annotation entry carrying its absolute one-based position in the
 * stored collection: the address `--edit` and `--delete` accept, whatever
 * page, limit or filter delivered the row (pm-hka7ep).
 */
export type IndexedAnnotationEntry<TEntry = AnnotationEntry> = { index: number } & TEntry;

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

/**
 * Whether a stored annotation entry is a plain record. Malformed entries (a
 * bare string, a number, null) load and are delivered as stored (pm-30tjoh),
 * so field reads and spreads go through this check.
 */
function isAnnotationRecord(entry: unknown): entry is Partial<AnnotationEntry> {
  return Object.prototype.toString.call(entry) === "[object Object]";
}

/**
 * The entry an edit writes: the stored record with new text, or, for a
 * malformed stored entry, a well-formed replacement instead of a spread of a
 * string into character keys. A record missing a usable created_at or author
 * gains them, keeping every other stored field, so the repaired row can be
 * guarded with --expect-at afterwards.
 */
function editedAnnotationEntry<TEntry extends AnnotationEntry>(
  existing: unknown,
  text: string,
  author: string,
  createEntry: (input: { created_at: string; author: string; text: string }) => TEntry,
): TEntry {
  const now = nowIso();
  if (!isAnnotationRecord(existing)) {
    return { ...createEntry({ created_at: now, author, text }), text, edited_at: now };
  }
  const usable = (value: unknown): boolean => typeof value === "string" && value !== "";
  return {
    ...existing,
    ...(usable(existing.created_at) ? {} : { created_at: now }),
    ...(usable(existing.author) ? {} : { author }),
    text,
    edited_at: now,
  } as TEntry;
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
} & Record<TKey, Array<IndexedAnnotationEntry<TEntry>>> & {
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

/** Refusal code for annotation text that is an option token a parser bound as a text flag's value; the refusals spell it literally for the error catalog. */
export const ANNOTATION_FLAG_LIKE_VALUE_CODE = "annotation_flag_like_value";

/** Whether annotation text is an option token such as `--file` or `--file=x`; `text=` escapes literal dash-leading text. */
export function isFlagLikeAnnotationValue(raw: string): boolean {
  return /^-{1,2}[A-Za-z][\w-]*(?:=.*)?$/.test(raw.trim());
}

/**
 * The own form of an annotation source option a text flag took as its value
 * (pm-y26mvc): `--add --file note.md` means `--file note.md`, so the recovery
 * is to drop `--add`, not to switch to stdin. Undefined for any other token.
 */
function annotationSourceOptionForm(token: string): string | undefined {
  if (token === "--file") return "--file <path>";
  if (token.startsWith("--file=")) return token;
  return token === "--stdin" ? "--stdin" : undefined;
}

/** Inputs for the refusal raised when annotation text is an option token. */
export interface FlagLikeAnnotationValueRefusalInput {
  /** Annotation collection key: `comments`, `notes`, or `learnings`. */
  collectionKey: string;
  /** Text option that received the token, such as `--add`. */
  textFlag: string;
  /** The option token received as annotation text. */
  value: string;
  /** Command the examples start with, such as `pm comments <id>`. */
  commandPrefix: string;
  /** Executable retry of the caller's invocation, when the caller knows one. */
  retryArgs?: string[];
  /** Positional text that followed the token and that the source option cannot be combined with. */
  conflictingOperand?: string;
}

/**
 * Build the refusal for annotation text that is an option token. A source
 * option (`--file`, `--stdin`) is named in its own form so the agent learns
 * that it works without the text flag; any other token keeps the stdin and
 * `text=` escape guidance. A supplied retry is carried as recovery with the
 * text flag as `field` and the token as the suggested flag, which lets the
 * CLI rewrite it as a minimal edit of the typed argv.
 */
export function createFlagLikeAnnotationValueRefusal(
  input: FlagLikeAnnotationValueRefusalInput,
): PmCliError {
  const trimmed = input.value.trim();
  const noun = input.collectionKey.replace(/s$/, "");
  const sourceForm = annotationSourceOptionForm(trimmed);
  const stdinHint = annotationStdinHint(input.collectionKey);
  const retry =
    input.retryArgs === undefined
      ? {}
      : {
          field: input.textFlag,
          recovery: {
            suggested_flags: [trimmed],
            suggested_retry: renderPmCommand(input.retryArgs),
            suggested_retry_args: [...input.retryArgs],
          },
        };
  if (sourceForm !== undefined) {
    const sourceFlag = sourceForm.split(/[ =]/, 1)[0];
    const source = sourceFlag === "--file" ? "that file" : "stdin";
    const operandNote =
      input.conflictingOperand === undefined
        ? ""
        : ` "${input.conflictingOperand}" was read as positional text, which ${sourceFlag} cannot be combined with: drop it, or pass it as the text without ${sourceFlag}.`;
    return new PmCliError(
      `${input.textFlag} value "${trimmed}" looks like an option, not annotation text: ${input.textFlag} took ${sourceFlag} as its value. Drop ${input.textFlag} and pass ${sourceForm} on its own.${operandNote}`,
      EXIT_CODE.USAGE,
      {
        code: "annotation_flag_like_value",
        required: `Drop ${input.textFlag}: ${sourceForm} reads the ${noun} text from ${source} by itself. Use ${input.textFlag} text=${trimmed} only when the text really is "${trimmed}".`,
        examples: [
          `${input.commandPrefix} ${sourceForm}`,
          `${input.commandPrefix} ${input.textFlag} text=${trimmed}`,
        ],
        ...retry,
      },
    );
  }
  return new PmCliError(
    `${input.textFlag} value "${trimmed}" looks like an option, not annotation text. Use ${stdinHint} to read stdin, or use text=${trimmed} for literal dash-leading text.`,
    EXIT_CODE.USAGE,
    {
      code: "annotation_flag_like_value",
      required: `Use ${stdinHint} for stdin input, pass plain text, or use text=${trimmed} when the text really starts with "-".`,
      examples: [
        `${input.commandPrefix} ${stdinHint}`,
        `${input.commandPrefix} ${input.textFlag} text=${trimmed}`,
      ],
      ...retry,
    },
  );
}

function assertAnnotationAddValueIsNotFlagLike(
  raw: string,
  config: AnnotationCommandConfig<string, AnnotationEntry>,
): void {
  const emptyFlag = config.input.emptyFlag ?? "--add";
  if (emptyFlag !== "--add" || !isFlagLikeAnnotationValue(raw)) {
    return;
  }
  throw createFlagLikeAnnotationValueRefusal({
    collectionKey: config.collectionKey,
    textFlag: "--add",
    value: raw,
    commandPrefix:
      config.input.mode === "edit"
        ? `pm ${config.collectionKey} <id> --edit <index>`
        : `pm ${config.collectionKey} <id>`,
  });
}

/**
 * Refuse an edit whose replacement ends with the read-output compaction marker
 * (pm-n98pir). Budgeted reads shorten long entries to a prefix plus
 * `…[+N chars]`, so such text was copied from a compacted read, and writing it
 * back would silently drop the stored entry's remaining characters. A bare
 * trailing ellipsis is ordinary text and still succeeds.
 */
function assertAnnotationEditTextIsNotCompacted(
  id: string,
  text: string,
  config: AnnotationCommandConfig<string, AnnotationEntry>,
  global: GlobalOptions,
): void {
  if (config.input.mode !== "edit") return;
  const omitted = readCompactionMarker(text);
  if (omitted === undefined) return;
  const noun = config.collectionKey.replace(/s$/, "");
  const index = config.input.index as number;
  // The recovery targets the tracker the edit addressed, never the cwd default.
  const scope = resolvePmCommandScopeArgs(global);
  throw new PmCliError(
    `Replacement text for ${noun} ${index} on ${id} ends with the read-output compaction marker, so it was copied from a compacted read that left out ${omitted} characters. Nothing was written.`,
    EXIT_CODE.USAGE,
    {
      code: "annotation_text_compacted",
      item_id: id,
      details: { collection: config.collectionKey, entry_index: index, omitted_characters: omitted },
      required: `Read the whole ${noun} with --output-budget unbounded, apply the change to the full text, and retry the edit without the trailing marker.`,
      why: "A budgeted read shortens long entries to a prefix plus a marker naming how many characters it left out; editing from that text would replace the stored entry with the shortened prefix.",
      examples: [
        renderPmCommand([...scope, config.collectionKey, id, "--output-budget", "unbounded", "--json"]),
        `${renderPmCommand([...scope, config.collectionKey, id, "--edit", String(index), "--file"])} <full-text-file>`,
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
  assertAnnotationExpectationTargetsEntry(config, options);
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

/** Refuse an entry expectation that has no addressed entry to compare against. */
function assertAnnotationExpectationTargetsEntry(
  config: AnnotationCommandConfig<string, AnnotationEntry>,
  options: AnnotationCommandOptions,
): void {
  if (options.expectAt === undefined) return;
  if (config.input.mode !== "edit" && config.input.mode !== "delete") {
    throw new PmCliError(
      `--expect-at guards an --edit or --delete of one ${config.collectionKey.replace(/s$/, "")}`,
      EXIT_CODE.USAGE,
      {
        code: "annotation_expectation_without_target",
        required:
          "Combine --expect-at with --edit <index> or --delete <index>; omit it for list and append operations.",
        examples: [
          `pm ${config.collectionKey} <id> --edit <index> --expect-at <created_at> --add "<text>"`,
          `pm ${config.collectionKey} <id> --delete <index> --expect-at <created_at>`,
        ],
      },
    );
  }
  if (typeof options.expectAt !== "string" || options.expectAt.trim().length === 0) {
    throw new PmCliError("--expect-at must be the non-empty created_at timestamp of the entry you read", EXIT_CODE.USAGE, {
      code: "annotation_expectation_invalid",
      required: "Pass the created_at value of the row you read at that index, as a string.",
    });
  }
}

/**
 * Refuse an edit or delete whose addressed entry is not the one the caller
 * read (pm-hka7ep). The refusal names every index whose entry carries the
 * expected timestamp, so the caller can retarget without re-listing.
 */
function assertExpectedAnnotationEntry(
  id: string,
  entries: readonly AnnotationEntry[],
  arrayIndex: number,
  config: AnnotationCommandConfig<string, AnnotationEntry>,
  expectAt: string | undefined,
): void {
  if (expectAt === undefined) return;
  // A malformed stored entry (pm-30tjoh) may be null, not an object, or carry
  // a non-string created_at; only a stored string is reported as the time.
  const stored: unknown = (entries[arrayIndex] as Partial<AnnotationEntry> | null)?.created_at;
  const actual = typeof stored === "string" ? stored : null;
  if (actual === expectAt) return;
  const matchingIndexes = entries.flatMap((entry, position) =>
    (entry as Partial<AnnotationEntry> | null)?.created_at === expectAt ? [position + 1] : [],
  );
  const noun = config.collectionKey.replace(/s$/, "");
  const action = config.input.mode === "delete" ? "--delete" : "--edit";
  const entryIndex = arrayIndex + 1;
  const retarget =
    matchingIndexes.length === 1
      ? ` The ${noun} created at ${expectAt} is at index ${matchingIndexes[0]}.`
      : matchingIndexes.length > 1
        ? ` ${matchingIndexes.length} ${config.collectionKey} were created at ${expectAt}: indexes ${matchingIndexes.join(", ")}.`
        : ` No ${noun} on ${id} was created at ${expectAt}.`;
  throw new PmCliError(
    `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${entryIndex} on ${id} was created at ${actual || "an unrecorded time (malformed entry)"}, not ${expectAt}; refusing ${action} of an entry the caller did not read. Nothing was written.${retarget}`,
    EXIT_CODE.CONFLICT,
    {
      code: "annotation_entry_mismatch",
      item_id: id,
      details: {
        collection: config.collectionKey,
        entry_index: entryIndex,
        expected_created_at: expectAt,
        actual_created_at: actual,
        matching_indexes: matchingIndexes,
      },
      required: `Address the ${noun} by the index its listing row reports and keep --expect-at set to that row's created_at. When several indexes share the timestamp, inspect those rows before retrying, because the guard compares timestamps, not entry identities.`,
      why: "A listing page's position or count is not an entry address; only the row's index is, and the expectation checks that the entry at that index still carries the created_at that was read.",
      examples: [
        `pm ${config.collectionKey} ${id} --limit 5`,
        `pm ${config.collectionKey} ${id} ${action} ${matchingIndexes.length === 1 ? matchingIndexes[0] : "<index>"} --expect-at ${expectAt}${action === "--edit" ? ' --add "<text>"' : ""}`,
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
): { changedFields: string[]; written: readonly TEntry[]; position: number } {
  const entries = readAnnotationEntries<TEntry>(
    document.metadata,
    collectionKey,
  );
  const existingIndex = ifAbsent
    ? entries.findIndex(
        (entry) => isAnnotationRecord(entry) && entry.author === author && entry.text === text,
      )
    : -1;
  if (existingIndex >= 0) {
    return { changedFields: [], written: entries, position: existingIndex };
  }
  entries.push(createEntry({ created_at: nowIso(), author, text }));
  document.metadata[collectionKey] = entries as never;
  return { changedFields: [collectionKey], written: entries, position: entries.length - 1 };
}

/**
 * The one-based address of the entry at `position` of the collection as
 * written, after the store's canonical ordering (created_at, then text, then
 * author, stable). An entry appended behind a later-stamped one, or an edit
 * that changes text among entries sharing a created_at, moves; following the
 * written position through the same stable sort tracks exactly that entry,
 * even among identical duplicates.
 */
function canonicalAnnotationAddress(
  collectionKey: string,
  written: readonly AnnotationEntry[],
  position: number,
): number {
  // A custom SDK collection is stored in write order, so its push position is its address.
  if (!CANONICALLY_ORDERED_LOG_COLLECTIONS.has(collectionKey)) return position + 1;
  const order = written
    .map((_entry, index) => index)
    .sort((left, right) => compareLogValues(written[left]!, written[right]!) || left - right);
  return order.indexOf(position) + 1;
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
          assertExpectedAnnotationEntry(id, entries, arrayIndex, config, options.expectAt);
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
  assertAnnotationEditTextIsNotCompacted(id, text, config, global);

  if (config.input.mode === "edit") {
    const op = config.editOp ?? config.op;
    let result: Awaited<ReturnType<typeof mutateItem>>;
    let editedAddress = 0;
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
          assertExpectedAnnotationEntry(id, entries, arrayIndex, config, options.expectAt);
          const existing = entries[arrayIndex];
          assertAnnotationEntryMutable(existing, "edited");
          entries[arrayIndex] = editedAnnotationEntry(existing, text, author, config.createEntry);
          editedAddress = canonicalAnnotationAddress(config.collectionKey, entries, arrayIndex);
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
    // An edit can reorder entries that share a created_at (the store orders by text next).
    const editedIndex = editedAddress;
    return renderAnnotationResult(
      result.item.id,
      config.collectionKey,
      allEntries,
      limit,
      options.includeMeta === true,
      {
        action: "edit",
        entryIndex: editedIndex,
        entry: allEntries[editedIndex - 1],
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
        entryIndex = canonicalAnnotationAddress(config.collectionKey, appended.written, appended.position);
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

interface AnnotationResultMutation<TEntry extends AnnotationEntry> {
  action: "add" | "edit" | "delete";
  entryIndex: number;
  entry?: TEntry;
  changedCount?: 0 | 1;
}

/** Build the mutation and omission receipts attached to bounded annotation results. */
function renderAnnotationMutationReceipts<TEntry extends AnnotationEntry>(
  collectionKey: string,
  mutation: AnnotationResultMutation<TEntry> | undefined,
  historyOmitted: boolean,
): {
  mutation_receipt?: AnnotationMutationReceipt;
  omission_receipt?: AnnotationOmissionReceipt;
} {
  if (mutation === undefined) return {};
  return {
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
  };
}

/** Attach the absolute position first, so it leads every row and no stored field can override it. */
function indexAnnotationEntry<TEntry>(
  entry: TEntry,
  index: number,
): IndexedAnnotationEntry<TEntry> {
  // A malformed stored entry (not an object) is delivered as stored, never
  // spread into character-numbered keys; typed refusal is pm-30tjoh.
  if (Object.prototype.toString.call(entry) !== "[object Object]") {
    return entry as IndexedAnnotationEntry<TEntry>;
  }
  const indexed = { index, ...entry };
  indexed.index = index;
  return indexed;
}

/**
 * Index only the retained newest-tail slice, numbering each row by its
 * position in the complete collection, so a short page of a long history
 * clones only what it delivers.
 */
function indexRetainedAnnotationEntries<TEntry>(
  allEntries: readonly TEntry[],
  retained: readonly TEntry[],
): Array<IndexedAnnotationEntry<TEntry>> {
  const offset = allEntries.length - retained.length;
  return retained.map((entry, position) => indexAnnotationEntry(entry, offset + position + 1));
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
  mutation?: AnnotationResultMutation<TEntry>,
  fullHistory = false,
): AnnotationCommandResult<TKey, TEntry> {
  const entries =
    mutation === undefined || fullHistory
      ? indexRetainedAnnotationEntries(
          allEntries,
          limitAnnotationEntries(
            allEntries,
            mutation !== undefined && fullHistory ? undefined : limit,
          ),
        )
      : mutation.entry === undefined
        ? []
        : [indexAnnotationEntry(mutation.entry, mutation.entryIndex)];
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
    ...renderAnnotationMutationReceipts(
      collectionKey,
      mutation,
      historyOmitted,
    ),
  } as AnnotationCommandResult<TKey, TEntry>;
}
