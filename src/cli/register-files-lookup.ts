/**
 * @module cli/register-files-lookup
 *
 * Registers the bounded reverse linked-file query without expanding the main
 * mutation command registry.
 */
import type { Command } from "commander";
import { runFilesLookup } from "../sdk/files.js";
import { parseSourceLineRange } from "../sdk/traceability/source-traceability.js";
import { EXIT_CODE, PmCliError } from "../sdk/runtime-primitives.js";
import { getGlobalOptions, printResult } from "./registration-helpers.js";

function parseIntegerBound(flag: string, minimum: number) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum) {
      throw new PmCliError(
        `${flag} must be an integer greater than or equal to ${minimum}.`,
        EXIT_CODE.USAGE,
      );
    }
    return parsed;
  };
}

async function runFilesLookupAction(
  paths: string[],
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  if (
    options.scope !== undefined &&
    options.scope !== "project" &&
    options.scope !== "global"
  ) {
    throw new PmCliError(
      "--scope must be either project or global.",
      EXIT_CODE.USAGE,
    );
  }
  const result = await runFilesLookup(
    {
      paths,
      scope: options.scope,
      limit: typeof options.limit === "number" ? options.limit : undefined,
      offset: typeof options.offset === "number" ? options.offset : undefined,
      noTruncate: options.noTruncate === true,
      strictRead: options.strictRead === true,
      explain: options.explain === true,
      lineRange:
        typeof options.lines === "string"
          ? parseSourceLineRange(options.lines)
          : undefined,
      decisionDepth:
        typeof options.decisionDepth === "number"
          ? options.decisionDepth
          : undefined,
    },
    globalOptions,
  );
  printResult(result, globalOptions);
}

/** Register the reverse linked-file lookup below the existing files command. */
export function registerFilesLookupCommand(filesCommand: Command): void {
  filesCommand
    .command("lookup")
    .argument("<paths...>", "Project-relative or absolute source paths")
    .option("--scope <scope>", "Restrict links to project or global scope")
    .option(
      "--limit <n>",
      "Maximum referencing items to return",
      parseIntegerBound("--limit", 1),
    )
    .option(
      "--offset <n>",
      "Number of referencing items to skip",
      parseIntegerBound("--offset", 0),
    )
    .option("--no-truncate", "Return every referencing item")
    .option("--strict-read", "Fail when any authoritative item cannot be read")
    .option("--explain", "Include ranked source-to-work rationale")
    .option("--lines <start:end>", "Attribute an inclusive source line range")
    .option(
      "--decision-depth <n>",
      "Maximum governing-decision relationship depth",
      parseIntegerBound("--decision-depth", 1),
    )
    .description(
      "Find and explain pm items that govern requested source paths.",
    )
    .action(runFilesLookupAction);
}
