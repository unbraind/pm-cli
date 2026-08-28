/**
 * @module cli/register-annotations
 *
 * Registers comment, note, and learning adapters around the shared bounded
 * annotation SDK contract.
 */
import type { Command } from "commander";
import {
  EXIT_CODE,
  PmCliError,
  type GlobalOptions,
} from "../sdk/runtime-primitives.js";
import { renderPmCommand } from "../sdk/command-line.js";
import { runComments } from "./commands/comments.js";
import { runLearnings } from "./commands/learnings.js";
import { runNotes } from "./commands/notes.js";
import {
  addHiddenOption,
  getGlobalOptions,
  invalidateSearchCachesForMutation,
  printError,
  printResult,
  readOptionString,
} from "./registration-helpers.js";

/** Converts a Commander token into a positive annotation index. */
export type PositiveIntegerOptionParser = (
  value: string,
  previous: number | undefined,
) => number;

function assertNoTransposedAnnotationAction(
  collection: "comments" | "notes" | "learnings",
  id: string,
  text: string | undefined,
  options: Record<string, unknown>,
): void {
  if (id.trim().toLowerCase() !== "add" || !text?.trim()) {
    return;
  }
  const suppliedText =
    readOptionString(options, "add") ??
    readOptionString(options, "text") ??
    readOptionString(options, "note") ??
    readOptionString(options, "body") ??
    readOptionString(options, "comment");
  const file = readOptionString(options, "file");
  const retryArgs = [collection, text.trim()];
  if (suppliedText !== undefined) retryArgs.push("--add", suppliedText);
  else if (options.stdin === true) retryArgs.push("--stdin");
  else if (file !== undefined) retryArgs.push("--file", file);
  else retryArgs.push("--add", "-");
  const suggestedRetry = renderPmCommand(retryArgs);
  const stdinRetry = renderPmCommand([collection, text.trim(), "--add", "-"]);
  throw new PmCliError(
    `The positional token "add" was parsed as the item id, while "${text.trim()}" was parsed as annotation text. ${collection} does not use an add subcommand.`,
    EXIT_CODE.USAGE,
    {
      code: "annotation_transposed_subcommand",
      reason: "noun_verb_object_transposition",
      required: `Place the item id immediately after ${collection}, then use --add for annotation text.`,
      examples: [...new Set([suggestedRetry, stdinRetry])],
      recovery: {
        attempted_command: `pm ${collection} add ${text.trim()}`,
        normalized_args: [collection, "add", text.trim()],
        parsed_positionals: [
          { role: "transposed_subcommand", value: "add" },
          { role: "item_id", value: text.trim() },
        ],
        suggested_retry: suggestedRetry,
      },
    },
  );
}

function resolveAnnotationTextAliases(
  label: string,
  options: Record<string, unknown>,
  aliases: readonly string[],
): string | undefined {
  const supplied = aliases.flatMap((alias) => {
    const value = readOptionString(options, alias);
    return value === undefined ? [] : [{ alias, value }];
  });
  const distinctValues = [...new Set(supplied.map(({ value }) => value))];
  if (distinctValues.length > 1) {
    throw new PmCliError(
      `Specify ${label} text with one alias or the same value across aliases: ${supplied.map(({ alias }) => `--${alias}`).join(", ")}`,
      EXIT_CODE.USAGE,
      { code: "annotation_alias_conflict" },
    );
  }
  return supplied[0]?.value;
}

function resolveCommentSources(
  text: string | undefined,
  options: Record<string, unknown>,
): {
  add: string | undefined;
  readFromStdin: boolean;
  readFromFile: string | undefined;
  editIndex: number | undefined;
  deleteIndex: number | undefined;
  isMutation: boolean;
} {
  const editIndex = typeof options.edit === "number" ? options.edit : undefined;
  const deleteIndex =
    typeof options.delete === "number" ? options.delete : undefined;
  const addFromOption = resolveAnnotationTextAliases("comment", options, [
    "add",
    "text",
    "body",
    "comment",
  ]);
  const addFromPositional = typeof text === "string" ? text : undefined;
  const readFromStdin = options.stdin === true;
  const readFromFile = readOptionString(options, "file");
  const sourceCount =
    Number(addFromOption !== undefined) +
    Number(addFromPositional !== undefined) +
    Number(readFromStdin) +
    Number(readFromFile !== undefined);
  if (sourceCount > 1) {
    if (
      addFromOption !== undefined &&
      addFromPositional !== undefined &&
      !readFromStdin &&
      readFromFile === undefined
    ) {
      throw new PmCliError(
        "Specify comment text either as positional [text] or with --add, not both",
        EXIT_CODE.USAGE,
      );
    }
    throw new PmCliError(
      "Specify comment text with exactly one source: positional [text], --add, --stdin, or --file",
      EXIT_CODE.USAGE,
    );
  }
  const add = addFromOption ?? addFromPositional;
  return {
    add,
    readFromStdin,
    readFromFile,
    editIndex,
    deleteIndex,
    isMutation:
      typeof add === "string" ||
      readFromStdin ||
      readFromFile !== undefined ||
      editIndex !== undefined ||
      deleteIndex !== undefined,
  };
}

