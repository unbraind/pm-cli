import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { createStdinTokenResolver, parseCsvKv } from "../../core/item/parse.js";
import { locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { LogNote } from "../../types/index.js";

export interface LearningsCommandOptions {
  add?: string;
  limit?: string;
  author?: string;
  message?: string;
  force?: boolean;
}

export interface LearningsResult {
  id: string;
  learnings: LogNote[];
  count: number;
}

function resolveAuthor(candidate: string | undefined, fallback: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? fallback;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PmCliError("Invalid --limit value", EXIT_CODE.USAGE);
  }
  return Math.floor(parsed);
}

function limitLearnings(values: LogNote[], limit: number | undefined): LogNote[] {
  if (limit === undefined) return values;
  if (limit === 0) return [];
  return values.slice(Math.max(0, values.length - limit));
}

function parseLearningTextInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const looksStructured = /^(?:[-*+]\s*)?text\s*[:=]/im.test(trimmed) || trimmed.startsWith("```");
  if (!looksStructured) {
    return trimmed;
  }
  try {
    const kv = parseCsvKv(trimmed, "--add");
    const text = kv.text?.trim();
    return text || trimmed;
  } catch {
    return trimmed;
  }
}

export async function runLearnings(
  id: string,
  options: LearningsCommandOptions,
  global: GlobalOptions,
): Promise<LearningsResult> {
  const stdinResolver = createStdinTokenResolver();
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const limit = parseLimit(options.limit);

  if (options.add === undefined) {
    const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
    if (!located) {
      throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
    }
    const loaded = await readLocatedItem(located);
    const learnings = limitLearnings(loaded.document.front_matter.learnings ?? [], limit);
    return {
      id: located.id,
      learnings,
      count: learnings.length,
    };
  }

  const author = resolveAuthor(options.author, settings.author_default);
  const addInput = await stdinResolver.resolveValue(options.add, "--add");
  const text = parseLearningTextInput(addInput ?? "");
  if (!text) {
    throw new PmCliError("--add text cannot be empty", EXIT_CODE.USAGE);
  }

  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "learning_add",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      const learnings = document.front_matter.learnings ?? [];
      learnings.push({
        created_at: nowIso(),
        author,
        text,
      });
      document.front_matter.learnings = learnings;
      return { changedFields: ["learnings"] };
    },
  });

  const learnings = limitLearnings(result.item.learnings as LogNote[], limit);
  return {
    id: result.item.id,
    learnings,
    count: learnings.length,
  };
}
