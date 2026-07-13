/**
 * @module cli/commands/comments
 *
 * Implements the pm comments command surface and its agent-facing runtime behavior.
 */
import { readFile } from "node:fs/promises";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { createStdinTokenResolver } from "../../core/item/parse.js";
import type { Comment } from "../../types/index.js";
import {
  isErrnoError,
  parseAnnotationTextInput,
  runAnnotationCommand,
} from "../../sdk/annotations.js";

/** Documents the comments command options payload exchanged by command, SDK, and package integrations. */
export interface CommentsCommandOptions {
  /** Value that configures or reports add for this contract. */
  add?: string;
  /** Value that configures or reports stdin for this contract. */
  stdin?: boolean;
  /** Value that configures or reports file for this contract. */
  file?: string;
  /** Value that configures or reports edit for this contract. */
  edit?: number;
  /** Value that configures or reports delete for this contract. */
  delete?: number;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Value that configures or reports include meta for this contract. */
  includeMeta?: boolean;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the comments result payload exchanged by command, SDK, and package integrations. */
export interface CommentsResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports comments for this contract. */
  comments: Comment[];
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Number of total entries represented by this result. */
  total_count?: number;
  /** Number of returned entries represented by this result. */
  returned_count?: number;
  /** Whether more applies to this operation. */
  has_more?: boolean;
  /** Value that configures or reports limit for this contract. */
  limit?: number;
}

interface ResolvedCommentInput {
  mode: "list" | "add" | "stdin" | "file" | "edit" | "delete";
  value?: string;
  emptyFlag?: string;
  index?: number;
}

async function resolveCommentTextSource(
  options: CommentsCommandOptions,
  stdinResolver: ReturnType<typeof createStdinTokenResolver>,
): Promise<{ value: string; emptyFlag: string } | undefined> {
  const hasAdd = options.add !== undefined;
  const hasStdin = options.stdin === true;
  const hasFile = typeof options.file === "string";
  const sourceCount = Number(hasAdd) + Number(hasStdin) + Number(hasFile);
  if (sourceCount === 0) {
    return undefined;
  }
  if (sourceCount > 1) {
    throw new PmCliError(
      "Specify comment text using only one input source: --add, --stdin, or --file",
      EXIT_CODE.USAGE,
    );
  }
  if (hasAdd) {
    const addInput = await stdinResolver.resolveValue(options.add, "--add");
    return { value: addInput ?? "", emptyFlag: "--add" };
  }
  if (hasStdin) {
    const stdinInput = await stdinResolver.resolveValue("-", "--stdin");
    return { value: stdinInput ?? "", emptyFlag: "--stdin" };
  }
  const filePath = (options.file as string).trim();
  if (!filePath) {
    throw new PmCliError("--file path cannot be empty", EXIT_CODE.USAGE);
  }
  try {
    const fileInput = await readFile(filePath, "utf8");
    return { value: fileInput, emptyFlag: "--file" };
  } catch (error: unknown) {
    if (isErrnoError(error) && error.code === "ENOENT") {
      throw new PmCliError(
        `--file path not found: ${filePath}`,
        EXIT_CODE.USAGE,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new PmCliError(
      `Failed to read --file path "${filePath}": ${detail}`,
      EXIT_CODE.USAGE,
    );
  }
}

async function resolveCommentInput(
  options: CommentsCommandOptions,
  stdinResolver: ReturnType<typeof createStdinTokenResolver>,
): Promise<ResolvedCommentInput> {
  const editIndex = options.edit;
  const deleteIndex = options.delete;
  const hasEdit = editIndex !== undefined;
  const hasDelete = deleteIndex !== undefined;
  if (hasEdit && hasDelete) {
    throw new PmCliError(
      "Specify only one of --edit or --delete",
      EXIT_CODE.USAGE,
    );
  }
  if (editIndex !== undefined && (!Number.isInteger(editIndex) || editIndex < 1)) {
    throw new PmCliError("--edit must be a positive integer", EXIT_CODE.USAGE);
  }
  if (deleteIndex !== undefined && (!Number.isInteger(deleteIndex) || deleteIndex < 1)) {
    throw new PmCliError("--delete must be a positive integer", EXIT_CODE.USAGE);
  }

  if (hasDelete) {
    const textSource = await resolveCommentTextSource(options, stdinResolver);
    if (textSource !== undefined) {
      throw new PmCliError(
        "--delete does not take comment text",
        EXIT_CODE.USAGE,
      );
    }
    return { mode: "delete", index: deleteIndex };
  }

  if (hasEdit) {
    const textSource = await resolveCommentTextSource(options, stdinResolver);
    if (textSource === undefined) {
      throw new PmCliError(
        "--edit requires replacement text via positional [text], --add, --stdin, or --file",
        EXIT_CODE.USAGE,
      );
    }
    return {
      mode: "edit",
      index: editIndex,
      value: textSource.value,
      emptyFlag: textSource.emptyFlag,
    };
  }

  const textSource = await resolveCommentTextSource(options, stdinResolver);
  if (textSource === undefined) {
    return { mode: "list" };
  }
  // Map the single resolved input source back to its add/stdin/file mode so the
  // caller still knows whether to run plain-text markdown parsing (add-only).
  const mode =
    textSource.emptyFlag === "--add"
      ? "add"
      : textSource.emptyFlag === "--stdin"
        ? "stdin"
        : "file";
  return { mode, value: textSource.value, emptyFlag: textSource.emptyFlag };
}

/** Implements run comments for the public runtime surface of this module. */
export async function runComments(
  id: string,
  options: CommentsCommandOptions,
  global: GlobalOptions,
): Promise<CommentsResult> {
  const stdinResolver = createStdinTokenResolver();
  const commentInput = await resolveCommentInput(options, stdinResolver);

  const shouldParseText =
    commentInput.mode === "add" || commentInput.mode === "edit";
  const rawValue = commentInput.value ?? "";
  return runAnnotationCommand<"comments", Comment>(id, options, global, {
    input: {
      ...commentInput,
      rawValue: options.add ?? rawValue,
      value: shouldParseText
        ? parseAnnotationTextInput(rawValue, { stripPlainTextPrefix: true })
        : rawValue,
    },
    collectionKey: "comments",
    op: "comment_add",
    editOp: "comment_edit",
    deleteOp: "comment_delete",
    parseText: (raw) => raw,
    bypassOwnershipConflict: Boolean(
      commentInput.mode === "add" &&
        (options as CommentsCommandOptions & {
          ownershipAppendBypass?: boolean;
        }).ownershipAppendBypass,
    ),
    conflictGuidance: {
      required:
        "For an approved append-only handoff on another owner's item, use the package-provided ownership bypass before considering --force.",
      examples: ['pm comments pm-a1b2 --add "review note" --author "reviewer" --force'],
      nextSteps: [
        "Use an installed package's narrow append-only ownership bypass when available.",
        "Use --force only when an ownership override is explicitly approved.",
      ],
    },
  });
}
