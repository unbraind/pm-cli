import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createItem(context: TempPmContext, title: string): string {
  const result = context.runCli(
    ["create", "--json", "--title", title, "--description", "drift target", "--type", "Task"],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

function historyPath(context: TempPmContext, id: string): string {
  return path.join(context.pmPath, "history", `${id}.jsonl`);
}

function itemPath(context: TempPmContext, id: string): string {
  return path.join(context.pmPath, "tasks", `${id}.toon`);
}

async function tamperChain(file: string): Promise<void> {
  const lines = (await readFile(file, "utf8")).split(/\n/).filter(Boolean);
  const entry = JSON.parse(lines[1]);
  entry.before_hash = "0".repeat(64);
  lines[1] = JSON.stringify(entry);
  await writeFile(file, `${lines.join("\n")}\n`);
}

describe("history-repair command", () => {
  it("re-anchors a drifted chain and reconciles with the on-disk item", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair me");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      expect(context.runCli(["update", id, "--priority", "1"]).code).toBe(0);

      // Inject chain drift (tampered hash) and item drift (hand-edit the toon file).
      await tamperChain(historyPath(context, id));
      const item = itemPath(context, id);
      await writeFile(item, (await readFile(item, "utf8")).replace("drift target", "drift HANDEDITED"));

      const driftBefore = context.runCli(["validate", "--check-history-drift", "--json"], { expectJson: true });
      const driftCheck = (driftBefore.json as { checks: { name: string; details: { drifted_items_count: number } }[] }).checks.find(
        (c) => c.name === "history_drift",
      );
      expect(driftCheck?.details.drifted_items_count).toBe(1);

      // Dry-run reports impact but does not write.
      const dry = context.runCli(["history-repair", id, "--dry-run", "--json"], { expectJson: true });
      expect(dry.code).toBe(0);
      const dryResult = dry.json as { changed: boolean; history: { chain_drift_before: boolean; reconciled_with_item: boolean } };
      expect(dryResult.changed).toBe(true);
      expect(dryResult.history.chain_drift_before).toBe(true);
      expect(dryResult.history.reconciled_with_item).toBe(true);
      const stillDrifted = context.runCli(["history", id, "--verify", "--json"], { expectJson: true });
      expect((stillDrifted.json as { verification: { ok: boolean } }).verification.ok).toBe(false);

      // Real repair clears all drift.
      const repaired = context.runCli(["history-repair", id, "--message", "spec repair", "--json"], { expectJson: true });
      expect(repaired.code).toBe(0);
      const repairResult = repaired.json as {
        changed: boolean;
        history: { reconciled_with_item: boolean; entries_rehashed: number; audit_entry_added: boolean; verify_ok: boolean };
      };
      expect(repairResult.changed).toBe(true);
      expect(repairResult.history.audit_entry_added).toBe(true);
      expect(repairResult.history.verify_ok).toBe(true);

      const verified = context.runCli(["history", id, "--verify", "--json"], { expectJson: true });
      expect((verified.json as { verification: { ok: boolean } }).verification.ok).toBe(true);

      const driftAfter = context.runCli(["validate", "--check-history-drift", "--json"], { expectJson: true });
      const driftAfterCheck = (driftAfter.json as { checks: { name: string; details: { drifted_items_count: number } }[] }).checks.find(
        (c) => c.name === "history_drift",
      );
      expect(driftAfterCheck?.details.drifted_items_count).toBe(0);

      // The on-disk item is never modified; repair reconciles history to it.
      expect(await readFile(item, "utf8")).toContain("HANDEDITED");

      // Re-running on a clean stream is a no-op.
      const again = context.runCli(["history-repair", id, "--json"], { expectJson: true });
      const againResult = again.json as { changed: boolean; warnings: string[] };
      expect(againResult.changed).toBe(false);
      expect(againResult.warnings).toContain("history_repair_no_changes");
    });
  });

  it("errors when the item has no history stream", async () => {
    await withTempPmPath(async (context) => {
      const missing = context.runCli(["history-repair", "pm-zzzz", "--json"]);
      expect(missing.code).not.toBe(0);
      expect(missing.stdout + missing.stderr).toContain("not found");
    });
  });
});
