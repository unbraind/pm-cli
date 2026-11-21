/**
 * Append-only history repair (GH-1715, pm-gh1715) and typed refusal of
 * non-record history lines (pm-jbplbq).
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readHistoryEntries } from "../../../src/core/history/read.js";
import { sealHistoryRecord } from "../../../src/core/history/history.js";
import {
  historyEntriesToRaw,
  reanchorHistoryEntries,
  verifyHistoryChainWithVersion,
} from "../../../src/core/history/replay.js";
import { runHistoryRepair, runHistoryRepairAll } from "../../../src/sdk/history-repair.js";
import { runHistoryRedact } from "../../../src/sdk/history-redact.js";
import { runHistoryCompact } from "../../../src/sdk/history-compact.js";
import { runHealth } from "../../../src/sdk/governance/health.js";
import { inspectHistoryTail } from "../../../src/sdk/history/salvage.js";
import { replayHistoryToTarget } from "../../../src/core/history/projection.js";
import { mergeHistoryStreams } from "../../../src/sdk/merge/three-way.js";
import { runRestore } from "../../../src/sdk/lifecycle/restore.js";
import type { HistoryEntry } from "../../../src/types/index.js";
import { createTaskFixture } from "../../helpers/createTaskFixture.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

const ID = "pm-bridge";

function paths(context: TempPmContext) {
  return {
    history: path.join(context.pmPath, "history", `${ID}.jsonl`),
    item: path.join(context.pmPath, "tasks", `${ID}.toon`),
  };
}

function comment(context: TempPmContext, text: string): void {
  const result = context.runCli(["comments", ID, "--add", text, "--json"], {
    expectJson: true,
  });
  expect(result.code, result.stderr).toBe(0);
}

/** Change the item outside pm, the way a hand edit or a bypassing merge does. */
async function editOutsidePm(context: TempPmContext, title: string): Promise<void> {
  const file = paths(context).item;
  const raw = await readFile(file, "utf8");
  await writeFile(file, raw.replace(/^title: .*$/mu, `title: ${title}`));
}

/** Build the GH-1715 reproduction: one recorded change, one unrecorded edit, two more recorded changes. */
async function breakChain(context: TempPmContext, edits = 1): Promise<string> {
  createTaskFixture(context, ID, "Bridge reproduction");
  comment(context, "first");
  for (let edit = 0; edit < edits; edit += 1) {
    await editOutsidePm(context, `Edited outside pm ${edit}`);
    comment(context, `after edit ${edit}`);
  }
  comment(context, "last");
  return readFile(paths(context).history, "utf8");
}

/** Turn one entry into an unsealed legacy record with a change, as an attacker without a key could. */
function stripSeal(entry: HistoryEntry, change: Partial<HistoryEntry>): HistoryEntry {
  const { record_hash: _hash, record_hash_version: _version, ...rest } = { ...entry, ...change };
  return rest as HistoryEntry;
}

/** Reseal one entry after a deliberate change so only the targeted rule can refuse it. */
function reseal(entry: HistoryEntry, change: Partial<HistoryEntry>): HistoryEntry {
  const { record_hash: _hash, ...rest } = { ...entry, ...change };
  return sealHistoryRecord(rest as HistoryEntry);
}

