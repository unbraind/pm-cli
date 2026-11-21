/**
 * Every history-drift remedy pm health advises repairs the streams it names
 * (pm-3os5p6), and a stream with both a non-record line and a chain break
 * recovers through salvage followed by an append-only repair (pm-rpucvb).
 */
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readHistoryEntries } from "../../../src/core/history/read.js";
import { sealHistoryRecord } from "../../../src/core/history/history.js";
import { historyEntriesToRaw } from "../../../src/core/history/replay.js";
import { runHealth } from "../../../src/sdk/governance/health.js";
import { runHistoryRepair } from "../../../src/sdk/history-repair.js";
import { inspectHistoryTail } from "../../../src/sdk/history/salvage.js";
import type { HistoryEntry } from "../../../src/types/index.js";
import { createTaskFixture } from "../../helpers/createTaskFixture.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

function historyFile(context: TempPmContext, id: string): string {
  return path.join(context.pmPath, "history", `${id}.jsonl`);
}

function itemFile(context: TempPmContext, id: string): string {
  return path.join(context.pmPath, "tasks", `${id}.toon`);
}

function run(context: TempPmContext, args: string[]) {
  const result = context.runCli([...args, "--json"], { expectJson: true });
  expect(result.code, `${args.join(" ")}: ${result.stderr}${result.stdout}`).toBe(0);
  return result;
}

/** The history_drift check's remediation map, warnings and details. */
async function driftCheck(context: TempPmContext) {
  const health = await runHealth({ path: context.pmPath });
  const check = health.checks.find((candidate) => candidate.name === "history_drift")!;
  return {
    status: check.status,
    remedies: (check.details.remediation_map ?? {}) as Record<string, string>,
    warnings: health.warnings.filter((warning) => warning.startsWith("history_drift_")),
    details: check.details,
  };
}

/** Run an advised remedy for one item, substituting its id for the placeholder. */
function runRemedy(context: TempPmContext, remedy: string, id: string) {
  const args = remedy.replace(/^pm /u, "").replace("<id>", id).split(" ");
  return run(context, args);
}

/** Change a recorded field outside pm, then record a change that only applies on top of it. */
async function breakChainUnbridgeably(context: TempPmContext, id: string): Promise<void> {
  createTaskFixture(context, id, "Unbridgeable");
  const file = itemFile(context, id);
  await writeFile(file, (await readFile(file, "utf8")).replace(/^priority: 2$/mu, "priority: 2\nassignee: outside-owner"));
  run(context, ["update", id, "--assignee", "inside-owner", "--force"]);
}

/** Change the item outside pm, then record a comment after it: a break a bridge can repair. */
async function breakChainBridgeably(context: TempPmContext, id: string): Promise<void> {
  createTaskFixture(context, id, "Bridgeable");
  const file = itemFile(context, id);
  await writeFile(file, (await readFile(file, "utf8")).replace(/^title: .*$/mu, "title: Edited outside pm"));
  run(context, ["comments", id, "--add", "after the edit"]);
}

