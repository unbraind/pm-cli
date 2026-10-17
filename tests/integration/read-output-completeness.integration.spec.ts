/**
 * @module tests/integration/read-output-completeness.integration
 *
 * Proves explicit complete-result intent and whole-result omission semantics at
 * the real CLI and shared SDK/MCP action transport boundaries.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAction } from "../../src/sdk/index.js";
import { handleRequest } from "../../src/mcp/server.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("explicit complete read output", () => {
  it("renders bounded Unicode through the real CLI and MCP read transports", async () => {
    await withTempPmPath(async (context) => {
      const title = `${"a".repeat(239)}😀${"z".repeat(5000)}`;
      expect(context.runCli(["create", "--id", "pm-unicode-read", "--title", title, "--type", "Task", "--json"]).code).toBe(0);
      for (const format of ["json", "toon"]) {
        const cli = context.runCli(["list", "--output-format", format, "--output-budget", "1000"]);
        expect(cli.code, cli.stderr).toBe(0);
        expect(cli.stdout).toContain(`${"a".repeat(239)}…`);
        expect(cli.stdout).not.toContain("�");
        const mcp = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pm_list", arguments: { path: context.pmPath, outputBudget: 1000, outputFormat: format } } });
        expect(JSON.stringify(mcp)).toContain(`${"a".repeat(239)}…`);
        expect(JSON.stringify(mcp)).not.toContain("\\ud83d");
      }
      expect(context.runCli(["get", "pm-unicode-read", "--json", "--full", "--output-budget", "unbounded"], { expectJson: true }).json).toMatchObject({ item: { title } });
    });
  });

  it("lets explicit full intent defeat only the implicit default ceiling", async () => {
    await withTempPmPath(async (context) => {
      const complete = context.runCli(
        ["--no-extensions", "contracts", "--json", "--full"],
        { expectJson: true },
      );
      expect(complete.code, complete.stderr).toBe(0);
      expect(complete.json).toMatchObject({
        commands: expect.any(Array),
        actions: expect.any(Array),
      });

      const explicitBudget = context.runCli([
        "--no-extensions",
        "contracts",
        "--json",
        "--full",
        "--output-budget",
        "256",
      ]);
      expect(explicitBudget.code).toBe(2);
      expect(JSON.parse(explicitBudget.stdout)).toMatchObject({
        output_budget_exceeded: {
          omitted_result: true,
          reason: "requested_budget_infeasible",
        },
      });

      const action = await runAction({
        action: "contracts",
        path: context.pmPath,
        noExtensions: true,
        options: { full: true },
      });
      expect(action).toMatchObject({
        commands: expect.any(Array),
        actions: expect.any(Array),
      });
    });
  });
});


describe("canonical mutation output encoding", () => {
  it("runs create, update, annotate and close through the same real CLI grammar", async () => {
    await withTempPmPath(async ({ runCli, pmPath }) => {
      const created = runCli(["create", "Task", "Canonical encoding", "--create-mode", "progressive", "--output-format", "json"], { expectJson: true });
      expect(created.code, created.stderr).toBe(0);
      // The test harness normalizes flat mutation receipts into item for callers.
      const id = (created.json as { item: { id: string } }).item.id;
      for (const args of [["update", id, "--priority", "1"], ["comments", id, "Encoding is shared"], ["close", id, "Verified encoding"]]) {
        const result = runCli([...args, "--output-format", "json"], { expectJson: true });
        expect(result.code, result.stderr).toBe(0);
        expect(result.json).toMatchObject(args[0] === "comments" ? { id } : { item: { id } });
      }
      const sdk = await runAction({ action: "create", path: pmPath, noExtensions: true, options: { title: "SDK encoding", type: "Task", createMode: "progressive", outputFormat: "json" } });
      expect(sdk).toHaveProperty("id");
      const refused = runCli(["create", "Task", "Must not exist", "--output-format", "json", "--output-limit", "1"]);
      expect(refused.code).toBe(2);
      const listed = runCli(["list", "--all", "--json"], { expectJson: true });
      expect(JSON.stringify(listed.json)).not.toContain("Must not exist");
      const persistentPaths = [join(pmPath, "tasks", `${id}.toon`), join(pmPath, "history", `${id}.jsonl`)];
      const beforeHybridMutations = await Promise.all(persistentPaths.map((path) => readFile(path, "utf8")));
      for (const [command, addition] of [["notes", "Rejected note"], ["files", "path=src/rejected.ts"], ["docs", "path=docs/rejected.md"]]) {
        const rejected = runCli([command, id, "--add", addition, "--output-format", "json", "--output-limit", "1"]);
        expect(rejected.code, rejected.stderr).toBe(2);
        expect(rejected.stderr).toContain(`cannot be combined with a ${command} mutation`);
        expect(await Promise.all(persistentPaths.map((path) => readFile(path, "utf8")))).toEqual(beforeHybridMutations);
      }
      const toon = runCli(["update", id, "--priority", "2", "--output-format", "toon"]);
      expect(toon.code, toon.stderr).toBe(0);
      expect(toon.stdout).toContain(`id: "${id}"`);
    });
  });
});
