import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("help discovery before collection mutation", () => {
  it.each(["test", "files", "docs"])("keeps %s item and history bytes unchanged for bare help flags", async (command) => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "help must be read only" });
      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const before = await Promise.all([readFile(itemPath, "utf8"), readFile(historyPath, "utf8")]);
      for (const help of ["--help", "-h"]) {
        const result = context.runCli([command, id, "--add", help]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain("Usage:");
        expect(await Promise.all([readFile(itemPath, "utf8"), readFile(historyPath, "utf8")])).toEqual(before);
      }
      const json = context.runCli([command, id, "--add", "--help", "--json"], { expectJson: true });
      expect(json.code).toBe(0);
      expect(json.json).toMatchObject({ format: "pm_help_v1" });
      expect(await Promise.all([readFile(itemPath, "utf8"), readFile(historyPath, "utf8")])).toEqual(before);
    });
  });

  it("retains an explicitly attached literal help value", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "literal help file" });
      const result = context.runCli(["files", id, "--add=--help", "--json"], { expectJson: true });
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({ files: [{ path: "--help" }] });
    });
  });

  it("separates short create-body discovery from a literal bare body assignment", async () => {
    await withTempPmPath(async (context) => {
      createTestItemId(context, { title: "existing item before discovery" });
      const tasks = path.join(context.pmPath, "tasks");
      const before = (await readdir(tasks)).sort();
      const create = ["create", "--type", "Task", "--title", "body intent", "--description", "Preserve explicit input intent", "--create-mode", "progressive"];
      const help = context.runCli([...create, "-b", "-h"]);
      expect(help.code, help.stderr).toBe(0);
      expect(help.stdout).toContain("Usage:");
      expect((await readdir(tasks)).sort()).toEqual(before);

      const literal = context.runCli([...create, "body=--help", "--json"], { expectJson: true });
      expect(literal.code, literal.stderr).toBe(0);
      const created = (await readdir(tasks)).filter((name) => !before.includes(name));
      expect(created).toHaveLength(1);
      const item = context.runCli(["get", path.basename(created[0], ".toon"), "--full", "--json"], { expectJson: true });
      expect(item.code, item.stderr).toBe(0);
      expect(item.json).toMatchObject({ item: { body: "--help" } });
    });
  });
});
