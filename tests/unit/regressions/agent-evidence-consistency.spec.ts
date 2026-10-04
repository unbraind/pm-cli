/**
 * @module tests/unit/regressions/agent-evidence-consistency
 *
 * Protects literal annotation evidence, declared recovery targets and strict
 * item/history agreement when an ordinary writer advances a captured item.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listAllItemMetadataWithBody, locateItem } from "../../../src/core/store/item-store.js";
import { buildValidateHistoryDriftCheck } from "../../../src/sdk/governance/validate-history-drift.js";
import { runComments } from "../../../src/sdk/comments.js";
import { resolveCommanderUsageContext } from "../../../src/cli/commander-usage.js";
import { formatCommanderErrorForJson } from "../../../src/cli/error-guidance.js";
import { createPmCliProgram } from "../../../src/sdk/cli-program.js";
import { acquireLock } from "../../../src/core/lock/lock.js";
import { getHistoryPath, getLockPath } from "../../../src/core/store/paths.js";
import { normalizeBootstrapInvocation } from "../../../src/sdk/cli-bootstrap.js";
import { createTestItem } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("agent evidence consistency", () => {
  it.each(["existing", "missing"])("rejects a reread redirected to an %s item identity", async (target) => {
    await withTempPmPath(async (context) => {
      const created = createTestItem(context, { title: "Captured identity" });
      const sibling = createTestItem(context, { title: "Other identity" });
      const captured = await listAllItemMetadataWithBody(context.pmPath);
      await runComments(created.id, { add: "ordinary writer" }, { path: context.pmPath });
      const located = await locateItem(context.pmPath, created.id);
      const source = await fs.readFile(located!.itemPath, "utf8");
      await fs.writeFile(located!.itemPath, source.replace(created.id, target === "existing" ? sibling.id : "pm-missing"));
      await expect(buildValidateHistoryDriftCheck(context.pmPath, captured, true)).rejects.toMatchObject({ context: { code: "item_identity_conflict" } });
      await expect(fs.stat(getLockPath(context.pmPath, created.id))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("reads the corpus cache once while rechecking multiple advanced items", async () => {
    await withTempPmPath(async (context) => {
      const ids = [createTestItem(context, { title: "First writer" }).id, createTestItem(context, { title: "Second writer" }).id];
      const captured = await listAllItemMetadataWithBody(context.pmPath);
      for (const id of ids) await runComments(id, { add: "ordinary writer" }, { path: context.pmPath });
      // Observe real reads without replacing their implementation or results.
      const reads = vi.spyOn(fs, "readFile");
      try {
        const result = await buildValidateHistoryDriftCheck(context.pmPath, captured, true);
        expect(result.check.ok).toBe(true);
        expect(reads.mock.calls.filter(([file]) => String(file) === path.join(context.pmPath, "runtime", "history-drift-cache.json"))).toHaveLength(1);
      } finally {
        reads.mockRestore();
      }
    });
  });

  it("rechecks an advanced source snapshot without accepting stable source corruption", async () => {
    await withTempPmPath(async (context) => {
      const created = createTestItem(context, { title: "Concurrent evidence" });
      const sibling = createTestItem(context, { title: "Independent evidence" });
      const captured = await listAllItemMetadataWithBody(context.pmPath);
      await runComments(created.id, { add: "TDD: ordinary writer" }, { path: context.pmPath });

      const advanced = await buildValidateHistoryDriftCheck(context.pmPath, captured, true);
      expect(advanced.check.details.counts).toMatchObject({ hash_mismatches: 0, chain_mismatches: 0 });
      expect(advanced.check.details.drifted_items).toEqual([]);
      const cache = JSON.parse(await fs.readFile(path.join(context.pmPath, "runtime", "history-drift-cache.json"), "utf8")) as { entries: Record<string, unknown> };
      expect(Object.keys(cache.entries).sort()).toEqual([created.id, sibling.id].sort());

      const located = await locateItem(context.pmPath, created.id);
      expect(located).not.toBeNull();
      const source = await fs.readFile(located!.itemPath, "utf8");
      await fs.writeFile(located!.itemPath, source.replace("Concurrent evidence", "Unrecorded source tampering"));
      const corrupted = await listAllItemMetadataWithBody(context.pmPath);
      const stable = await buildValidateHistoryDriftCheck(context.pmPath, corrupted, true);
      expect(stable.check.ok).toBe(false);
      expect(stable.check.details.counts).toMatchObject({ hash_mismatches: 1, chain_mismatches: 0 });
      expect(stable.check.details.drifted_items).toEqual([created.id]);
    });
  });

  it.each(["missing", "unreadable", "chain", "identity", "epoch", "removed-source"])("retains stable %s findings during consistent validation", async (kind) => {
    await withTempPmPath(async (context) => {
      const created = createTestItem(context, { title: "Strict history" });
      const captured = await listAllItemMetadataWithBody(context.pmPath);
      const history = getHistoryPath(context.pmPath, created.id);
      const original = await fs.readFile(history, "utf8");
      if (kind === "missing") {
        await fs.rm(history);
      } else if (kind === "removed-source") {
        await runComments(created.id, { add: "ordinary writer" }, { path: context.pmPath });
        const located = await locateItem(context.pmPath, created.id);
        await fs.rm(located!.itemPath);
        await expect(buildValidateHistoryDriftCheck(context.pmPath, captured, true)).rejects.toMatchObject({ context: { code: "item_not_found" } });
        await expect(fs.stat(getLockPath(context.pmPath, created.id))).rejects.toMatchObject({ code: "ENOENT" });
        return;
      } else if (kind === "unreadable") {
        await fs.writeFile(history, '{"op":"noop"}\n');
      } else if (kind === "chain") {
        await fs.writeFile(history, JSON.stringify({ before_hash: "deadbeef", after_hash: "feedface", patch: [] }) + "\n");
      } else if (kind === "identity") {
        await fs.writeFile(history, original + original);
      } else {
        const entry = JSON.parse(original) as Record<string, unknown>;
        await fs.writeFile(history, JSON.stringify({ ...entry, item_hash_version: 99 }) + "\n");
      }
      const result = await buildValidateHistoryDriftCheck(context.pmPath, captured, true);
      expect(result.check.ok).toBe(false);
      expect(result.check.details.drifted_items).toEqual([created.id]);
      const counts = result.check.details.counts as Record<string, number>;
      expect(counts[kind === "missing" ? "missing_streams" : kind === "unreadable" ? "unreadable_streams" : "chain_mismatches"]).toBe(1);
      if (kind === "identity") {
        expect(result.check.status).toBe("error");
        expect(result.check.details.identity_discontinuities_count).toBeGreaterThan(0);
      }
      if (kind === "epoch") expect(counts.version_skews).toBe(1);
      await expect(fs.stat(getLockPath(context.pmPath, created.id))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("retains independent identity findings while rechecking multiple corrupt item hashes", async () => {
    await withTempPmPath(async (context) => {
      const ids = [
        createTestItem(context, { title: "First identity" }).id,
        createTestItem(context, { title: "Second identity" }).id,
      ];
      for (const id of ids) {
        const history = getHistoryPath(context.pmPath, id);
        const original = await fs.readFile(history, "utf8");
        await fs.writeFile(history, original + original);
        const located = await locateItem(context.pmPath, id);
        const source = await fs.readFile(located!.itemPath, "utf8");
        await fs.writeFile(located!.itemPath, source.replace("identity", "unrecorded title"));
      }
      const captured = await listAllItemMetadataWithBody(context.pmPath);
      const result = await buildValidateHistoryDriftCheck(context.pmPath, captured, true);
      expect(result.check.status).toBe("error");
      expect(result.check.details.counts).toMatchObject({ hash_mismatches: 2, chain_mismatches: 2 });
      expect(result.check.details.identity_discontinuities_count).toBe(2);
      expect(result.check.details.drifted_items).toEqual(ids.sort());
    });
  });

  it("reports contention without stealing a writer lock and releases its own lock after source failure", async () => {
    await withTempPmPath(async (context) => {
      const created = createTestItem(context, { title: "Contended evidence" });
      const captured = await listAllItemMetadataWithBody(context.pmPath);
      await runComments(created.id, { add: "ordinary writer" }, { path: context.pmPath });
      const release = await acquireLock(context.pmPath, created.id, 60, "ordinary-writer");
      const previousWait = process.env.PM_LOCK_WAIT_MS;
      process.env.PM_LOCK_WAIT_MS = "0";
      try {
        await expect(buildValidateHistoryDriftCheck(context.pmPath, captured, true)).rejects.toThrow(/lock/i);
        expect(await fs.readFile(getLockPath(context.pmPath, created.id), "utf8")).toContain("ordinary-writer");
      } finally {
        if (previousWait === undefined) delete process.env.PM_LOCK_WAIT_MS;
        else process.env.PM_LOCK_WAIT_MS = previousWait;
        await release();
      }
      expect((await buildValidateHistoryDriftCheck(context.pmPath, captured, true)).check.ok).toBe(true);
      const located = await locateItem(context.pmPath, created.id);
      await fs.writeFile(located!.itemPath, Buffer.from([0xff]));
      await expect(buildValidateHistoryDriftCheck(context.pmPath, captured, true)).rejects.toThrow();
      await expect(fs.stat(getLockPath(context.pmPath, created.id))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("preserves annotation evidence in the public bootstrap normalizer", () => {
    for (const command of ["comments", "notes", "learnings"]) {
      for (const literal of ["TDD: prefix proof", "add: literal annotation", "text: structured annotation"]) {
        expect(normalizeBootstrapInvocation([command, "pm-example", literal]).argv.slice(-2)).toEqual(["pm-example", literal]);
      }
    }
  });

  it.each(["comments", "notes", "learnings"])("preserves literal %s prefixes through every text transport", async (collection) => {
    await withTempPmPath(async (context) => {
      const created = createTestItem(context, { title: "Literal evidence" });
      const literal = "TDD: prefix proof";
      const file = path.join(context.tempRoot, "evidence.txt");
      await fs.writeFile(file, literal);
      const sources = [
        { args: [literal] },
        { args: ["--add", literal] },
        { args: ["--file", file] },
        { args: ["--stdin"], input: literal },
        { args: ["--add", "-"], input: literal },
        { args: ["--file", "-"], input: literal },
      ];
      for (const source of sources) {
        const result = context.runCli(["--no-extensions", collection, created.id, ...source.args, "--json"], {
          cwd: context.tempRoot,
          input: source.input,
          expectJson: true,
        });
        expect(result.status, result.stderr).toBe(0);
        const output = result.json as Record<string, Array<{ text: string }>>;
        expect(output[collection].at(-1)?.text).toBe(literal);
      }
      const saved = context.runCli(["get", created.id, "--full", "--json"], { expectJson: true });
      const item = (saved.json as { item: Record<string, Array<{ text: string }>> }).item;
      expect(item[collection].map((entry) => entry.text)).toEqual(sources.map(() => literal));
    });
  }, 60_000);

  it.each([
    { argv: ["--not-a-real-option", "synthetic-value", "context"], command: undefined, example: "pm --help --all" },
    { argv: ["--not-a-real-option", "synthetic-value"], command: undefined, example: "pm --help --all" },
    { argv: ["--not-a-real-option=synthetic-value", "context"], command: "context", example: "pm context --help" },
    { argv: ["--not-a-real-option=synthetic-value"], command: undefined, example: "pm --help --all" },
    { argv: ["--not-a-real-option=synthetic-value", "evidence-probe"], command: "evidence-probe", example: "pm evidence-probe --help" },
    { argv: ["context", "--not-a-real-option", "synthetic-value"], command: "context", example: "pm context --help" },
    { argv: ["item", "get", "pm-example", "--not-a-real-option", "synthetic-value"], command: "item", example: "pm item --help" },
  ])("keeps unknown-option recovery declared for $argv", async ({ argv, command, example }) => {
    const previous = process.argv;
    try {
      process.argv = ["node", "pm", "--no-extensions", ...argv];
      const flag = argv.find((token) => token.startsWith("--not-a-real-option"))!;
      const program = createPmCliProgram("test");
      program.command("evidence-probe");
      const context = await resolveCommanderUsageContext({ message: `unknown option '${flag}'` }, program, new Map());
      expect(context.commandName).toBe(command);
      const envelope = formatCommanderErrorForJson(context.message, context.commandName, context.allowedTypes, 2, context);
      expect(envelope.code).toBe("unknown_option");
      expect(envelope.examples).toContain(example);
      expect(envelope.examples?.some((entry) => entry.includes("synthetic-value --help"))).toBe(false);
    } finally {
      process.argv = previous;
    }
  });
});