describe("history-drift remedies converge (pm-3os5p6)", () => {
  it("rebuilds a missing stream with the advised per-item remedy", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-reseed";
      createTaskFixture(context, id, "Missing stream");
      run(context, ["comments", id, "--add", "recorded before the loss"]);
      await rm(historyFile(context, id));
      const before = await driftCheck(context);
      expect(before.warnings).toEqual([`history_drift_missing_stream:${id}`]);
      expect(before.remedies).toEqual({ history_drift_missing_stream: "pm history-repair <id>" });
      const repaired = runRemedy(context, before.remedies.history_drift_missing_stream!, id);
      // The default missing-stream policy recreates the file empty on read, so health saw an empty stream.
      expect(repaired.json).toMatchObject({
        changed: true,
        reseed: { reason: "empty_stream", prior_versions: "unrecorded" },
        history: { audit_entry_added: true, verify_ok: true, item_hash_version_before: null },
      });
      expect((await driftCheck(context)).status).toBe("ok");
      const entries = await readHistoryEntries(historyFile(context, id), id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        op: "history_repair",
        event_class: "maintenance",
        context: { history_reseed: { contract_version: 1, reason: "empty_stream", prior_versions: "unrecorded" } },
      });
      expect(run(context, ["get", id, "--at", "1"]).json).toMatchObject({ item: { id, title: id } });
      // Later writes extend the rebuilt chain.
      run(context, ["comments", id, "--add", "recorded after the repair"]);
      run(context, ["history", id, "--verify", "--strict-exit"]);
    });
  });

  it("rebuilds an absent stream in both repair modes and keeps refusing streams it cannot anchor", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-reseed-absent";
      createTaskFixture(context, id, "Absent stream");
      await rm(historyFile(context, id));
      const preview = await runHistoryRepair(id, { appendOnly: true, dryRun: true }, { path: context.pmPath });
      expect(preview).toMatchObject({ changed: true, dry_run: true, reseed: { reason: "missing_stream" }, history: { audit_entry_added: false } });
      await expect(readFile(historyFile(context, id), "utf8")).rejects.toThrow();
      const appended = await runHistoryRepair(id, { appendOnly: true, message: "rebuilt" }, { path: context.pmPath });
      expect(appended).toMatchObject({ changed: true, reseed: { reason: "missing_stream" } });
      const entries = await readHistoryEntries(historyFile(context, id), id);
      expect(entries.map((entry) => [entry.op, entry.message])).toEqual([["history_repair", "rebuilt"]]);
      // A rebuilt stream is clean, so a second repair changes nothing.
      expect(await runHistoryRepair(id, {}, { path: context.pmPath })).toMatchObject({ changed: false });
      // Whitespace in an empty stream is kept: the baseline is appended after it.
      await writeFile(historyFile(context, id), "\n \n");
      await runHistoryRepair(id, {}, { path: context.pmPath });
      expect((await readFile(historyFile(context, id), "utf8")).startsWith("\n \n{")).toBe(true);
      await writeFile(historyFile(context, id), "  ");
      await runHistoryRepair(id, { appendOnly: true }, { path: context.pmPath });
      expect((await readFile(historyFile(context, id), "utf8")).startsWith("  \n{")).toBe(true);
      // Audited workflows prove evidence against recorded history and keep refusing an empty stream.
      await writeFile(historyFile(context, id), "");
      await expect(
        runHistoryRepair(id, { auditOperation: "merge_reconcile", forceAuditEntry: true }, { path: context.pmPath }),
      ).rejects.toThrow(/nothing to repair/u);
      // A deleted item has nothing to anchor a rebuilt stream on.
      await rm(itemFile(context, id));
      await expect(runHistoryRepair(id, {}, { path: context.pmPath })).rejects.toThrow(/nothing to repair/u);
    });
  });

  it("advises the bulk remedy that repairs every drifted stream", async () => {
    await withTempPmPath(async (context) => {
      for (const id of ["pm-bulk-a", "pm-bulk-b"]) {
        createTaskFixture(context, id, "Bulk missing");
        await rm(historyFile(context, id));
      }
      const missingOnly = await driftCheck(context);
      expect(missingOnly.remedies).toEqual({ history_drift_missing_stream: "pm history-repair --all --append-only" });
      run(context, ["history-repair", "--all", "--append-only"]);
      expect((await driftCheck(context)).status).toBe("ok");

      // A bridgeable break alongside a missing stream keeps the append-only bulk remedy.
      await breakChainBridgeably(context, "pm-bulk-bridge");
      await rm(historyFile(context, "pm-bulk-a"));
      expect((await driftCheck(context)).remedies).toEqual({
        history_drift_chain_mismatch: "pm history-repair --all --append-only",
        history_drift_missing_stream: "pm history-repair --all --append-only",
      });
      run(context, ["history-repair", "--all", "--append-only"]);
      expect((await driftCheck(context)).status).toBe("ok");

      // A break a bridge cannot repair switches the bulk remedy to the rewriting repair.
      await breakChainUnbridgeably(context, "pm-bulk-unbridgeable");
      await rm(historyFile(context, "pm-bulk-b"));
      const mixed = await driftCheck(context);
      expect(mixed.remedies).toEqual({
        history_drift_chain_unbridgeable: "pm history-repair --all",
        history_drift_missing_stream: "pm history-repair --all",
      });
      run(context, ["history-repair", "--all"]);
      expect((await driftCheck(context)).status).toBe("ok");
    });
  });

  it("tells a bridgeable break from one only the rewriting repair can fix", async () => {
    await withTempPmPath(async (context) => {
      await breakChainUnbridgeably(context, "pm-unbridgeable");
      const unbridgeable = await driftCheck(context);
      expect(unbridgeable.warnings).toEqual(["history_drift_chain_unbridgeable:pm-unbridgeable"]);
      expect(unbridgeable.details).toMatchObject({
        chain_mismatches: ["pm-unbridgeable"],
        chain_unbridgeable: [{ id: "pm-unbridgeable", reason: "patch_does_not_replay" }],
      });
      expect(unbridgeable.remedies).toEqual({ history_drift_chain_unbridgeable: "pm history-repair <id>" });
      // The append-only remedy health no longer advises would refuse.
      expect(context.runCli(["history-repair", "pm-unbridgeable", "--append-only", "--json"]).code).not.toBe(0);
      runRemedy(context, unbridgeable.remedies.history_drift_chain_unbridgeable!, "pm-unbridgeable");
      expect((await driftCheck(context)).status).toBe("ok");

      await breakChainBridgeably(context, "pm-bridgeable");
      const bridgeable = await driftCheck(context);
      expect(bridgeable.remedies).toEqual({ history_drift_chain_mismatch: "pm history-repair <id> --append-only" });
      expect(bridgeable.details).not.toHaveProperty("chain_unbridgeable");
      runRemedy(context, bridgeable.remedies.history_drift_chain_mismatch!, "pm-bridgeable");
      expect((await driftCheck(context)).status).toBe("ok");
    });
  });

  it("names no repair for a record that no longer matches its seal, and the repair refuses typed", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-sealed";
      createTaskFixture(context, id, "Sealed record");
      run(context, ["comments", id, "--add", "second record"]);
      const file = historyFile(context, id);
      const original = await readFile(file, "utf8");
      const lines = original.trimEnd().split("\n");
      lines[0] = JSON.stringify({ ...(JSON.parse(lines[0]!) as HistoryEntry), message: "edited without a reseal" });
      await writeFile(file, `${lines.join("\n")}\n`);
      // A second drifted stream would otherwise switch to a bulk remedy that fails this row.
      createTaskFixture(context, "pm-sealed-missing", "Missing beside it");
      await rm(historyFile(context, "pm-sealed-missing"));
      const drift = await driftCheck(context);
      expect(drift.warnings).toEqual([
        `history_drift_chain_unrepairable:${id}`,
        "history_drift_missing_stream:pm-sealed-missing",
      ]);
      expect(drift.details).toMatchObject({
        chain_unbridgeable: [{ id, reason: "chain_failure_not_a_break", rewrite_refusal: "record_hash_mismatch" }],
      });
      expect(drift.remedies).toEqual({
        history_drift_chain_unrepairable: "pm history <id> --verify --full",
        history_drift_missing_stream: "pm history-repair <id>",
      });
      runRemedy(context, drift.remedies.history_drift_chain_unrepairable!, id);
      runRemedy(context, drift.remedies.history_drift_missing_stream!, "pm-sealed-missing");
      const refused = context.runCli(["history-repair", id, "--json"]);
      expect(refused.code).toBe(4);
      expect(JSON.parse(refused.stdout || refused.stderr)).toMatchObject({
        code: "history_record_integrity_invalid",
        next_steps: [expect.stringContaining(`pm history ${id} --verify --full`)],
      });
      expect(await readFile(file, "utf8")).toBe(`${lines.join("\n")}\n`);
      // Restoring the stream, as from version control, clears the drift.
      await writeFile(file, original);
      expect((await driftCheck(context)).status).toBe("ok");
    });
  });

  it("advises salvage for an unreadable stream and keeps bulk forms off while one is present", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-unreadable";
      createTaskFixture(context, id, "Unreadable stream");
      await writeFile(historyFile(context, id), `${await readFile(historyFile(context, id), "utf8")}null\n`);
      createTaskFixture(context, "pm-unreadable-missing", "Missing beside it");
      await rm(historyFile(context, "pm-unreadable-missing"));
      const drift = await driftCheck(context);
      expect(drift.remedies).toEqual({
        history_drift_missing_stream: "pm history-repair <id>",
        history_drift_unreadable_stream: "pm history-repair <id> --salvage-tail --dry-run",
      });
      const preview = runRemedy(context, drift.remedies.history_drift_unreadable_stream!, id);
      expect(preview.json).toMatchObject({ dry_run: true, salvage: { non_record_lines: 1 } });
      run(context, ["history-repair", id, "--salvage-tail"]);
      runRemedy(context, drift.remedies.history_drift_missing_stream!, "pm-unreadable-missing");
      expect((await driftCheck(context)).status).toBe("ok");
    });
  });

  it("salvages a stream of only non-record lines to an empty stream, then rebuilds it", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-scalar-only";
      createTaskFixture(context, id, "Scalar-only stream");
      await writeFile(historyFile(context, id), "null\n7\n");
      const unreadable = await driftCheck(context);
      expect(unreadable.remedies).toEqual({
        history_drift_unreadable_stream: "pm history-repair <id> --salvage-tail --dry-run",
      });
      runRemedy(context, unreadable.remedies.history_drift_unreadable_stream!, id);
      await expect(runHistoryRepair(id, { salvageTail: true, dryRun: true }, { path: context.pmPath })).resolves.toMatchObject({
        warnings: [`history_stream_empty:${id}:run pm history-repair ${id}`],
      });
      const salvaged = run(context, ["history-repair", id, "--salvage-tail"]);
      expect(salvaged.json).toMatchObject({
        changed: true,
        salvage: { non_record_lines: 2, retained_entries: 0 },
        history: { audit_entry_added: false },
        warnings: [`history_stream_empty:${id}:run pm history-repair ${id}`],
      });
      expect(await readFile(historyFile(context, id), "utf8")).toBe("");
      const empty = await driftCheck(context);
      expect(empty.remedies).toEqual({ history_drift_missing_stream: "pm history-repair <id>" });
      runRemedy(context, empty.remedies.history_drift_missing_stream!, id);
      expect((await driftCheck(context)).status).toBe("ok");
      // A deleted item's stream has nothing to rebuild, so salvage names no follow-up.
      await writeFile(historyFile(context, id), "null\n");
      await rm(itemFile(context, id));
      await expect(runHistoryRepair(id, { salvageTail: true }, { path: context.pmPath })).resolves.toMatchObject({
        changed: true,
        warnings: [],
      });
    });
  });
});

