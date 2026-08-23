#!/usr/bin/env node
/**
 * Generate or verify agent-facing command-tier documentation from the SDK
 * contract compiled into dist.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  renderPmCapabilityRoutingMarkdown,
  renderPmCommandVisibilityMarkdown,
} from "../dist/sdk/agent-capability-contracts.js";
import { listCoreClosedDomainContracts } from "../dist/sdk/agent/closed-domain-contracts.js";
import {
  buildPmRefusalClosureCensus,
  renderPmRefusalClosureCensusMarkdown,
} from "../dist/sdk/agent/refusal-closure-census.js";
import {
  listPmRequiredArgumentRefusalContracts,
  listPmSubcommandRefusalContracts,
} from "../dist/sdk/agent/refusal-corpus-contracts.js";
import { PM_ERROR_CODE_CATALOG } from "../dist/sdk/generated-error-code-catalog.js";
import { renderPmFlagLexiconMarkdown } from "../dist/sdk/cli-contracts/flag-lexicon-contracts.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export async function main(
  root = repositoryRoot,
  args = process.argv.slice(2),
) {
  const refusalClosureCensus = buildPmRefusalClosureCensus(
    PM_ERROR_CODE_CATALOG,
    listCoreClosedDomainContracts(),
    [
      ...listPmRequiredArgumentRefusalContracts(),
      ...listPmSubcommandRefusalContracts(),
    ],
  );
  const outputs = [
    ["AGENT_COMMAND_SURFACE.md", renderPmCommandVisibilityMarkdown()],
    ["AGENT_CAPABILITY_ROUTING.md", renderPmCapabilityRoutingMarkdown()],
    ["FLAG_LEXICON_BUDGETS.md", renderPmFlagLexiconMarkdown()],
    [
      "REFUSAL_CLOSURE_CENSUS.md",
      renderPmRefusalClosureCensusMarkdown(refusalClosureCensus),
    ],
  ];
  if (args.includes("--check")) {
    for (const [filename, expected] of outputs) {
      const actual = await readFile(
        path.join(root, "docs", "generated", filename),
        "utf8",
      ).catch(() => "");
      if (actual !== expected) {
        throw new Error(
          `Generated agent capability surface ${filename} is stale. Run pnpm contracts:agent-surfaces:update.`,
        );
      }
    }
    return;
  }
  const outputDirectory = path.join(root, "docs", "generated");
  await mkdir(outputDirectory, { recursive: true });
  for (const [filename, expected] of outputs) {
    await writeFile(path.join(outputDirectory, filename), expected, "utf8");
  }
}

/* c8 ignore start -- CLI auto-run guard; logic is covered through main(). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
/* c8 ignore stop */
