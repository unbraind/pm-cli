import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PM_COMMAND_ALIAS_CONTRACTS } from "../../../src/sdk/cli-contracts/command-aliases.js";
import { runAction } from "../../../src/sdk/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("format compatibility across item operations", () => {
  it("accepts JSON and TOON on collection reads, writes and leading global positions", async () => {
    await withTempPmPath(async ({ runCli, pmPath }) => {
      const created = runCli(["--format", "json", "create", "Task", "Format fixture", "--create-mode", "progressive"], { expectJson: true });
      expect(created.code, created.stderr).toBe(0);
      const id = created.json?.item?.id as string;
      expect(id).toEqual(expect.any(String));
      for (const command of ["comments", "notes", "learnings", "files", "docs", "test"]) {
        const result = runCli([command, id, "--format=json"], { expectJson: true });
        expect(result.code, result.stderr).toBe(0);
        expect(result.json).toHaveProperty("id", id);
      }
      for (const args of [["claim", id], ["update", id, "--priority", "1"], ["comments", id, "Format write"], ["release", id], ["close", id, "Verified format"]]) {
        const result = runCli([...args, "--format", "json"], { expectJson: true });
        expect(result.code, result.stderr).toBe(0);
        const payload = JSON.parse(result.stdout) as { id?: string; item?: { id: string } };
        expect(payload.id ?? payload.item?.id).toBe(id);
      }
      const toon = runCli(["--format=toon", "notes", id]);
      expect(toon.code, toon.stderr).toBe(0);
      expect(toon.stdout).toContain(`id: "${id}"`);
      const nested = runCli(["item", "notes", id, "--format", "json"], { expectJson: true });
      expect(nested.code, nested.stderr).toBe(0);
      expect(nested.json).toHaveProperty("id", id);
      const contracts = await runAction({ action: "contracts", path: pmPath, noExtensions: true, options: { command: "notes", flagsOnly: true } });
      expect(contracts).toMatchObject({ command_flags: [expect.objectContaining({ flags: expect.arrayContaining([expect.objectContaining({ flag: "--output-format", aliases: ["--format"] })]) })] });
    });
  });

  it("retains domain formats and refuses invalid or shaping mutation controls before writing", async () => {
    await withTempPmPath(async ({ runCli, pmPath }) => {
      const created = runCli(["create", "Task", "Preserved fixture", "--create-mode", "progressive", "--json"], { expectJson: true });
      expect(created.code, created.stderr).toBe(0);
      const id = created.json?.item?.id as string;
      const paths = [join(pmPath, "tasks", `${id}.toon`), join(pmPath, "history", `${id}.jsonl`)];
      const before = await Promise.all(paths.map((file) => readFile(file, "utf8")));
      for (const options of [["--format", "yaml"], ["--format=json", "--output-limit", "1"]]) {
        const refused = runCli(["notes", id, "--add", "Must not persist", ...options]);
        expect(refused.code, refused.stderr).toBe(2);
        expect(await Promise.all(paths.map((file) => readFile(file, "utf8")))).toEqual(before);
      }
      const graph = runCli(["deps", id, "--format", "graph", "--json"], { expectJson: true });
      expect(graph.code, graph.stderr).toBe(0);
      expect(graph.json).toHaveProperty("graph");
      const csv = runCli(["list", "--format", "csv"]);
      expect(csv.code, csv.stderr).toBe(0);
      expect(csv.stdout).toContain("title");
      const setting = runCli(["config", "project", "set", "item-format", "--format", "toon", "--json"], { expectJson: true });
      expect(setting.code, setting.stderr).toBe(0);
    });
  });
});

describe("canonical diagnostic examples", () => {
  it("never teaches a deprecated alias while recovering projection or plan grammar", async () => {
    await withTempPmPath(async ({ runCli }) => {
      for (const args of [["list", "--fields", "bogus"], ["plan", "list"]]) {
        const refused = runCli([...args, "--json"]);
        expect(refused.code).toBe(2);
        const examples = (JSON.parse(refused.stderr) as { examples: string[] }).examples;
        expect(examples, refused.stderr).toBeDefined();
        expect(examples.length).toBeGreaterThan(0);
        for (const alias of PM_COMMAND_ALIAS_CONTRACTS.filter((entry) => entry.lifecycle === "deprecated")) {
          expect(examples.some((example) => `${example} `.includes(`pm ${alias.alias} `)), JSON.stringify(examples)).toBe(false);
        }
      }
    });
  });
});
