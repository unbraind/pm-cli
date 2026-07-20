/**
 * @module sdk/cli-program
 *
 * Builds the reusable Commander root that embeds pm's universal global contracts.
 */
import { Command } from "commander";
import { writeStdout } from "../core/output/output.js";

/** Create a fresh pm root program suitable for one-shot CLI or embedded hosts. */
export function createPmCliProgram(version: string): Command {
  return new Command()
    .name("pm")
    .description(
      "Universal, flexible, extensible, agent-optimized project management CLI for any project or programming language.",
    )
    .version(version)
    .showHelpAfterError(false)
    .allowExcessArguments(false)
    .allowUnknownOption(false)
    .configureOutput({
      writeOut: (value) => {
        writeStdout(value);
      },
      writeErr: () => {},
    })
    .option("--json", "Output JSON instead of TOON")
    .option("--lean", "Omit null and empty containers from JSON output")
    .option("--quiet", "Suppress stdout output")
    .option(
      "--no-changed-fields",
      "Omit the changed_fields array from mutation output (keeps changed_field_count)",
    )
    .option(
      "--full-changed-fields",
      "Restore the legacy full mutation envelope and changed_fields array",
    )
    .option(
      "--id-only",
      "Print only id and status for single-item mutation output",
    )
    .option(
      "--pm-path <dir>",
      "Explicit tracker storage path for this command (preferred over --path)",
    )
    .option(
      "--path <dir>",
      "Backward-compatible alias for --pm-path; this is the tracker storage path, not a workspace cwd",
    )
    .option("--no-extensions", "Disable extension loading")
    .option("--no-pager", "Disable pager integration for help and long output")
    .option(
      "--explain",
      "Render extended rationale and examples in help output",
    )
    .option("--profile", "Print deterministic timing diagnostics")
    .option("--author <id>", "Override mutation author for this invocation")
    .exitOverride();
}