describe("review hardening of the advised remedies", () => {
  it("reports a newer record seal format as version skew with the upgrade remedy only", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-seal-skew";
      createTaskFixture(context, id, "Seal skew");
      run(context, ["comments", id, "--add", "second"]);
      const file = historyFile(context, id);
      const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
      lines[1] = JSON.stringify({ ...(JSON.parse(lines[1]!) as HistoryEntry), record_hash_version: 2 });
      await writeFile(file, `${lines.join("\n")}\n`);
      const drift = await driftCheck(context);
      expect(drift.warnings).toEqual([`history_drift_version_skew:${id}`]);
      expect(drift.remedies).toEqual({ history_drift_version_skew: "npm install -g @unbrained/pm-cli@latest" });
      await expect(runHistoryRepair(id, { dryRun: true }, { path: context.pmPath })).rejects.toMatchObject({
        code: "history_record_version_unsupported",
      });
    });
  });

  it("refuses to salvage a stream that names another item before a delete cleared the id", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, "pm-other", "Other item");
      const otherItem = itemFile(context, "pm-other");
      await writeFile(otherItem, (await readFile(otherItem, "utf8")).replace(/^title: .*$/mu, "title: Edited outside pm"));
      run(context, ["delete", "pm-other", "--force"]);
      const foreign = await readFile(historyFile(context, "pm-other"), "utf8");
      createTaskFixture(context, "pm-subject", "Subject");
      await writeFile(historyFile(context, "pm-subject"), `${foreign}null\n`);
      await expect(runHistoryRepair("pm-subject", { salvageTail: true, dryRun: true }, { path: context.pmPath })).rejects.toThrow(
        /belongs to another item/u,
      );
    });
  });

  it("treats a malformed record seal as damage, not as a newer format", async () => {
    await withTempPmPath(async (context) => {
      for (const [id, change] of [
        ["pm-seal-string", { record_hash_version: "1" }],
        ["pm-seal-incomplete", { record_hash_version: 2, record_hash: undefined }],
      ] as const) {
        createTaskFixture(context, id, "Damaged seal");
        run(context, ["comments", id, "--add", "second"]);
        const file = historyFile(context, id);
        const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
        lines[1] = JSON.stringify({ ...(JSON.parse(lines[1]!) as HistoryEntry), ...change });
        await writeFile(file, `${lines.join("\n")}\n`);
      }
      const drift = await driftCheck(context);
      expect(drift.warnings).toEqual([
        "history_drift_chain_unrepairable:pm-seal-incomplete",
        "history_drift_chain_unrepairable:pm-seal-string",
      ]);
      await expect(runHistoryRepair("pm-seal-string", { dryRun: true }, { path: context.pmPath })).rejects.toMatchObject({
        code: "history_record_integrity_invalid",
      });
    });
  });

  it.skipIf(process.platform === "win32")("refuses a linked stream at planning, so a preview never offers an append the write refuses", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, "pm-link-target", "Link target");
      createTaskFixture(context, "pm-linked", "Linked stream");
      await writeFile(historyFile(context, "pm-link-target"), "");
      await rm(historyFile(context, "pm-linked"));
      await symlink(historyFile(context, "pm-link-target"), historyFile(context, "pm-linked"));
      for (const options of [{ dryRun: true }, { dryRun: true, appendOnly: true }]) {
        await expect(runHistoryRepair("pm-linked", options, { path: context.pmPath })).rejects.toMatchObject({
          context: expect.objectContaining({ reason: "stream_not_regular_file" }),
        });
      }
      expect(await readFile(historyFile(context, "pm-link-target"), "utf8")).toBe("");
    });
  });

  it("refuses to salvage another item's verified stream", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, "pm-verified-other", "Other item");
      run(context, ["comments", "pm-verified-other", "--add", "second"]);
      const foreign = await readFile(historyFile(context, "pm-verified-other"), "utf8");
      createTaskFixture(context, "pm-verified-subject", "Subject");
      await writeFile(historyFile(context, "pm-verified-subject"), `${foreign}null\n`);
      await expect(
        runHistoryRepair("pm-verified-subject", { salvageTail: true, dryRun: true }, { path: context.pmPath }),
      ).rejects.toThrow(/belongs to another item/u);
    });
  });

  it("names the restore, not an upgrade, for a malformed digest label", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-digest-null";
      createTaskFixture(context, id, "Malformed digest");
      const file = historyFile(context, id);
      const [line] = (await readFile(file, "utf8")).trimEnd().split("\n");
      await writeFile(file, `${JSON.stringify({ ...(JSON.parse(line!) as HistoryEntry), hash_algorithm: null })}\nnull\n`);
      await expect(runHistoryRepair(id, { salvageTail: true, dryRun: true }, { path: context.pmPath })).rejects.toMatchObject({
        code: "history_salvage_refused",
        context: { nextSteps: [expect.stringContaining("restore the stream")] },
      });
    });
  });

  it("refuses a salvage preview whose record could not be anchored, as the write would", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-digest";
      createTaskFixture(context, id, "Unknown digest");
      const file = historyFile(context, id);
      const [line] = (await readFile(file, "utf8")).trimEnd().split("\n");
      await writeFile(file, `${JSON.stringify({ ...(JSON.parse(line!) as HistoryEntry), hash_algorithm: "blake9" })}\nnull\n`);
      await expect(runHistoryRepair(id, { salvageTail: true, dryRun: true }, { path: context.pmPath })).rejects.toMatchObject({
        code: "history_salvage_refused",
        context: { nextSteps: [expect.stringContaining("npm install -g @unbrained/pm-cli@latest")] },
      });
    });
  });

  it("reports an explicit provenance normalization request on a rebuilt stream", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-reseed-normalize";
      createTaskFixture(context, id, "Normalize request");
      await writeFile(historyFile(context, id), "");
      await expect(runHistoryRepair(id, { normalizeProvenance: true }, { path: context.pmPath })).resolves.toMatchObject({
        reseed: { reason: "empty_stream" },
        provenance_normalization: { requested: true, changed: false, events_changed: 0 },
      });
    });
  });
});

