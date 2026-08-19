#!/usr/bin/env node

/** Verify the generated public flag lexicon and no-growth command budgets. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  listPmCommandFlagBudgets,
  listPmFlagLexicon,
  listPmFlagSpellingInventory,
  verifyPmFlagLexicon,
} from "../../dist/sdk/cli-contracts/flag-lexicon-contracts.js";
import { buildCoreCommandProgram } from "./flag-invocation-parity.mjs";

const FLAG_SPELLING_BASELINE_PATH = fileURLToPath(
  new URL("./flag-spelling-baseline.json", import.meta.url),
);
const FLAG_HELP_BASELINE_PATH = fileURLToPath(
  new URL("./flag-help-baseline.json", import.meta.url),
);

/** Read the persisted pre-change executable spelling inventory. */
export function readFlagSpellingBaseline(
  baselinePath = FLAG_SPELLING_BASELINE_PATH,
) {
  return JSON.parse(readFileSync(baselinePath, "utf8"));
}

/** Measure every budgeted command's generated help surface in token estimates. */
export function measureCoreFlagHelpInventory({
  program = buildCoreCommandProgram(),
  budgets = listPmCommandFlagBudgets(),
} = {}) {
  return budgets
    .map(({ command }) => {
      const registered = program.commands.find(
        (candidate) =>
          candidate.name() === command || candidate.aliases().includes(command),
      );
      if (!registered) return null;
      const bytes = Buffer.byteLength(registered.helpInformation(), "utf8");
      return {
        command,
        help_bytes: bytes,
        estimated_tokens: Math.ceil(bytes / 4),
        maximum_tokens: Math.ceil(bytes / 4),
      };
    })
    .filter((entry) => entry !== null);
}

/** Run the flag lexicon gate with an optional negative-control budget breach. */
export function verifyFlagLexiconGate({
  injectMismatch = false,
  baseline = readFlagSpellingBaseline(),
  helpBaseline = JSON.parse(readFileSync(FLAG_HELP_BASELINE_PATH, "utf8")),
  helpInventory = measureCoreFlagHelpInventory(),
} = {}) {
  const canonicalBudgets = listPmCommandFlagBudgets();
  const budgets = injectMismatch
    ? canonicalBudgets.map((budget, index) =>
        index === 0 ? { ...budget, maximum: budget.maximum - 1 } : budget,
      )
    : canonicalBudgets;
  const lexiconReport = verifyPmFlagLexicon(
    listPmFlagLexicon(),
    budgets,
    baseline.entries,
  );
  const currentByCommand = new Map(
    helpInventory.map((entry) => [entry.command, entry]),
  );
  const helpFindings = [];
  const helpTokenDeltas = helpBaseline.entries.map((historical) => {
    const current = currentByCommand.get(historical.command);
    if (!current) {
      helpFindings.push({
        code: "missing_help_command",
        command: historical.command,
        detail: `${historical.command} no longer has a generated help surface.`,
      });
      return {
        command: historical.command,
        current_tokens: 0,
        baseline_tokens: historical.estimated_tokens,
        delta_tokens: -historical.estimated_tokens,
        maximum_tokens: historical.maximum_tokens,
      };
    }
    if (current.estimated_tokens > historical.maximum_tokens) {
      helpFindings.push({
        code: "help_token_budget_exceeded",
        command: historical.command,
        detail: `${current.estimated_tokens} estimated help tokens exceed the ratcheted maximum ${historical.maximum_tokens}.`,
      });
    }
    return {
      command: historical.command,
      current_tokens: current.estimated_tokens,
      baseline_tokens: historical.estimated_tokens,
      delta_tokens: current.estimated_tokens - historical.estimated_tokens,
      maximum_tokens: historical.maximum_tokens,
    };
  });
  for (const current of helpInventory) {
    if (
      helpBaseline.entries.some(
        (historical) => historical.command === current.command,
      )
    ) {
      continue;
    }
    helpFindings.push({
      code: "missing_help_token_baseline",
      command: current.command,
      detail: `${current.command} has no persisted help-token baseline.`,
    });
  }
  const findings = [...lexiconReport.findings, ...helpFindings].sort(
    (left, right) =>
      left.command.localeCompare(right.command) ||
      left.code.localeCompare(right.code) ||
      left.detail.localeCompare(right.detail),
  );
  return {
    ...lexiconReport,
    ok: findings.length === 0,
    help_command_count: helpInventory.length,
    help_baseline_version: helpBaseline.version,
    help_token_delta_total: helpTokenDeltas.reduce(
      (total, { delta_tokens: deltaTokens }) => total + deltaTokens,
      0,
    ),
    help_token_deltas: helpTokenDeltas,
    findings,
  };
}

/** Run the standalone repository gate. */
export function main(
  argv = process.argv.slice(2),
  {
    write = writeFileSync,
    spellingBaselinePath = FLAG_SPELLING_BASELINE_PATH,
    helpBaselinePath = FLAG_HELP_BASELINE_PATH,
    verifyOptions = {},
  } = {},
) {
  if (argv.includes("--update-inventory")) {
    write(
      spellingBaselinePath,
      `${JSON.stringify(
        { version: 1, entries: listPmFlagSpellingInventory() },
        null,
        2,
      )}\n`,
      "utf8",
    );
    write(
      helpBaselinePath,
      `${JSON.stringify(
        { version: 1, entries: measureCoreFlagHelpInventory() },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  const report = verifyFlagLexiconGate({
    ...verifyOptions,
    injectMismatch: argv.includes("--inject-mismatch"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

/** Run the gate only when this module is the invoked Node entrypoint. */
export function runIfMain(
  candidate = process.argv[1],
  argv = process.argv.slice(2),
  options = {},
) {
  if (candidate && pathToFileURL(candidate).href === import.meta.url) {
    main(argv, options);
  }
}

runIfMain();
