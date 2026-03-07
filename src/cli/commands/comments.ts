import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { Comment } from "../../types/index.js";

export interface CommentsCommandOptions {
  add?: string;
  limit?: string;
  author?: string;
  message?: string;
  force?: boolean;
}

export interface CommentsResult {
  id: string;
  comments: Comment[];
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

function limitComments(values: Comment[], limit: number | undefined): Comment[] {
  if (limit === undefined) return values;
  if (limit === 0) return [];
  return values.slice(Math.max(0, values.length - limit));
}

export async function runComments(id: string, options: CommentsCommandOptions, global: GlobalOptions): Promise<CommentsResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const limit = parseLimit(options.limit);

  if (options.add === undefined) {
    const located = await locateItem(pmRoot, id, settings.id_prefix);
    if (!located) {
      throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
    }
    const loaded = await readLocatedItem(located);
    const comments = limitComments(loaded.document.front_matter.comments ?? [], limit);
    return {
      id: located.id,
      comments,
      count: comments.length,
    };
  }

  const author = resolveAuthor(options.author, settings.author_default);
  const text = options.add.trim();
  if (!text) {
    throw new PmCliError("--add text cannot be empty", EXIT_CODE.USAGE);
  }

  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "comment_add",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      const comments = document.front_matter.comments ?? [];
      comments.push({
        created_at: nowIso(),
        author,
        text,
      });
      document.front_matter.comments = comments;
      return { changedFields: ["comments"] };
    },
  });

  const comments = limitComments(result.item.comments as Comment[], limit);
  return {
    id: result.item.id,
    comments,
    count: comments.length,
  };
}
