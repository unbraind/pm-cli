/**
 * @module cli/register-assurance
 *
 * Thin Commander adapter over the transport-neutral public assurance action.
 */
import type { Command } from "commander";

import { runAssuranceAction } from "../sdk/governance/assurance-action.js";
import { printResult } from "../sdk/runtime-primitives.js";
import { getGlobalOptions, readOptionString } from "./registration-helpers.js";

async function runAssuranceCliAction(
  action: string,
  kindOrGate: string | undefined,
  id: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const global = getGlobalOptions(command);
  const isRun = action === "run";
  const isVerdicts = action === "verdicts";
  const isPresetAction = action === "presets" || action === "apply";
  const isPromote = action === "promote";
  const result = await runAssuranceAction(
    {
      action,
      ...(isRun || isVerdicts || isPresetAction || isPromote
        ? {}
        : { kind: kindOrGate }),
      id: isRun || isVerdicts || isPromote ? (id ?? kindOrGate) : id,
      preset: isPresetAction ? (id ?? kindOrGate) : undefined,
      definition: readOptionString(options, "definition"),
      trigger: readOptionString(options, "trigger"),
      tree: readOptionString(options, "tree"),
      gate: readOptionString(options, "gate"),
      limit: readOptionString(options, "limit"),
      dry_run: options.dryRun === true,
      fullChangedFields: global.fullChangedFields,
      idOnly: global.idOnly,
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      owner: readOptionString(options, "owner"),
      apply: options.apply === true,
      enforcement: readOptionString(options, "enforcement"),
    },
    global,
  );
  printResult(result, global);
  if (
    typeof result === "object" &&
    result !== null &&
    "exit_code" in result &&
    result.exit_code === 1
  ) {
    process.exitCode = 1;
  }
}

/** Register the declarative assurance command family. */
export function registerAssuranceCommand(program: Command): void {
  program
    .command("assurance")
    .argument("<action>", "Action; inspect `pm contracts --command assurance`")
    .argument("[kind]", "Declaration kind or run gate id")
    .argument("[id]", "Declaration/gate id")
    .description("Manage SDK-owned assurance contracts.")
    .option("--definition <json>", "Put declaration JSON")
    .option("--trigger <value>", "Gate trigger")
    .option("--tree <value>", "Revision identity")
    .option("--gate <id>", "Verdict gate filter")
    .option("--limit <number>", "Verdict limit")
    .option("--dry-run", "Evaluate without recording")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Mutation rationale")
    .option("--owner <item-id>", "Preset/derivation owner")
    .option("--apply", "Persist derived proposals")
    .option("--enforcement <level>", "Promote to warn or block")
    .action(runAssuranceCliAction);
}
