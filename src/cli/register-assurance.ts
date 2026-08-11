/**
 * @module cli/register-assurance
 *
 * Thin Commander adapter over the transport-neutral public assurance action.
 */
import type { Command } from "commander";

import {
  ASSURANCE_ACTIONS,
  ASSURANCE_DECLARATION_KINDS,
  runAssuranceAction,
} from "../sdk/governance/assurance-action.js";
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
  const result = await runAssuranceAction(
    {
      action,
      ...(isRun || isVerdicts ? {} : { kind: kindOrGate }),
      id: isRun || isVerdicts ? (id ?? kindOrGate) : id,
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
    .argument("<action>", `Action: ${ASSURANCE_ACTIONS.join(", ")}`)
    .argument(
      "[kind]",
      `Declaration kind: ${ASSURANCE_DECLARATION_KINDS.join(", ")}; for run this may be the gate id`,
    )
    .argument("[id]", "Declaration or gate id")
    .description("Declare and evaluate SDK-owned project assurance contracts.")
    .option("--definition <json>", "JSON declaration for put")
    .option("--trigger <value>", "Gate lifecycle trigger")
    .option("--tree <value>", "Commit, tree, or snapshot identity being judged")
    .option("--gate <id>", "Filter verdict history by gate id")
    .option("--limit <number>", "Maximum newest verdicts returned")
    .option("--dry-run", "Evaluate a gate without appending a verdict")
    .option("--author <value>", "Mutation author override")
    .option("--message <value>", "Audited mutation rationale")
    .action(runAssuranceCliAction);
}
