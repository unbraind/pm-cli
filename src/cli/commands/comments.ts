import { readFile } from "node:fs/promises";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { createStdinTokenResolver } from "../../core/item/parse.js";
import type { Comment } from "../../types/index.js";
import { parseAnnotationTextInput, runAnnotationCommand } from "./annotation-command.js";

export interface CommentsCommandOptions {
  add?: string;
  stdin?: boolean;
  file?: string;
  limit?: string;
  includeMeta?: boolean;
  author?: string;
  message?: string;
  force?: boolean;
  allowAuditComment?: boolean;
}

export interface CommentsResult {
  id: string;
  comments: Comment[];
  count: number;
  total_count?: number;
  returned_count?: number;
  has_more?: boolean;
  limit?: number;
}

interface ResolvedCommentInput {
  mode: "list" | "add" | "stdin" | "file";
  value?: string;
  emptyFlag?: string;
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
      emptyFlag: "--add",
    };
  }
  if (hasStdin) {
    const stdinInput = await stdinResolver.resolveValue("-", "--stdin");
    return {
      mode: "stdin",
      value: stdinInput ?? "",
      emptyFlag: "--stdin",
    };
  }
  const filePath = (options.file as string).trim();
  if (!filePath) {
    throw new PmCliError("--file path cannot be empty", EXIT_CODE.USAGE);
  }
  try {
    const fileInput = await readFile(filePath, "utf8");
    return {
      mode: "file",
      value: fileInput,
      emptyFlag: "--file",
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
  const commentInput = await resolveCommentInput(options, stdinResolver);

  return runAnnotationCommand<"comments", Comment>(id, options, global, {
    input: {
      ...commentInput,
      value:
        /* c8 ignore next -- resolveCommentInput always normalizes add-mode values to a string (possibly empty). */
        commentInput.mode === "add"
          ? parseAnnotationTextInput(commentInput.value ?? "", { stripPlainTextPrefix: true })
          : (commentInput.value ?? ""),
    },
    collectionKey: "comments",
    op: "comment_add",
    parseText: (raw) => raw,
    allowAuditBypass: Boolean(options.allowAuditComment),
    conflictGuidance: {
      required:
        "For append-only comment audits on another owner's item, prefer --allow-audit-comment before considering --force.",
      examples: ['pm comments pm-a1b2 --add "audit note" --author "reviewer" --allow-audit-comment'],
      nextSteps: [
        "Retry with --allow-audit-comment for append-only audits that do not mutate item metadata beyond comments.",
        "Use --force only when an ownership override is explicitly approved.",
      ],
    },
  });
}