function resolveSingleTextSource(
  label: string,
  positional: string | undefined,
  options: Record<string, unknown>,
): string | undefined {
  const addFromOption = resolveAnnotationTextAliases(
    label,
    options,
    label === "note" ? ["add", "text", "note"] : ["add", "text"],
  );
  const addFromPositional =
    typeof positional === "string" ? positional : undefined;
  if (addFromOption !== undefined && addFromPositional !== undefined) {
    throw new PmCliError(
      `Specify ${label} text either as positional [text] or with --add, not both`,
      EXIT_CODE.USAGE,
    );
  }
  return addFromOption ?? addFromPositional;
}

async function runCommentsAction(
  id: string,
  text: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  assertNoTransposedAnnotationAction("comments", id, text, options);
  const sources = resolveCommentSources(text, options);
  const result = await runComments(
    id,
    {
      add: sources.add,
      stdin: sources.readFromStdin,
      file: sources.readFromFile,
      edit: sources.editIndex,
      delete: sources.deleteIndex,
      limit: readOptionString(options, "limit"),
      fullHistory: options.fullHistory === true,
      ifAbsent: options.ifAbsent === true,
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      ownershipAppendBypass: options.ownershipAppendBypass === true,
      force: Boolean(options.force),
    } as Parameters<typeof runComments>[1],
    globalOptions,
  );
  if (sources.isMutation && result.changed !== false) {
    await invalidateSearchCachesForMutation(globalOptions, result);
  }
  printAnnotationResult("comments", result, globalOptions, startedAt);
}

async function runNotesAction(
  id: string,
  text: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  assertNoTransposedAnnotationAction("notes", id, text, options);
  const add = resolveSingleTextSource("note", text, options);
  const result = await runNotes(
    id,
    {
      add,
      addJson: readOptionString(options, "addJson"),
      stdin: options.stdin === true,
      file: readOptionString(options, "file"),
      edit: typeof options.edit === "number" ? options.edit : undefined,
      delete: typeof options.delete === "number" ? options.delete : undefined,
      limit: readOptionString(options, "limit"),
      since: readOptionString(options, "since"),
      eventType: readOptionString(options, "eventType"),
      includeMeta: options.includeMeta === true,
      fullHistory: options.fullHistory === true,
      ifAbsent: options.ifAbsent === true,
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      ownershipAppendBypass: options.ownershipAppendBypass === true,
      force: Boolean(options.force),
    } as Parameters<typeof runNotes>[1],
    globalOptions,
  );
  if (
    result.changed !== false &&
    [
      typeof add === "string",
      typeof options.addJson === "string",
      options.stdin === true,
      typeof options.file === "string",
      typeof options.edit === "number",
      typeof options.delete === "number",
    ].includes(true)
  ) {
    await invalidateSearchCachesForMutation(globalOptions, result);
  }
  printAnnotationResult("notes", result, globalOptions, startedAt);
}

async function runLearningsAction(
  id: string,
  text: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  assertNoTransposedAnnotationAction("learnings", id, text, options);
  const add = resolveSingleTextSource("learning", text, options);
  const result = await runLearnings(
    id,
    {
      add,
      stdin: options.stdin === true,
      file: readOptionString(options, "file"),
      edit: typeof options.edit === "number" ? options.edit : undefined,
      delete: typeof options.delete === "number" ? options.delete : undefined,
      limit: readOptionString(options, "limit"),
      fullHistory: options.fullHistory === true,
      ifAbsent: options.ifAbsent === true,
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      ownershipAppendBypass: options.ownershipAppendBypass === true,
      force: Boolean(options.force),
    } as Parameters<typeof runLearnings>[1],
    globalOptions,
  );
  if (
    result.changed !== false &&
    [
      typeof add === "string",
      options.stdin === true,
      typeof options.file === "string",
      typeof options.edit === "number",
      typeof options.delete === "number",
    ].includes(true)
  ) {
    await invalidateSearchCachesForMutation(globalOptions, result);
  }
  printAnnotationResult("learnings", result, globalOptions, startedAt);
}