describe("append-only history repair (GH-1715)", () => {
  it("bridges the reproduction, keeps every prior byte and verifies", async () => {
    await withTempPmPath(async (context) => {
      const before = await breakChain(context);
      expect(context.runCli(["health", "--strict-exit", "--json"]).code).not.toBe(0);
      const preview = await runHistoryRepair(ID, { appendOnly: true, dryRun: true }, { path: context.pmPath });
      expect(preview).toMatchObject({
        changed: true,
        dry_run: true,
        bridge: { version: 1, first_break_entry: 3, breaks: [expect.any(Object)] },
        history: { chain_drift_before: true, entries_rehashed: 0, reconciled_with_item: true },
        // The reconciliation overwrites the recorded title, so the preview names that loss.
        reconciliation: { reverted_fields: ["title"], discarded_events: [expect.objectContaining({ op: "create" })] },
      });
      expect(preview.warnings).toContain("history_repair_reconcile_discards_events:1");
      expect(await readFile(paths(context).history, "utf8")).toBe(before);

      const cli = context.runCli(["history-repair", ID, "--append-only", "--json"], { expectJson: true });
      expect(cli.code, cli.stderr).toBe(0);
      const repaired = await readFile(paths(context).history, "utf8");
      expect(repaired.startsWith(before)).toBe(true);
      expect(repaired.slice(before.length).trim().split("\n")).toHaveLength(1);
      const entries = await readHistoryEntries(paths(context).history, ID);
      expect(verifyHistoryChainWithVersion(entries)).toMatchObject({
        ok: true,
        bridged_segments: [{ start: 2, end: entries.length - 1 }],
      });
      expect(entries.at(-1)).toMatchObject({ op: "history_repair", event_class: "maintenance" });
      expect(context.runCli(["health", "--strict-exit", "--json"]).code).toBe(0);

      // A verified bridge is a fixed point for both repair modes.
      for (const options of [{}, { appendOnly: true }]) {
        expect(await runHistoryRepair(ID, options, { path: context.pmPath })).toMatchObject({ changed: false });
      }
      expect(await readFile(paths(context).history, "utf8")).toBe(repaired);

      // Versions inside the bridged segment lack the unrecorded change, so restore refuses them;
      // versions before the break and the bridged head stay reconstructable.
      await expect(runRestore(ID, "3", {}, { path: context.pmPath })).rejects.toMatchObject({
        context: { code: "history_version_unreconstructable" },
      });
      await expect(runRestore(ID, "2", { dryRun: true } as never, { path: context.pmPath })).resolves.toBeDefined();

      // New writes after the bridge verify normally.
      comment(context, "after bridge");
      expect(context.runCli(["health", "--strict-exit", "--json"]).code).toBe(0);
    });
  });

  it("names every break in the segment and refuses forged or partial bridges", async () => {
    await withTempPmPath(async (context) => {
      await breakChain(context, 2);
      const result = await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath });
      expect(result.bridge?.breaks).toHaveLength(2);
      const entries = await readHistoryEntries(paths(context).history, ID);
      expect(verifyHistoryChainWithVersion(entries).ok).toBe(true);
      const bridge = entries.at(-1)!;
      const [first, second] = bridge.bridge!.breaks;
      const withBridge = (change: Partial<HistoryEntry>) => [...entries.slice(0, -1), reseal(bridge, change)];
      const cases: Array<[HistoryEntry[], string]> = [
        [withBridge({ bridge: { ...bridge.bridge!, breaks: [first!] } }), "bridge_unnamed_break"],
        [withBridge({ bridge: { ...bridge.bridge!, breaks: [first!, second!, second!] } }), "bridge_names_absent_break"],
        [withBridge({ bridge: { ...bridge.bridge!, breaks: [{ ...first!, gap_from: "0".repeat(64) }, second!] } }), "before_hash_mismatch"],
        [withBridge({ after_hash: "f".repeat(64) }), "bridge_after_hash_mismatch"],
        [withBridge({ before_hash: "e".repeat(64) }), "bridge_link_mismatch"],
        [withBridge({ bridge: { ...bridge.bridge!, version: 2 } as never }), "bridge_invalid"],
        [withBridge({ bridge: { ...bridge.bridge!, breaks: [] } }), "bridge_invalid"],
        [withBridge({ bridge: { ...bridge.bridge!, breaks: [{ ...first!, extra: 1 } as never] } }), "bridge_invalid"],
        [withBridge({ bridge: { ...bridge.bridge!, breaks: [{ ...first!, gap_to: first!.gap_from }] } }), "bridge_invalid"],
        [withBridge({ bridge: { version: 1, breaks: [first!, second!] } as never }), "bridge_invalid"],
        [withBridge({ bridge: { ...bridge.bridge!, segment_digest: "0".repeat(64) } }), "bridge_segment_mismatch"],
        // A record whose seal was stripped and whose text changed is still caught by the segment digest.
        [[...entries.slice(0, 4), stripSeal(entries[4]!, { message: "rewritten without a seal" }), ...entries.slice(5)], "bridge_segment_mismatch"],
        // Inside a bridge only recorded links are checked, so every covered record must be complete.
        [[...entries.slice(0, 4), stripSeal(entries[4]!, { patch: undefined as never }), ...entries.slice(5)], "record_incomplete"],
        // A covered record's anchors must be well-formed digests of its algorithm.
        [[...entries.slice(0, 4), stripSeal(entries[4]!, { after_hash: "zz" }), ...entries.slice(5)], "record_incomplete"],
        [[...entries.slice(0, 4), stripSeal(entries[4]!, { hash_algorithm: "md5" }), ...entries.slice(5)], "record_incomplete"],
        // The closing record keeps the epoch the stream declared.
        [withBridge({ item_hash_version: 1 }), "bridge_epoch_mismatch"],
        // The bridge record itself must be complete too.
        [withBridge({ patch: undefined as never }), "record_incomplete"],
        // An incomplete break entry never opens a bridged segment.
        [[...entries.slice(0, 2), stripSeal(entries[2]!, { patch: undefined as never }), ...entries.slice(3)], "before_hash_mismatch"],
        // Stripping a named break's seal changes the record hash the bridge names.
        [[...entries.slice(0, 3), stripSeal(entries[3]!, {}), ...entries.slice(4)], "bridge_unnamed_break"],
        [withBridge({ op: "update" }), "bridge_invalid"],
        [[...entries.slice(0, -1), { ...bridge, record_hash: undefined, record_hash_version: undefined } as HistoryEntry], "bridge_invalid"],
        [[...entries, reseal(bridge, { ts: "2099-01-01T00:00:00.000Z" })], "bridge_without_break"],
        [[...entries.slice(0, 3), { ...entries[3]!, message: "tampered inside the segment" }, ...entries.slice(4)], "record_hash_mismatch"],
      ];
      for (const [stream, error] of cases) {
        const verdict = verifyHistoryChainWithVersion(stream);
        expect(verdict.ok, error).toBe(false);
        expect(verdict.errors.join(","), error).toContain(`verify_failed:${error}:`);
      }
    });
  });

  it("checks recorded effects again wherever replay realigns inside a bridged segment", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, ID, "Realign");
      comment(context, "first");
      await editOutsidePm(context, "Edited outside pm");
      // Recording a new title realigns replay with the recorded state.
      const update = context.runCli(["update", ID, "--title", "Recorded title", "--json"], { expectJson: true });
      expect(update.code, update.stderr).toBe(0);
      comment(context, "last");
      const file = paths(context).history;
      const entries = await readHistoryEntries(file, ID);
      const tampered = [...entries.slice(0, -1), reseal(entries.at(-1)!, { patch: [{ op: "replace", path: "/metadata/priority", value: 0 }] })];
      await writeFile(file, historyEntriesToRaw(tampered));
      await expect(runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath })).rejects.toMatchObject({
        context: { code: "history_append_only_repair_unavailable", reason: "bridge_does_not_verify" },
      });
      await writeFile(file, historyEntriesToRaw(entries));
      await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath });
      const bridged = await readHistoryEntries(file, ID);
      expect(verifyHistoryChainWithVersion(bridged).ok).toBe(true);
      const forged = [...bridged.slice(0, -2), reseal(bridged.at(-2)!, { patch: [{ op: "replace", path: "/metadata/priority", value: 0 }] }), bridged.at(-1)!];
      expect(verifyHistoryChainWithVersion(forged).errors.join(",")).toContain("verify_failed:after_hash_mismatch:");
    });
  });

  it("refuses breaks an append-only bridge cannot carry and names the rewriting fallback", async () => {
    await withTempPmPath(async (context) => {
      await breakChain(context);
      const file = paths(context).history;
      const entries = await readHistoryEntries(file, ID);
      const refuse = async (options: Record<string, unknown>, reason: string) =>
        expect(runHistoryRepair(ID, { appendOnly: true, ...options }, { path: context.pmPath })).rejects.toMatchObject({
          context: { code: "history_append_only_repair_unavailable", reason },
        });

      // A broken record envelope is not a chain break.
      const tampered = [...entries];
      tampered[1] = { ...tampered[1]!, message: "tampered" };
      await writeFile(file, historyEntriesToRaw(tampered));
      await refuse({}, "chain_failure_not_a_break");

      // A later patch that needs the unrecorded change cannot replay without it.
      await writeFile(file, historyEntriesToRaw(entries));
      const replaceMissing = [...entries];
      replaceMissing[3] = reseal(replaceMissing[3]!, {
        patch: [...replaceMissing[3]!.patch, { op: "replace", path: "/metadata/never_recorded", value: 1 }],
      });
      await writeFile(file, historyEntriesToRaw(replaceMissing));
      await refuse({}, "patch_does_not_replay");

      await writeFile(file, historyEntriesToRaw(entries));
      for (const option of [{ normalizeProvenance: true }, { forceAuditEntry: true }, { salvageTail: true }]) {
        await expect(runHistoryRepair(ID, { appendOnly: true, ...option }, { path: context.pmPath })).rejects.toThrow(
          /cannot be combined with other repair modes/,
        );
      }

      // Several failures at once (a duplicate create plus a break) are not one nameable break.
      await writeFile(file, historyEntriesToRaw([entries[0]!, ...entries]));
      await refuse({}, "chain_failure_not_a_break");

      // A break at the very first entry has no recorded anchor before it.
      await writeFile(file, historyEntriesToRaw([reseal(entries[0]!, { before_hash: "9".repeat(64) }), ...entries.slice(1)]));
      await refuse({}, "chain_failure_not_a_break");

      await writeFile(file, historyEntriesToRaw(entries));
      // A break entry without a patch array loses its effect, so later records no longer replay.
      await writeFile(file, historyEntriesToRaw([...entries.slice(0, 2), stripSeal(entries[2]!, { patch: undefined as never }), ...entries.slice(3)]));
      await refuse({}, "patch_does_not_replay");

      await writeFile(file, historyEntriesToRaw(entries));
      // Without the on-disk item there is nothing to anchor the bridge on.
      await rm(paths(context).item);
      await refuse({}, "item_missing");
    });
  });

  it("refuses a patch that only replays with the unrecorded change", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, ID, "Replay dependency");
      const raw = await readFile(paths(context).item, "utf8");
      await writeFile(paths(context).item, raw.replace(/^title: .*$/mu, "$&\ndeadline: 2031-01-01T00:00:00.000Z"));
      const update = context.runCli(["update", ID, "--deadline", "2032-01-01T00:00:00.000Z", "--json"], { expectJson: true });
      expect(update.code, update.stderr).toBe(0);
      await expect(runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath })).rejects.toMatchObject({
        context: { code: "history_append_only_repair_unavailable", reason: "patch_does_not_replay" },
      });
    });
  });

  it("refuses to rewrite bytes it cannot keep exactly", async () => {
    await withTempPmPath(async (context) => {
      await breakChain(context);
      const file = paths(context).history;
      const lines = (await readFile(file)).toString("utf8").trimEnd().split("\n");
      const legacy = JSON.parse(lines[0]!) as Record<string, unknown>;
      delete legacy.record_hash;
      delete legacy.record_hash_version;
      const bytes = Buffer.concat([
        Buffer.from(`${JSON.stringify({ ...legacy, message: "@" }).replace('"@"', '"\u0001"')}\n`.replace("\u0001", "~")),
        Buffer.from(`${lines.slice(1).join("\n")}\n`),
      ]);
      const marker = bytes.indexOf("~");
      bytes[marker] = 0xff;
      await writeFile(file, bytes);
      for (const dryRun of [true, false]) {
        await expect(runHistoryRepair(ID, { appendOnly: true, dryRun }, { path: context.pmPath })).rejects.toMatchObject({
          context: { code: "history_append_only_repair_unavailable", reason: "stream_not_utf8" },
        });
      }
      expect(await readFile(file)).toEqual(bytes);
    });
  });

  it("bridges an unversioned legacy stream and a stream without a final newline", async () => {
    await withTempPmPath(async (context) => {
      await breakChain(context);
      const file = paths(context).history;
      const legacy = (await readHistoryEntries(file, ID)).map((entry) => reseal(entry, { item_hash_version: undefined }));
      const raw = historyEntriesToRaw(legacy).trimEnd();
      await writeFile(file, raw);
      const result = await runHistoryRepair(ID, { appendOnly: true, message: "legacy bridge" }, { path: context.pmPath });
      expect(result).toMatchObject({ changed: true, bridge: { breaks: [expect.any(Object)] } });
      const repaired = await readFile(file, "utf8");
      expect(repaired.startsWith(`${raw}\n`)).toBe(true);
      const entries = await readHistoryEntries(file, ID);
      expect(entries.at(-1)).toMatchObject({ message: "legacy bridge" });
      expect(entries.at(-1)).not.toHaveProperty("item_hash_version");
      expect(verifyHistoryChainWithVersion(entries).ok).toBe(true);
    });
  });

  it("leaves a clean stream of a deleted item untouched", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, ID, "Deleted item");
      comment(context, "only");
      const before = await readFile(paths(context).history, "utf8");
      await rm(paths(context).item);
      expect(await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath })).toMatchObject({
        changed: false,
        item: { exists: false, path: null, matched_chain_before: null },
      });
      expect(await readFile(paths(context).history, "utf8")).toBe(before);
      // Normalization that finds nothing to remove leaves the stream alone as well.
      expect(await runHistoryRepair(ID, { normalizeProvenance: true }, { path: context.pmPath })).toMatchObject({
        changed: false,
        provenance_normalization: { changed: false },
      });
    });
  });

  it("reconciles a verified stream with an appended record and repairs every stream with --all", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, ID, "End drift only");
      await editOutsidePm(context, "Edited at the end");
      const before = await readFile(paths(context).history, "utf8");
      const result = await runHistoryRepairAll({ appendOnly: true }, { path: context.pmPath });
      expect(result.totals).toMatchObject({ repaired: 1, failed: 0 });
      const after = await readFile(paths(context).history, "utf8");
      expect(after.startsWith(before)).toBe(true);
      const entries = await readHistoryEntries(paths(context).history, ID);
      expect(entries.at(-1)).not.toHaveProperty("bridge");
      expect(verifyHistoryChainWithVersion(entries).ok).toBe(true);
      expect(await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath })).toMatchObject({
        changed: false,
        item: { matched_chain_before: true },
      });
    });
  });

  it("merges two clones that bridged the same break and dissolves bridges a union must rebase", async () => {
    await withTempPmPath(async (context) => {
      const base = await breakChain(context);
      await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath });
      const ours = await readFile(paths(context).history, "utf8");
      await writeFile(paths(context).history, base);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runHistoryRepair(ID, { appendOnly: true, message: "second clone" }, { path: context.pmPath });
      const theirs = await readFile(paths(context).history, "utf8");
      expect(theirs).not.toBe(ours);

      const merged = mergeHistoryStreams(base, ours, theirs);
      expect(merged).toMatchObject({ strategy: "equivalent_bridges", reanchored: false, entries_total: 6 });
      expect(merged.merged.startsWith(ours)).toBe(true);
      const mergedEntries = merged.merged.trimEnd().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      expect(verifyHistoryChainWithVersion(mergedEntries).ok).toBe(true);
      expect(mergedEntries.at(-1)).toMatchObject({ patch: [], message: "second clone" });
      expect(mergedEntries.at(-1)?.reanchor_evidence?.at(-1)?.record?.bridge).toBeDefined();

      // A marker the other clone already carries on a shared record survives the equivalent-bridge merge.
      const theirsEntries = theirs.trimEnd().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      const theirsMarked = historyEntriesToRaw(
        theirsEntries.map((entry, index) => (index === 1 ? reseal(entry, { replay_inexact: true }) : entry)),
      );
      const markedMerge = mergeHistoryStreams(base, ours, theirsMarked);
      expect(markedMerge.strategy).toBe("equivalent_bridges");
      const markedEntries = markedMerge.merged.trimEnd().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      expect(markedEntries[1]).toMatchObject({ replay_inexact: true });
      expect(verifyHistoryChainWithVersion(markedEntries).ok).toBe(true);

      // The merge appends to ours' exact bytes, even with CRLF line endings.
      const oursCrlf = ours.replace(/\n/gu, "\r\n");
      expect(mergeHistoryStreams(base, oursCrlf, theirs).merged.startsWith(oursCrlf)).toBe(true);
      expect(mergeHistoryStreams(base, ours.trimEnd(), theirs).merged.startsWith(`${ours.trimEnd()}\n{`)).toBe(true);
      // An invalid side is never reported as an equivalent-bridge merge.
      const oursLines = ours.trimEnd().split("\n");
      const tamperedBridge = { ...(JSON.parse(oursLines.at(-1)!) as HistoryEntry), message: "tampered" };
      const tamperedOurs = `${[...oursLines.slice(0, -1), JSON.stringify(tamperedBridge)].join("\n")}\n`;
      let tamperedStrategy: string | undefined;
      try {
        tamperedStrategy = mergeHistoryStreams(base, tamperedOurs, theirs).strategy;
      } catch {
        tamperedStrategy = "refused";
      }
      expect(tamperedStrategy).not.toBe("equivalent_bridges");

      // Bridges with different reconciliations are different repairs and take the union path.
      await writeFile(paths(context).history, base);
      await editOutsidePm(context, "A different on-disk title");
      await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath });
      const divergent = await readFile(paths(context).history, "utf8");
      expect(() => mergeHistoryStreams(base, ours, divergent)).not.toThrow();
      const union = mergeHistoryStreams(base, ours, divergent);
      expect(union.strategy).toBe("union_reanchor");
      const unionEntries = union.merged.trimEnd().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      expect(verifyHistoryChainWithVersion(unionEntries).ok).toBe(true);
      // The dissolved segment keeps refusing to present its versions as historical.
      const inexact = unionEntries.findIndex((entry) => entry.replay_inexact === true);
      expect(inexact).toBe(2);
      expect(() => replayHistoryToTarget(unionEntries, inexact)).toThrow(/cannot be reconstructed/);
      expect(() => replayHistoryToTarget(unionEntries, 1)).not.toThrow();

      // A union rebases every suffix patch, so it dissolves the bridge into an ordinary record.
      const projected = reanchorHistoryEntries(
        ours.trimEnd().split("\n").map((line) => JSON.parse(line) as HistoryEntry),
        undefined,
        { projectPatch: (entry) => entry.patch },
      );
      expect(projected.entries.some((entry) => Object.hasOwn(entry, "bridge"))).toBe(false);
      // A projected rewrite leaves marking to its caller: the merge driver marks each branch's covered records first.
      expect(projected.entries.some((entry) => entry.replay_inexact === true)).toBe(false);
      expect(projected.entries.at(-1)?.reanchor_evidence?.at(-1)?.record?.bridge).toBeDefined();
      expect(verifyHistoryChainWithVersion(projected.entries).ok).toBe(true);

      // A rewrite before the segment also dissolves it rather than keeping stale break hashes.
      const oursEntries = ours.trimEnd().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      const unversioned = [reseal(oursEntries[0]!, { item_hash_version: undefined }), ...oursEntries.slice(1)];
      const dissolved = reanchorHistoryEntries(unversioned);
      expect(dissolved.entries.some((entry) => Object.hasOwn(entry, "bridge"))).toBe(false);
      expect(verifyHistoryChainWithVersion(dissolved.entries).ok).toBe(true);
    });
  });
});

