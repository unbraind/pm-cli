#!/usr/bin/env node

/**
 * Fail closed when live CLI contracts drift from the accepted noun–verb
 * destination census, alias targets, or visible-surface ceiling.
 *
 * Tracker: pm-wt43zj, pm-yy8rmx.
 */
import { execFileSync } from "node:child_process";
import {
  PM_COMMAND_ALIAS_CONTRACTS,
  verifyPmCliGrammar,
} from "../../dist/sdk/index.js";
import { repoRoot } from "./utils.mjs";

const raw = execFileSync(
  process.execPath,
  [
    "dist/cli.js",
    "contracts",
    "--summary",
    "--json",
    "--output-budget",
    "unbounded",
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const contracts = JSON.parse(raw);
const commands = Array.isArray(contracts.command_summaries)
  ? contracts.command_summaries
      .map((summary) => summary?.command)
      .filter((command) => typeof command === "string")
  : [];
const report = verifyPmCliGrammar(commands, PM_COMMAND_ALIAS_CONTRACTS);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) {
  process.exitCode = 1;
}
