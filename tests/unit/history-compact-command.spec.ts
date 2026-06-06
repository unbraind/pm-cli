import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHistory } from "../../src/cli/commands/history.js";
import { runHistoryCompact } from "../../src/cli/commands/history-compact.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createItem(context: TempPmContext, title: string): string {
  const result = context.runCli(
    ["create", "--json", "--title", title, "--description", "history compact target", "--type", "Task"],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

function getHistoryPath(context: TempPmContext, id: string): string {
  return path.join(context.pmPath, "history", `${id}.jsonl`);
}

async function tamperSecondBeforeHash(file: string): Promise<void> {
  const lines = (await readFile(file, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
  second.before_hash = "0".repeat(64);
  lines[1] = JSON.stringify(second);
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
}

describe("history-compact command", () => {
  it("compacts the full stream to baseline + audit marker by default", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Full");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      expect(context.runCli(["append", id, "--body", "more history"]).code).toBe(0);

      const before = await runHistory(id, { verify: true }, { path: context.pmPath });
      expect(before.verification?.ok).toBe(true);
      expect(before.count).toBeGreaterThanOrEqual(3);

      const compacted = await runHistoryCompact(
        id,
        { author: "test-author", message: "Compact full stream for test" },
        { path: context.pmPath },
      );
      expect(compacted.changed).toBe(true);
      expect(compacted.compact_boundary.entries_compacted).toBe(before.count);
      expect(compacted.compact_boundary.entries_retained).toBe(0);
      expect(compacted.history.entries_after).toBe(2);
      expect(compacted.history.baseline_entry_added).toBe(true);
      expect(compacted.history.audit_entry_added).toBe(true);
      expect(compacted.history.verify_ok).toBe(true);

      const verified = await runHistory(id, { verify: true }, { path: context.pmPath });
      expect(verified.verification?.ok).toBe(true);
      const historyRaw = await readFile(getHistoryPath(context, id), "utf8");
      expect(historyRaw).toContain('"op":"history_compact_baseline"');
      expect(historyRaw).toContain('"op":"history_compact"');

      const restore = context.runCli(["restore", id, "1", "--json"], { expectJson: true });
      expect(restore.code).toBe(0);
    });
  });

  it("compacts only entries before a version boundary and keeps newer tail entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Prefix");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      expect(context.runCli(["append", id, "--body", "tail entry"]).code).toBe(0);

      const compacted = await runHistoryCompact(
        id,
        { before: "3", author: "test-author", message: "Compact first two entries" },
        { path: context.pmPath },
      );
      expect(compacted.changed).toBe(true);
      expect(compacted.compact_boundary.kind).toBe("version");
      expect(compacted.compact_boundary.entries_compacted).toBe(2);
      expect(compacted.compact_boundary.entries_retained).toBe(1);
      expect(compacted.compact_boundary.first_retained_entry).toBe(3);
      expect(compacted.history.entries_after).toBe(3);

      const after = await runHistory(id, { full: true, verify: true }, { path: context.pmPath });
      expect(after.verification?.ok).toBe(true);
      expect(after.history[0]?.op).toBe("history_compact_baseline");
      expect(after.history.some((entry) => entry.op === "append")).toBe(true);
      expect(after.history[after.history.length - 1]?.op).toBe("history_compact");
    });
  });

  it("supports dry-run compaction previews without rewriting history", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Dry Run");
      expect(context.runCli(["update", id, "--priority", "1"]).code).toBe(0);
      const historyFile = getHistoryPath(context, id);
      const beforeRaw = await readFile(historyFile, "utf8");

      const dryRun = await runHistoryCompact(
        id,
        { dryRun: true, author: "test-author" },
        { path: context.pmPath },
      );
      expect(dryRun.changed).toBe(true);
      expect(dryRun.dry_run).toBe(true);
      expect(dryRun.history.baseline_entry_added).toBe(true);
      expect(dryRun.history.audit_entry_added).toBe(false);
      expect(await readFile(historyFile, "utf8")).toBe(beforeRaw);
    });
  });

  it("returns no-op when --before points at the first version", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Noop");
      const historyFile = getHistoryPath(context, id);
      const beforeRaw = await readFile(historyFile, "utf8");

      const result = await runHistoryCompact(
        id,
        { before: "1", author: "test-author" },
        { path: context.pmPath },
      );
      expect(result.changed).toBe(false);
      expect(result.compact_boundary.entries_compacted).toBe(0);
      expect(result.history.baseline_entry_added).toBe(false);
      expect(result.history.audit_entry_added).toBe(false);
      expect(result.warnings).toContain("history_compact_noop_before_boundary");
      expect(await readFile(historyFile, "utf8")).toBe(beforeRaw);
    });
  });

  it("fails when the existing history chain is already invalid", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Invalid Chain");
      expect(context.runCli(["update", id, "--priority", "2"]).code).toBe(0);
      await tamperSecondBeforeHash(getHistoryPath(context, id));

      await expect(runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("history-repair"),
      });
    });
  });
});
