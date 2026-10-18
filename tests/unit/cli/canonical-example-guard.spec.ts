import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { readSettings } from "../../../src/core/store/settings.js";
import { PM_COMMAND_ALIAS_CONTRACTS } from "../../../src/sdk/cli-contracts/command-aliases.js";
import { findBootstrapCommandTokenIndex } from "../../../src/sdk/cli-contracts/bootstrap-command-scanner.js";
import { runInitAgentGuidance } from "../../../src/sdk/init-agent-guidance.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const deprecated = PM_COMMAND_ALIAS_CONTRACTS.filter((entry) => entry.lifecycle === "deprecated");

/** Inspect command argv without mistaking quoted operand content for executable examples. */
function deprecatedInvocations(example: string): string[] {
  // Keep quoted operand text intact, and inspect each shell/Markdown command.
  const tokens = example.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s`;&|]+|[`\n;&|]/g) ?? [];
  const commands: string[][] = [[]];
  for (const token of tokens) {
    if (/^[`\n;&|]$/.test(token)) commands.push([]);
    else commands.at(-1)!.push(token);
  }
  return commands.flatMap((command) => {
    if (command[0] === "$") command = command.slice(1);
    if (command[0] !== "pm") return [];
    const argv = command.slice(1);
    const index = findBootstrapCommandTokenIndex(argv);
    if (index === undefined) return [];
    return deprecated.filter((entry) => entry.alias.split(" ").every((token, offset) => argv[index + offset] === token)).map((entry) => entry.alias);
  });
}

/** Collect literal and interpolated command examples without executing production modules. */
function exampleLiterals(filename: string, source: string): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const examples = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) examples.add(node.text);
    else if (ts.isTemplateExpression(node)) examples.add(node.head.text + node.templateSpans.map((span) => `__value__${span.literal.text}`).join(""));
    else ts.forEachChild(node, collect);
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) && /examples$/i.test(node.name.getText(file).replaceAll(/["']/g, "")) && node.initializer) collect(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...examples];
}

describe("canonical example guard", () => {
  it("rejects deprecated argv in literal and interpolated examples without treating quoted data as commands", () => {
    const examples = exampleLiterals("fixture.ts", 'const payload = { examples: ["pm list-open", `pm --json list-all --limit ${limit}`, "pm notes id --add \'pm list-open\'", "pm list --status open"] };');
    expect(examples.flatMap(deprecatedInvocations)).toEqual(["list-open", "list-all"]);
    expect(deprecatedInvocations("`pm extension doctor` && pm --author 'reviewer' list-closed")).toEqual(["extension", "list-closed"]);
  });

  it("keeps example literals in help bundles, diagnostic details and recovery builders canonical", async () => {
    const root = path.resolve("src");
    const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".ts"));
    const sources = await Promise.all(files.map(async (file) => ({ file, examples: exampleLiterals(file, await readFile(path.join(root, file), "utf8")) })));
    for (const owner of ["cli/help-content.ts", "sdk/query/list.ts", "cli/register-mutation.ts"]) {
      expect(sources.find(({ file }) => file.split(path.sep).join("/") === owner)?.examples.length, owner).toBeGreaterThan(0);
    }
    const violations = sources.flatMap(({ file, examples }) => examples.flatMap((example) => deprecatedInvocations(example).map((alias) => ({ file, alias, example }))));
    expect(violations).toEqual([]);
  });

  it("keeps every command in generated AGENTS and CLAUDE guidance canonical", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const root = path.dirname(path.dirname(pmPath));
      for (const filename of ["AGENTS.md", "CLAUDE.md"]) await writeFile(path.join(root, filename), "# User guidance\n<!-- pm-cli:agent-guidance:start:v1 -->\n<!-- pm-cli:agent-guidance:end -->\n");
      await runInitAgentGuidance({ pm_root: pmPath, cwd: root, settings: await readSettings(pmPath), interactive: false, mode: "add" });
      for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
        const guidance = await readFile(path.join(root, filename), "utf8");
        expect(guidance).toContain("pm list --status open");
        expect(deprecatedInvocations(guidance), filename).toEqual([]);
      }
    });
  });
});