describe("redaction of a bridged stream (GH-1715)", () => {
  it("dissolves the bridge, keeps the segment unreconstructable and verifies", async () => {
    await withTempPmPath(async (context) => {
      await breakChain(context);
      await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath });
      const result = await runHistoryRedact(ID, { literal: "first" }, { path: context.pmPath });
      expect(result).toMatchObject({ changed: true });
      const entries = await readHistoryEntries(paths(context).history, ID);
      expect(verifyHistoryChainWithVersion(entries).ok).toBe(true);
      expect(entries.some((entry) => Object.hasOwn(entry, "bridge"))).toBe(false);
      expect(entries.map((entry) => entry.replay_inexact === true).slice(0, 5)).toEqual([false, false, true, true, false]);
      await expect(runRestore(ID, "3", {}, { path: context.pmPath })).rejects.toMatchObject({
        context: { code: "history_version_unreconstructable" },
      });
      expect(JSON.stringify(entries)).not.toContain('"text":"first"');
      expect(context.runCli(["health", "--strict-exit", "--json"]).code).toBe(0);
    });
  });
});

describe("rewrites that dissolve a bridge keep its versions unreconstructable (GH-1715)", () => {
  it("marks a branch's bridged records when a union interleaves the other branch before them", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, ID, "Union interleave");
      comment(context, "shared");
      const { history, item } = paths(context);
      const [baseHistory, baseItem] = [await readFile(history, "utf8"), await readFile(item, "utf8")];
      await new Promise((resolve) => setTimeout(resolve, 5));
      comment(context, "theirs");
      const theirs = await readFile(history, "utf8");
      await writeFile(history, baseHistory);
      await writeFile(item, baseItem);
      await editOutsidePm(context, "Edited on ours");
      comment(context, "ours after edit");
      comment(context, "ours last");
      await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath });
      const ours = await readFile(history, "utf8");
      const merged = mergeHistoryStreams(baseHistory, ours, theirs);
      expect(merged.strategy).toBe("union_reanchor");
      const entries = merged.merged.trimEnd().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      expect(verifyHistoryChainWithVersion(entries).ok).toBe(true);
      const covered = entries.flatMap((entry, index) => (entry.replay_inexact === true ? [index] : []));
      expect(covered.map((index) => entries[index]!.op)).toEqual(["comment_add", "comment_add"]);
      for (const index of covered) {
        expect(() => replayHistoryToTarget(entries, index)).toThrow(/cannot be reconstructed/);
      }
    });
  });

  it("marks a bridge's segment when a rewrite repairs a record before it", async () => {
    await withTempPmPath(async (context) => {
      await breakChain(context);
      await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath });
      const file = paths(context).history;
      const entries = await readHistoryEntries(file, ID);
      // A bad anchor on the first record stops verification before it reaches the bridge.
      const tampered = [reseal(entries[0]!, { before_hash: "7".repeat(64) }), ...entries.slice(1)];
      await writeFile(file, historyEntriesToRaw(tampered));
      expect(verifyHistoryChainWithVersion(tampered).bridged_segments).toBeUndefined();
      await runHistoryRepair(ID, {}, { path: context.pmPath });
      const repaired = await readHistoryEntries(file, ID);
      expect(verifyHistoryChainWithVersion(repaired).ok).toBe(true);
      expect(repaired.map((entry) => entry.replay_inexact === true).slice(0, 5)).toEqual([false, false, true, true, false]);
      await expect(runRestore(ID, "3", {}, { path: context.pmPath })).rejects.toMatchObject({
        context: { code: "history_version_unreconstructable" },
      });
    });
  });

  it("marks everything since the previous bridge when a rewrite meets a bridge it cannot locate", async () => {
    await withTempPmPath(async (context) => {
      await breakChain(context);
      await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath });
      const file = paths(context).history;
      const entries = await readHistoryEntries(file, ID);
      const bridge = entries.at(-1)!;
      const forged = reseal(bridge, { bridge: { ...bridge.bridge!, breaks: [{ ...bridge.bridge!.breaks[0]!, gap_from: "0".repeat(64) }] } });
      await writeFile(file, historyEntriesToRaw([...entries.slice(0, -1), forged]));
      await runHistoryRepair(ID, {}, { path: context.pmPath });
      const repaired = await readHistoryEntries(file, ID);
      expect(verifyHistoryChainWithVersion(repaired).ok).toBe(true);
      expect(repaired.map((entry) => entry.replay_inexact === true).slice(0, 5)).toEqual([false, true, true, true, false]);
      await expect(runRestore(ID, "1", { dryRun: true } as never, { path: context.pmPath })).resolves.toBeDefined();
    });
  });

  it("refuses to redact a stream whose bridge does not locate its segment", async () => {
    await withTempPmPath(async (context) => {
      await breakChain(context);
      await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath });
      const file = paths(context).history;
      const entries = await readHistoryEntries(file, ID);
      const bridge = entries.at(-1)!;
      for (const forged of [
        reseal(bridge, { bridge: { ...bridge.bridge!, breaks: [{ ...bridge.bridge!.breaks[0]!, gap_from: "0".repeat(64) }] } }),
        reseal(bridge, { bridge: { ...bridge.bridge!, version: 999 } as never }),
      ]) {
        await writeFile(file, historyEntriesToRaw([...entries.slice(0, -1), forged]));
        await expect(runHistoryRedact(ID, { literal: "first" }, { path: context.pmPath })).rejects.toMatchObject({
          context: { code: "history_redact_bridge_unlocated" },
        });
      }
    });
  });

  it("never counts differing bridges as one shared record and keeps the append-only bulk remedy", async () => {
    await withTempPmPath(async (context) => {
      const base = await breakChain(context);
      await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath });
      const ours = await readFile(paths(context).history, "utf8");
      const lines = ours.trimEnd().split("\n");
      const valid = JSON.parse(lines.at(-1)!) as HistoryEntry;
      const forged = reseal(valid, { bridge: { ...valid.bridge!, version: 999 } as never });
      const forgedOurs = `${[...lines.slice(0, -1), JSON.stringify(forged)].join("\n")}\n`;
      let strategy: string | undefined;
      try {
        strategy = mergeHistoryStreams(base, forgedOurs, ours).strategy;
      } catch {
        strategy = "refused";
      }
      expect(strategy).not.toBe("identical");
      // A record one branch already marked inexact keeps the marker, even when the merge keeps the other copy.
      const baseEntries = base.trimEnd().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      const markedTheirs = historyEntriesToRaw(
        baseEntries.map((entry, index) => (index === 2 ? reseal(entry, { replay_inexact: true }) : entry)),
      );
      const identical = mergeHistoryStreams(base, base, markedTheirs);
      expect(identical.strategy).toBe("identical");
      const identicalEntries = identical.merged.trimEnd().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      expect(identicalEntries[2]).toMatchObject({ replay_inexact: true });
      // A second drifted stream switches health to bulk remedies; the chain mismatch stays append-only.
      await writeFile(paths(context).history, base);
      createTaskFixture(context, "pm-bridge-two", "Second stream");
      await rm(path.join(context.pmPath, "history", "pm-bridge-two.jsonl"));
      const health = await runHealth({ path: context.pmPath });
      const drift = health.checks.find((check) => check.name === "history_drift")?.details as
        | { remediation_map?: Record<string, string> }
        | undefined;
      expect(drift?.remediation_map).toMatchObject({
        history_drift_chain_mismatch: "pm history-repair --all --append-only",
        history_drift_missing_stream: "pm history-repair --all",
      });
    });
  });

  it("keeps covered versions unreconstructable through provenance normalization and compaction", async () => {
    await withTempPmPath(async (context) => {
      await breakChain(context);
      const file = paths(context).history;
      const entries = await readHistoryEntries(file, ID);
      // An invalid provenance observation inside the segment, recorded before the bridge.
      entries[3] = reseal(entries[3]!, { agent_provenance: { role: { value: "true", source: "argv" } } });
      await writeFile(file, historyEntriesToRaw(entries));
      await runHistoryRepair(ID, { appendOnly: true }, { path: context.pmPath });
      await expect(runRestore(ID, "3", {}, { path: context.pmPath })).rejects.toMatchObject({
        context: { code: "history_version_unreconstructable" },
      });
      const normalized = await runHistoryRepair(ID, { normalizeProvenance: true }, { path: context.pmPath });
      expect(normalized.provenance_normalization).toMatchObject({ changed: true });
      const rewritten = await readHistoryEntries(file, ID);
      expect(verifyHistoryChainWithVersion(rewritten).ok).toBe(true);
      expect(rewritten.map((entry) => entry.replay_inexact === true).slice(0, 5)).toEqual([false, false, true, true, false]);
      // The removed observation survives nowhere, not even in the marker's rewrite evidence.
      expect(await readFile(file, "utf8")).not.toContain('{"value":"true","source":"argv"}');
      for (const version of ["3", "4"]) {
        await expect(runRestore(ID, version, {}, { path: context.pmPath })).rejects.toMatchObject({
          context: { code: "history_version_unreconstructable" },
        });
      }
      // A checkpoint taken at an inexact version inherits the refusal.
      await runHistoryCompact(ID, { before: "4" }, { path: context.pmPath });
      const compacted = await readHistoryEntries(file, ID);
      expect(compacted[0]).toMatchObject({ op: "history_compact_baseline", replay_inexact: true });
      await expect(runRestore(ID, "3", {}, { path: context.pmPath })).rejects.toMatchObject({
        context: { code: "history_version_unreconstructable" },
      });
    });
  });
});

