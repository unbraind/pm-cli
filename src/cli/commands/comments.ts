import { readFile } from "node:fs/promises";
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
import { parseLimit } from "../shared-parsers.js";
import type { Comment } from "../../types/index.js";

export interface CommentsCommandOptions {
  add?: string;
  stdin?: boolean;
  file?: string;
  limit?: string;
  author?: string;
  message?: string;
  force?: boolean;
  allowAuditComment?: boolean;
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

function limitComments(values: Comment[], limit: number | undefined): Comment[] {
  if (limit === undefined) return values;
  if (limit === 0) return [];
  return values.slice(Math.max(0, values.length - limit));
}

function parseCommentTextInput(raw: string): string {
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

interface ResolvedCommentInput {
  mode: "list" | "add" | "stdin" | "file";
  value?: string;
}

function isErrnoError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

async function resolveCommentInput(
  options: CommentsCommandOptions,
  stdinResolver: ReturnType<typeof createStdinTokenResolver>,
): Promise<ResolvedCommentInput> {
  const hasAdd = options.add !== undefined;
  const hasStdin = options.stdin === true;
  const hasFile = typeof options.file === "string";
  const sourceCount = Number(hasAdd) + Number(hasStdin) + Number(hasFile);
  if (sourceCount === 0) {
    return { mode: "list" };
  }
  if (sourceCount > 1) {
    throw new PmCliError("Specify comment text using only one input source: --add, --stdin, or --file", EXIT_CODE.USAGE);
  }
  if (hasAdd) {
    const addInput = await stdinResolver.resolveValue(options.add, "--add");
    return {
      mode: "add",
      value: addInput ?? "",
    };
  }
  if (hasStdin) {
    const stdinInput = await stdinResolver.resolveValue("-", "--stdin");
    return {
      mode: "stdin",
      value: stdinInput ?? "",
    };
  }
  const filePath = options.file?.trim() ?? "";
  if (!filePath) {
    throw new PmCliError("--file path cannot be empty", EXIT_CODE.USAGE);
  }
  try {
    const fileInput = await readFile(filePath, "utf8");
    return {
      mode: "file",
      value: fileInput,
    };
  } catch (error: unknown) {
    if (isErrnoError(error) && error.code === "ENOENT") {
      throw new PmCliError(`--file path not found: ${filePath}`, EXIT_CODE.USAGE);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new PmCliError(`Failed to read --file path "${filePath}": ${detail}`, EXIT_CODE.USAGE);
  }
}

export async function runComments(id: string, options: CommentsCommandOptions, global: GlobalOptions): Promise<CommentsResult> {
  const stdinResolver = createStdinTokenResolver();
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const limit = parseLimit(options.limit);
  const commentInput = await resolveCommentInput(options, stdinResolver);

  if (commentInput.mode === "list") {
    const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
    if (!located) {
      throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
    }
    const loaded = await readLocatedItem(located, { schema: settings.schema });
    const comments = limitComments(loaded.document.metadata.comments ?? [], limit);
    return {
      id: located.id,
      comments,
      count: comments.length,
    };
  }

  const author = resolveAuthor(options.author, settings.author_default);
  const text = commentInput.mode === "add" ? parseCommentTextInput(commentInput.value ?? "") : (commentInput.value ?? "");
  if (!text.trim()) {
    const inputFlag = commentInput.mode === "add" ? "--add" : commentInput.mode === "stdin" ? "--stdin" : "--file";
    throw new PmCliError(`${inputFlag} text cannot be empty`, EXIT_CODE.USAGE);
  }

  let result: Awaited<ReturnType<typeof mutateItem>>;
  try {
    result = await mutateItem({
      pmRoot,
      settings,
      id,
      op: "comment_add",
      author,
      message: options.message,
      force: options.force,
      bypassAssigneeConflict: Boolean(options.allowAuditComment),
      mutate(document) {
        const comments = document.metadata.comments ?? [];
        comments.push({
          created_at: nowIso(),
          author,
          text,
        });
        document.metadata.comments = comments;
        return { changedFields: ["comments"] };
      },
    });
  } catch (error: unknown) {
    if (
      error instanceof PmCliError &&
      error.exitCode === EXIT_CODE.CONFLICT &&
      error.message.includes("is assigned to") &&
      error.message.includes("Use --force to override")
    ) {
      throw new PmCliError(error.message, error.exitCode, {
        code: "ownership_conflict",
        required:
          "For append-only comment audits on another owner's item, prefer --allow-audit-comment before considering --force.",
        examples: ['pm comments pm-a1b2 --add "audit note" --author "reviewer" --allow-audit-comment'],
        nextSteps: [
          "Retry with --allow-audit-comment for append-only audits that do not mutate item metadata beyond comments.",
          "Use --force only when an ownership override is explicitly approved.",
        ],
      });
    }
    throw error;
  }

  const comments = limitComments(result.item.comments as Comment[], limit);
  return {
    id: result.item.id,
    comments,
    count: comments.length,
  };
}
