#!/usr/bin/env node

/** Verify the generated public flag lexicon and no-growth command budgets. */
import { pathToFileURL } from "node:url";

import {
  listPmCommandFlagBudgets,
  listPmFlagLexicon,
  verifyPmFlagLexicon,
} from "../../dist/sdk/cli-contracts/flag-lexicon-contracts.js";

/** Run the flag lexicon gate with an optional negative-control budget breach. */
export function verifyFlagLexiconGate({ injectMismatch = false } = {}) {
  const canonicalBudgets = listPmCommandFlagBudgets();
  const budgets = injectMismatch
    ? canonicalBudgets.map((budget, index) =>
        index === 0 ? { ...budget, maximum: budget.maximum - 1 } : budget,
      )
    : canonicalBudgets;
  return verifyPmFlagLexicon(listPmFlagLexicon(), budgets);
}

/** Run the standalone repository gate. */
export function main(argv = process.argv.slice(2)) {
  const report = verifyFlagLexiconGate({
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
