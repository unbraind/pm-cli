/** @module tests/integration/item-facets Real CLI evidence and internal package routing in an isolated workspace. */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskFixture } from "../helpers/createTaskFixture.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("item facet acceptance", () => {
  it("records every writable facet and preserves legacy reads and history integrity", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-facet-acceptance";
      createTaskFixture(context, id, "Canonical evidence facets");
      writeFileSync(path.join(context.tempRoot, "evidence.txt"), "Evidence\n");
      for (const [facet, args] of [
        ["comments", ["--add", "Comment evidence"]],
        ["notes", ["--add", "Note evidence"]],
        ["learnings", ["--add", "Learning evidence"]],
        ["files", ["--add", "path=evidence.txt,scope=project"]],
        ["docs", ["--add", "path=evidence.txt,scope=project"]],
        ["append", ["--body", "Body evidence"]],
        ["test", ["--add", "command=node --version,scope=project"]],
      ] as const) {
        const result = context.runCli(["item", facet, id, ...args, "--json"], { expectJson: true, cwd: context.tempRoot });
        expect(result.code, `${facet}: ${result.stderr}`).toBe(0);
      }
      for (const facet of ["comments", "notes", "learnings", "files", "docs", "deps", "test"]) {
        const results = [["item", facet], [facet]].map((prefix) => context.runCli([...prefix, id, "--json"], { expectJson: true, cwd: context.tempRoot }));
        for (const result of results) expect(result.code, result.stderr).toBe(0);
        expect(results[0].json).toEqual(results[1].json);
      }
      const history = context.runCli(["history", id, "--verify", "--json"], { expectJson: true });
      expect(history.code, history.stderr).toBe(0);
      const detail = context.runCli(["get", id, "--full", "--json", "--output-budget", "unbounded"], { expectJson: true });
      expect(detail.json).toMatchObject({ item: {
        body: expect.stringContaining("Body evidence"),
        comments: [expect.objectContaining({ text: "Comment evidence" })],
        notes: [expect.objectContaining({ text: "Note evidence" })],
        learnings: [expect.objectContaining({ text: "Learning evidence" })],
        files: [expect.objectContaining({ path: "evidence.txt" })],
        docs: [expect.objectContaining({ path: "evidence.txt" })],
        tests: [expect.objectContaining({ command: "node --version" })],
      } });
    });
  }, 120_000);

  it("hides internal children while preserving direct helper calls and package lifecycle", async () => {
    await withTempPmPath(async (context) => {
      const installed = context.runCli(["package", "install", "guide-shell", "--project", "--json"], { expectJson: true });
      expect(installed.code, installed.stderr).toBe(0);
      for (const full of [false, true]) {
        const contracts = context.runCli(["contracts", "--flags-only", "--json", "--output-budget", "unbounded", ...(full ? ["--full"] : [])], { expectJson: true });
        expect(contracts.code, contracts.stderr).toBe(0);
        const commands = (contracts.json as { commands: string[] }).commands;
        for (const internal of ["item test worker", "completion statuses", "completion tags", "completion types"]) {
          expect(commands.includes(internal), internal).toBe(full);
        }
      }
      const workerContract = context.runCli(["contracts", "--command", "item test worker", "--flags-only", "--json"], { expectJson: true });
      expect(workerContract.code, workerContract.stderr).toBe(0);
      expect(workerContract.json).toMatchObject({ command_flags: [{ visibility: "internal", flags: [], positionals: [expect.objectContaining({ name: "runId", required: true })] }] });
      for (const facet of ["statuses", "tags", "types"]) {
        const canonical = context.runCli(["completion", facet], { cwd: context.tempRoot });
        const legacy = context.runCli([`completion-${facet}`], { cwd: context.tempRoot });
        expect(canonical.code, canonical.stderr).toBe(0);
        expect(legacy.code, legacy.stderr).toBe(0);
        expect(canonical.stdout).toBe(legacy.stdout);
      }
      for (const prefix of [["item", "test"], ["completion"]]) {
        const help = context.runCli([...prefix, "--help", "--all", "--json"], { expectJson: true });
        expect(help.code, help.stderr).toBe(0);
        const children = (help.json as { subcommands?: { tier: string }[] }).subcommands ?? [];
        expect(children.some((child) => child.tier === "internal")).toBe(false);
      }
      const worker = context.runCli(["item", "test", "worker", "--help", "--json"], { expectJson: true });
      expect(worker.code, worker.stderr).toBe(0);
      expect(worker.json).toMatchObject({ visibility_tier: "internal" });
    });
  }, 120_000);
});
