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
}

interface AnnotationCommandOptions {
  limit?: string;
  author?: string;
  message?: string;
  force?: boolean;
  includeMeta?: boolean;
}

interface AnnotationInput {
  mode: "list" | "add" | "stdin" | "file";
  value?: string;
  emptyFlag?: string;
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

export function limitAnnotationEntries<TEntry>(values: TEntry[], limit: number | undefined): TEntry[] {
  if (limit === undefined) return values;
  if (limit === 0) return [];
  return values.slice(Math.max(0, values.length - limit));
}

export function readAnnotationEntries<TEntry>(source: Record<string, unknown>, collectionKey: string): TEntry[] {
  const value = source[collectionKey];
  return Array.isArray(value) ? (value as TEntry[]) : [];
}

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
  const text = config.parseText(config.input.value ?? "");
  if (!text.trim()) {
    throw new PmCliError(`${config.input.emptyFlag ?? "--add"} text cannot be empty`, EXIT_CODE.USAGE);
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