describe("salvage of a stream that also has a chain break (pm-rpucvb)", () => {
  it("removes a scalar line without a verified chain, then the append-only repair bridges the break", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-double-fault";
      await breakChainBridgeably(context, id);
      const file = historyFile(context, id);
      const broken = await readFile(file, "utf8");
      await writeFile(file, `${broken}null\n`);
      const salvage = run(context, ["history-repair", id, "--salvage-tail"]);
      expect(salvage.json).toMatchObject({
        changed: true,
        salvage: { non_record_lines: 1, retained_entries: 2 },
        history: { verify_ok: false, verify_errors: [expect.stringContaining("before_hash_mismatch")] },
        warnings: [expect.stringContaining(`pm history-repair ${id} --append-only --dry-run, or pm history-repair ${id} --dry-run`)],
      });
      const salvaged = await readFile(file, "utf8");
      expect(salvaged.startsWith(broken)).toBe(true);
      const drift = await driftCheck(context);
      expect(drift.remedies).toEqual({ history_drift_chain_mismatch: "pm history-repair <id> --append-only" });
      run(context, ["history-repair", id, "--append-only"]);
      expect((await readFile(file, "utf8")).startsWith(salvaged)).toBe(true);
      expect((await driftCheck(context)).status).toBe("ok");
      run(context, ["history", id, "--verify", "--strict-exit"]);
    });
  });

  it("keeps the verified-prefix rule for an invalid suffix and keeps implicit streams implicit", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-double-suffix";
      await breakChainBridgeably(context, id);
      const broken = await readFile(historyFile(context, id), "utf8");
      // Discarding a suffix after a chain that does not verify still refuses.
      expect(() => inspectHistoryTail(`${broken}{"ts":`)).toThrow(/nonempty verified prefix/u);
      // With nothing to discard, salvage names the repair the chain needs.
      let refusal: unknown;
      try {
        inspectHistoryTail(broken);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({
        code: "history_salvage_refused",
        context: { nextSteps: [expect.stringContaining("--append-only --dry-run")] },
      });
      // A broken stream that declares no epoch keeps its audit record implicit.
      const implicit = historyEntriesToRaw(
        broken.trimEnd().split("\n").map((line) => {
          const { item_hash_version: _version, record_hash: _hash, ...rest } = JSON.parse(line) as HistoryEntry;
          return sealHistoryRecord(rest as HistoryEntry);
        }),
      );
      const selected = inspectHistoryTail(`${implicit}7\n`);
      expect(selected).toMatchObject({ itemHashVersion: undefined, verification: { ok: false } });
      await writeFile(historyFile(context, id), `${implicit}7\n`);
      const salvaged = await runHistoryRepair(id, { salvageTail: true }, { path: context.pmPath });
      expect(salvaged.history).toMatchObject({ item_hash_version_before: null, verify_ok: false });
      expect((await readHistoryEntries(historyFile(context, id), id)).at(-1)).not.toHaveProperty("item_hash_version");
    });
  });
});