describe("non-record history lines (pm-jbplbq)", () => {
  it.each([
    ["null", "a JSON null"],
    ["42", "a JSON number"],
    ["true", "a JSON boolean"],
    ['"text"', "a JSON string"],
    ["[1]", "a JSON array"],
  ])("refuses %s with a typed error naming the item and the line", async (line, defect) => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, ID, "Non-record line");
      const file = paths(context).history;
      await writeFile(file, `${await readFile(file, "utf8")}${line}\n`);
      await expect(readHistoryEntries(file, ID)).rejects.toMatchObject({
        context: { code: "history_record_invalid", item_id: ID, reason: defect, details: { line: 2 } },
      });
      for (const args of [["activity", "--limit", "3"], ["context", "--for", "orient"], ["history", ID]]) {
        const result = context.runCli([...args, "--json"]);
        expect(result.code, args.join(" ")).toBe(1);
        expect(`${result.stdout}${result.stderr}`).toContain("history_record_invalid");
        expect(`${result.stdout}${result.stderr}`).not.toContain("unknown_error");
      }
    });
  });

  it("judges BOM-prefixed lines the way the shared reader does", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, ID, "BOM lines");
      const original = await readFile(paths(context).history, "utf8");
      expect(inspectHistoryTail(`\uFEFFnull\n${original}`)).toMatchObject({ prefix: original, receipt: { non_record_lines: 1 } });
      expect(inspectHistoryTail(`\uFEFF${original}null\n`)).toMatchObject({ prefix: `\uFEFF${original}`, receipt: { non_record_lines: 1 } });
    });
  });

  it("recovers a scalar line with the advised salvage, even after later writes", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, ID, "Salvage recovery");
      const file = paths(context).history;
      await writeFile(file, `${await readFile(file, "utf8")}null\n`);
      comment(context, "written after the null line");
      const advised = context.runCli(["history", ID, "--json"]);
      expect(`${advised.stdout}${advised.stderr}`).toContain(`pm history-repair ${ID} --salvage-tail --dry-run`);
      const salvage = context.runCli(["history-repair", ID, "--salvage-tail", "--json"], { expectJson: true });
      expect(salvage.code, salvage.stderr).toBe(0);
      expect(salvage.json).toMatchObject({ salvage: { non_record_lines: 1, first_invalid_line: 2, retained_entries: 2 } });
      expect(context.runCli(["activity", "--limit", "3", "--json"]).code).toBe(0);
      expect(context.runCli(["health", "--strict-exit", "--json"]).code).toBe(0);
    });
  });
});