function printAnnotationResult(
  command: "comments" | "notes" | "learnings",
  result: unknown,
  globalOptions: GlobalOptions,
  startedAt: number,
): void {
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=${command} took_ms=${Date.now() - startedAt}`);
  }
}

/** Register bounded annotation commands on the root Commander program. */
export function registerAnnotationCommands(
  program: Command,
  parsePositiveInteger: (flag: string) => PositiveIntegerOptionParser,
): void {
  const commentsCommand = program
    .command("comments")
    .argument("<id>", "Item id")
    .argument("[text]", "Optional comment text shorthand (equivalent to --add)")
    .option(
      "--add <text>",
      "Append comment text; use text=<value> for structured input or - for stdin",
    )
    .option(
      "--stdin",
      "Read comment text from stdin (supports multiline markdown)",
    )
    .option("--file <path>", "Read comment text from a file or stdin (-)")
    .option(
      "--edit <index>",
      "Replace one comment using positional text, --add, --stdin, or --file",
      parsePositiveInteger("--edit"),
    )
    .option(
      "--delete <index>",
      "Delete the comment at 1-based <index>",
      parsePositiveInteger("--delete"),
    )
    .option("--limit <n>", "Return only latest n comments")
    .option(
      "--full-history",
      "Return complete comment history instead of a bounded mutation receipt",
    )
    .option(
      "--if-absent",
      "Append only when resolved author and text are absent",
    )
    .option(
      "--author [value]",
      "Comment author; defaults to PM_AUTHOR or settings",
    )
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .description("List, add, edit, or delete comments for an item.")
    .action(runCommentsAction);
  addHiddenOption(commentsCommand, "--body <text>", "Alias for --add", false);
  addHiddenOption(commentsCommand, "--text <text>", "Alias for --add", false);
  addHiddenOption(
    commentsCommand,
    "--comment <text>",
    "Alias for --add",
    false,
  );

  const notesCommand = program
    .command("notes")
    .argument("<id>", "Item id")
    .argument("[text]", "Optional note text shorthand for --add")
    .option("--add <text>", "Add a text note (- reads stdin)")
    .option("--note <text>", "Alias for --add")
    .option("--add-json <json>", "Append a JSON event")
    .option("--stdin", "Read note text from stdin")
    .option("--file <path>", "Read note from file or stdin (-)")
    .option(
      "--edit <index>",
      "Replace a 1-based note using the selected text input",
      parsePositiveInteger("--edit"),
    )
    .option(
      "--delete <index>",
      "Delete the note at 1-based <index>",
      parsePositiveInteger("--delete"),
    )
    .option("--limit <n>", "Return only latest n notes")
    .option("--since <timestamp>", "Filter JSON events from this ISO time")
    .option("--event-type <value>", "Filter JSON events by top-level type")
    .option("--include-meta", "Include count and truncation metadata")
    .option(
      "--full-history",
      "Return complete note history instead of a bounded receipt",
    )
    .option(
      "--if-absent",
      "Append only when resolved author and text are absent",
    )
    .option("--author [value]", "Author; defaults to PM_AUTHOR/settings")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .description("Manage merge-safe text notes and JSON context events.")
    .action(runNotesAction);
  addHiddenOption(notesCommand, "--text <text>", "Alias for --add", false);

  const learningsCommand = program
    .command("learnings")
    .argument("<id>", "Item id")
    .argument("[text]", "Optional learning text shorthand for --add")
    .option(
      "--add <text>",
      "Append learning text; use text=<value> or - for stdin",
    )
    .option("--stdin", "Read learning text from stdin")
    .option("--file <path>", "Read learning text from a file or stdin (-)")
    .option(
      "--edit <index>",
      "Replace one learning using positional text, --add, --stdin, or --file",
      parsePositiveInteger("--edit"),
    )
    .option(
      "--delete <index>",
      "Delete the learning at 1-based <index>",
      parsePositiveInteger("--delete"),
    )
    .option("--limit <n>", "Return only latest n learnings")
    .option(
      "--full-history",
      "Return complete learning history instead of a bounded receipt",
    )
    .option(
      "--if-absent",
      "Append only when resolved author and text are absent",
    )
    .option(
      "--author [value]",
      "Learning author (optional; falls back to PM_AUTHOR/settings)",
    )
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .description("List, add, edit, or delete learnings for an item.")
    .action(runLearningsAction);
  addHiddenOption(learningsCommand, "--text <text>", "Alias for --add", false);
}
