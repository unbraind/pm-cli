/**
 * @module cli/commands/annotation-command
 *
 * Implements the pm annotation command command surface and its agent-facing runtime behavior.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { parseCsvKv } from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { parseLimit } from "../shared-parsers.js";

interface AnnotationEntry {
  created_at: string;
  author: string;
  text: string;
  edited_at?: string;
}

interface AnnotationCommandOptions {
  limit?: string;
  author?: string;
  message?: string;
  force?: boolean;
  includeMeta?: boolean;
}

interface AnnotationInput {
  mode: "list" | "add" | "stdin" | "file" | "edit" | "delete";
  value?: string;
  rawValue?: string;
  emptyFlag?: string;
  index?: number;
}

interface OwnershipConflictGuidance {
  required: string;
  examples: string[];
  nextSteps: string[];
}

interface AnnotationCommandConfig<TKey extends string> {
  input: AnnotationInput;
  collectionKey: TKey;
  op: Parameters<typeof mutateItem>[0]["op"];
  editOp?: Parameters<typeof mutateItem>[0]["op"];
  deleteOp?: Parameters<typeof mutateItem>[0]["op"];
  parseText: (raw: string) => string;
  allowAuditBypass: boolean;
  conflictGuidance: OwnershipConflictGuidance;
}

type AnnotationCommandResult<TKey extends string, TEntry extends AnnotationEntry> = {
  id: string;
  count: number;
} & Record<TKey, TEntry[]> & {
    total_count?: number;
    returned_count?: number;
    has_more?: boolean;
    limit?: number;
  };

/**
 * Implements limit annotation entries for the public runtime surface of this module.
 */
export function limitAnnotationEntries<TEntry>(values: TEntry[], limit: number | undefined): TEntry[] {
  if (limit === undefined) return values;
  if (limit === 0) return [];
  return values.slice(Math.max(0, values.length - limit));
}

/**
 * Implements read annotation entries for the public runtime surface of this module.
 */
export function readAnnotationEntries<TEntry>(source: Record<string, unknown>, collectionKey: string): TEntry[] {
  const value = source[collectionKey];
  return Array.isArray(value) ? (value as TEntry[]) : [];
}

/**
 * Implements parse annotation text input for the public runtime surface of this module.
 */
export function parseAnnotationTextInput(raw: string, options: { stripPlainTextPrefix?: boolean } = {}): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const textPrefixMatch = /^(?:[-*+]\s*)?text\s*[:=]/i.exec(trimmed);
  if (options.stripPlainTextPrefix === true && textPrefixMatch && !trimmed.startsWith("```")) {
    const text = trimmed.slice(textPrefixMatch[0].length).trim();
    return text || trimmed;
  }
  const looksStructured = /^(?:[-*+]\s*)?text\s*[:=]/im.test(trimmed) || trimmed.startsWith("```");
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

/**
 * Implements wrap ownership conflict for the public runtime surface of this module.
 */
export function wrapOwnershipConflict(error: unknown, guidance: OwnershipConflictGuidance): never {
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

function assertAnnotationAddValueIsNotFlagLike(raw: string, config: AnnotationCommandConfig<string>): void {
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
 * Implements run annotation command for the public runtime surface of this module.
 */
export async function runAnnotationCommand<TKey extends string, TEntry extends AnnotationEntry>(
  id: string,
  options: AnnotationCommandOptions,
  global: GlobalOptions,
  config: AnnotationCommandConfig<TKey>,
): Promise<AnnotationCommandResult<TKey, TEntry>> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const limit = parseLimit(options.limit);

  if (config.input.mode === "list") {
    const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
    if (!located) {
      throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
    }
    const loaded = await readLocatedItem(located, { schema: settings.schema });
    const allEntries = readAnnotationEntries<TEntry>(loaded.document.metadata, config.collectionKey);
    return renderAnnotationResult(located.id, config.collectionKey, allEntries, limit, options.includeMeta === true);
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
        bypassAssigneeConflict: config.allowAuditBypass,
        mutate(document) {
          const entries = readAnnotationEntries<TEntry>(document.metadata, config.collectionKey);
          const arrayIndex = resolveAnnotationIndex(config.input.index, entries.length, config.collectionKey);
          entries.splice(arrayIndex, 1);
          document.metadata[config.collectionKey] = entries as never;
          return { changedFields: [config.collectionKey] };
        },
      });
    } catch (error: unknown) {
      wrapOwnershipConflict(error, config.conflictGuidance);
    }
    const allEntries = readAnnotationEntries<TEntry>(result.item, config.collectionKey);
    return renderAnnotationResult(result.item.id, config.collectionKey, allEntries, limit, options.includeMeta === true);
  }

  const rawText = config.input.rawValue ?? config.input.value ?? "";
  assertAnnotationAddValueIsNotFlagLike(rawText, config);
  const text = config.parseText(config.input.value ?? "");
  if (!text.trim()) {
    throw new PmCliError(`${config.input.emptyFlag ?? "--add"} text cannot be empty`, EXIT_CODE.USAGE);
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
        bypassAssigneeConflict: config.allowAuditBypass,
        mutate(document) {
          const entries = readAnnotationEntries<TEntry>(document.metadata, config.collectionKey);
          const arrayIndex = resolveAnnotationIndex(config.input.index, entries.length, config.collectionKey);
          const existing = entries[arrayIndex];
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
    const allEntries = readAnnotationEntries<TEntry>(result.item, config.collectionKey);
    return renderAnnotationResult(result.item.id, config.collectionKey, allEntries, limit, options.includeMeta === true);
  }

  let result: Awaited<ReturnType<typeof mutateItem>>;
  try {
    result = await mutateItem({
      pmRoot,
      settings,
      id,
      op: config.op,
      author,
      message: options.message,
      force: options.force,
      bypassAssigneeConflict: config.allowAuditBypass,
      mutate(document) {
        const entries = readAnnotationEntries<TEntry>(document.metadata, config.collectionKey);
        entries.push({
          created_at: nowIso(),
          author,
          text,
        } as TEntry);
        document.metadata[config.collectionKey] = entries as never;
        return { changedFields: [config.collectionKey] };
      },
    });
  } catch (error: unknown) {
    wrapOwnershipConflict(error, config.conflictGuidance);
  }

  const allEntries = readAnnotationEntries<TEntry>(result.item, config.collectionKey);
  return renderAnnotationResult(result.item.id, config.collectionKey, allEntries, limit, options.includeMeta === true);
}

/**
 * Implements resolve annotation index for the public runtime surface of this module.
 */
export function resolveAnnotationIndex(
  oneBasedIndex: number | undefined,
  count: number,
  collectionKey: string,
): number {
  if (oneBasedIndex === undefined || !Number.isInteger(oneBasedIndex) || oneBasedIndex < 1 || oneBasedIndex > count) {
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

function renderAnnotationResult<TKey extends string, TEntry extends AnnotationEntry>(
  id: string,
  collectionKey: TKey,
  allEntries: TEntry[],
  limit: number | undefined,
  includeMeta: boolean,
): AnnotationCommandResult<TKey, TEntry> {
  const entries = limitAnnotationEntries(allEntries, limit);
  return {
    id,
    [collectionKey]: entries,
    count: entries.length,
    ...(includeMeta
      ? {
          total_count: allEntries.length,
          returned_count: entries.length,
          has_more: entries.length < allEntries.length,
          ...(limit !== undefined ? { limit } : {}),
        }
      : {}),
  } as AnnotationCommandResult<TKey, TEntry>;
}
