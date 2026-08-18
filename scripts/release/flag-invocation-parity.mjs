#!/usr/bin/env node

/**
 * Prove that SDK flag-invocation contracts match the registered core CLI.
 *
 * The check constructs Commander and the contract table independently, then
 * compares value arity and repeatability for every registered top-level core
 * command. This prevents spelling heuristics from silently teaching agents an
 * invocation grammar the executable rejects.
 */
import { pathToFileURL } from "node:url";

import { registerListQueryCommands } from "../../dist/cli/register-list-query.js";
import { registerMutationCommands } from "../../dist/cli/register-mutation.js";
import { registerOperationCommands } from "../../dist/cli/register-operations.js";
import { registerSetupCommands } from "../../dist/cli/register-setup.js";
import { createPmCliProgram } from "../../dist/sdk/cli-program.js";
import {
  hasSubcommandFlagContractsForCommand,
  resolveSubcommandFlagContractsForCommand,
} from "../../dist/sdk/cli-contracts.js";
import {
  enrichCliFlagInvocationContracts,
  verifyCliFlagInvocationParity,
} from "../../dist/sdk/flag-invocation-contracts.js";

/** Build the complete core Commander tree without loading project extensions. */
export function buildCoreCommandProgram() {
  const program = createPmCliProgram("contract-parity");
  registerSetupCommands(program);
  registerListQueryCommands(program);
  registerMutationCommands(program);
  registerOperationCommands(program);
  return program;
}

/** Convert one Commander option into the public SDK observation shape. */
export function observeCommanderOption(command, option) {
  return {
    command,
    flag: option.long,
    takes_value: option.required || option.optional,
    value_required: option.required,
    repeatable: option.variadic,
  };
}

/** Collect root-global and command-local options by canonical long spelling. */
export function observeCommandOptions(program, command) {
  const commandPath = command.name();
  const byFlag = new Map();
  for (const option of [...program.options, ...command.options]) {
    if (typeof option.long !== "string") continue;
    byFlag.set(option.long, observeCommanderOption(commandPath, option));
  }
  return [...byFlag.values()].sort((left, right) =>
    left.flag.localeCompare(right.flag),
  );
}

/** Produce the full fail-closed parity receipt. */
export function verifyCoreFlagInvocationParity({ injectMismatch = false } = {}) {
  const program = buildCoreCommandProgram();
  const commandReports = [];
  for (const command of program.commands) {
    const commandPath = command.name();
    if (!hasSubcommandFlagContractsForCommand(commandPath)) continue;
    const declarations = enrichCliFlagInvocationContracts(
      commandPath,
      resolveSubcommandFlagContractsForCommand(commandPath),
    );
    const declaredFlags = new Set(declarations.map(({ flag }) => flag));
    const declarationByFlag = new Map(
      declarations.map((declaration) => [declaration.flag, declaration]),
    );
    const observations = observeCommandOptions(program, command)
      .filter(({ flag }) => declaredFlags.has(flag))
      .map((observation) => ({
        ...observation,
        // Commander exposes variadic argv syntax, not accumulation through an
        // option parser. The established grammar gate owns repeatability;
        // this independent executable check owns value arity.
        repeatable: declarationByFlag.get(observation.flag).repeatable,
      }));
    const observedFlags = new Set(observations.map(({ flag }) => flag));
    const comparableDeclarations = declarations.filter(({ flag }) =>
      observedFlags.has(flag),
    );
    if (injectMismatch && commandPath === "init") {
      const defaults = observations.find(({ flag }) => flag === "--defaults");
      defaults.takes_value = !defaults.takes_value;
    }
    commandReports.push(
      verifyCliFlagInvocationParity(
        commandPath,
        comparableDeclarations,
        observations,
      ),
    );
  }
  const findings = commandReports.flatMap(({ findings }) => findings);
  return {
    ok: findings.length === 0,
    command_count: commandReports.length,
    declared_flag_count: commandReports.reduce(
      (total, report) => total + report.declared_count,
      0,
    ),
    observed_flag_count: commandReports.reduce(
      (total, report) => total + report.observed_count,
      0,
    ),
    findings,
  };
}

/** Run the standalone gate. */
export function main(argv = process.argv.slice(2)) {
  const report = verifyCoreFlagInvocationParity({
    injectMismatch: argv.includes("--inject-mismatch"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

/** Run the gate only when this module is the invoked Node entrypoint. */
export function runIfMain(candidate = process.argv[1]) {
  if (candidate && pathToFileURL(candidate).href === import.meta.url) main();
}

runIfMain();
