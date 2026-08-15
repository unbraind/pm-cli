import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listInvalidProvenanceHistoryStreamIds,
  normalizeInvalidHistoryProvenance,
} from "../../../src/sdk/governance/provenance-health.js";
import {
  runHistoryRepair,
  runHistoryRepairAll,
} from "../../../src/sdk/history-repair.js";
import { reanchorHistoryEntries } from "../../../src/core/history/replay.js";
import type { HistoryEntry } from "../../../src/types.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

function invalidEntry(): HistoryEntry {
  return {
    ts: "2026-08-15T00:00:00.000Z",
    author: "provenance-test",
    agent_harness: "claude-code",
    agent_provenance: {
      role: { source: "environment", value: "1" },
      model: { source: "environment", value: "bounded-model" },
    },
    op: "test",
    patch: [],
    before_hash: "a",
    after_hash: "a",
  };
}

describe("history provenance normalization", () => {
  it("removes only invalid observations and never returns their values", () => {
    const normalized = normalizeInvalidHistoryProvenance([invalidEntry()]);
    expect(normalized.entries[0].agent_provenance).toEqual({
      model: { source: "environment", value: "bounded-model" },
    });
    expect(normalized.receipt).toEqual({
      changed: true,
      events_changed: 1,
      observations_removed: 1,
      invalid_values: [
        {
          harness: "claude-code",
          dimension: "role",
          kind: "single_digit",
          count: 1,
        },
      ],
    });
    expect(JSON.stringify(normalized.receipt)).not.toContain('"value"');
  });

  it("preserves clean and malformed non-observation shapes", () => {
    const base = invalidEntry();
    const withoutProvenance = { ...base };
    delete withoutProvenance.agent_provenance;
    const clean = {
      ...base,
      agent_provenance: {
        role: null,
        model: { source: "environment" as const, value: "bounded-model" },
      },
    };
    const normalized = normalizeInvalidHistoryProvenance([
      withoutProvenance,
      clean,
    ]);
    expect(normalized.entries).toEqual([withoutProvenance, clean]);
    expect(normalized.receipt).toMatchObject({
      changed: false,
      events_changed: 0,
      observations_removed: 0,
    });
  });

  it("deletes an all-invalid provenance map and sorts aggregate classes", () => {
    const first = invalidEntry();
    const second = {
      ...invalidEntry(),
      agent_provenance: {
        effort: { source: "environment" as const, value: true as unknown as string },
      },
    };
    const third = {
      ...invalidEntry(),
      agent_provenance: {
        role: { source: "environment" as const, value: false as unknown as string },
      },
    };
    const fourth = {
      ...invalidEntry(),
      agent_harness: undefined,
      agent_provenance: {
        effort: { source: "environment" as const, value: "1" },
      },
    };
    const normalized = normalizeInvalidHistoryProvenance([
      { ...first, agent_provenance: { role: first.agent_provenance?.role ?? null } },
      second,
      third,
      fourth,
    ]);
    expect(normalized.entries[0].agent_provenance).toBeUndefined();
    expect(normalized.entries[1].agent_provenance).toBeUndefined();
    expect(normalized.entries[2].agent_provenance).toBeUndefined();
    expect(normalized.entries[3].agent_provenance).toBeUndefined();
    expect(normalized.receipt.invalid_values).toEqual([
      {
        harness: "claude-code",
        dimension: "effort",
        kind: "boolean",
        count: 1,
      },
      {
        harness: "claude-code",
        dimension: "role",
        kind: "boolean",
        count: 1,
      },
      {
        harness: "claude-code",
        dimension: "role",
        kind: "single_digit",
        count: 1,
      },
      {
        harness: "unknown",
        dimension: "effort",
        kind: "single_digit",
        count: 1,
      },
    ]);
  });

  it("discovers and repairs invalid streams through the public CLI", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--title",
          "Normalize provenance",
          "--description",
          "Temporary acceptance fixture",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "provenance",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "Invalid provenance is removed",
          "--author",
          "provenance-test",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const entries = (await readFile(historyPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as HistoryEntry);
      entries[0] = {
        ...entries[0],
        agent_harness: "claude-code",
        agent_provenance: {
          model: { source: "environment", value: "bounded-model" },
        },
      };
      await writeFile(
        historyPath,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );
      await expect(
        listInvalidProvenanceHistoryStreamIds(context.pmPath),
      ).resolves.toEqual([]);
      entries[0] = {
        ...entries[0],
        agent_harness: "claude-code",
        agent_provenance: {
          role: { source: "environment", value: "1" },
        },
      };
      await writeFile(
        historyPath,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );

      await expect(
        listInvalidProvenanceHistoryStreamIds(context.pmPath),
      ).resolves.toEqual([id]);
      const repaired = context.runCli(
        ["history-repair", id, "--normalize-provenance", "--json"],
        { expectJson: true },
      );
      expect(repaired.code).toBe(0);
      expect(repaired.json).toMatchObject({
        changed: true,
        provenance_normalization: {
          requested: true,
          changed: true,
          events_changed: 1,
          observations_removed: 1,
        },
      });
      const repairedRaw = await readFile(historyPath, "utf8");
      const repairedEntries = repairedRaw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as HistoryEntry);
      for (const entry of repairedEntries) {
        expect(entry.agent_provenance?.role).toBeUndefined();
        expect(
          Object.values(entry.agent_provenance ?? {}).some(
            (observation) => observation.value === "1",
          ),
        ).toBe(false);
      }
      expect(context.runCli(["history", id, "--verify", "--json"]).code).toBe(
        0,
      );
    });
  });

  it("normalizes legacy epoch streams and bulk candidates through the SDK", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--title",
          "Normalize legacy SDK provenance",
          "--description",
          "Temporary SDK acceptance fixture",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "provenance",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "Legacy normalization converges",
          "--test",
          `command=node -e "console.log('z')",scope=project`,
          "--test",
          `command=node -e "console.log('a')",scope=project`,
          "--author",
          "provenance-test",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const currentEntries = (await readFile(historyPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as HistoryEntry)
        .map((entry) => {
          const legacy = { ...entry };
          delete legacy.item_hash_version;
          return legacy;
        });
      const legacyEntries = reanchorHistoryEntries(currentEntries, 1).entries;
      legacyEntries[0] = {
        ...legacyEntries[0],
        agent_harness: "claude-code",
        agent_provenance: {
          role: { source: "environment", value: "1" },
        },
      };
      await writeFile(
        historyPath,
        `${legacyEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );

      const provenanceOnlyBulk = await runHistoryRepairAll(
        { normalizeProvenance: true, dryRun: true },
        { path: context.pmPath },
      );
      expect(provenanceOnlyBulk).toMatchObject({
        drifted_streams: 0,
        provenance_invalid_streams: 1,
        streams: [{ id, outcome: "repaired" }],
      });

      const repaired = await runHistoryRepair(
        id,
        {
          normalizeProvenance: true,
          auditContext: { source: "sdk-acceptance" },
        },
        { path: context.pmPath },
      );
      expect(repaired).toMatchObject({
        changed: true,
        history: {
          item_hash_version_after: 1,
          version_disposition: "preserved",
        },
        provenance_normalization: {
          requested: true,
          observations_removed: 1,
        },
      });

      const bulk = await runHistoryRepairAll(
        { normalizeProvenance: true, dryRun: true },
        { path: context.pmPath },
      );
      expect(bulk.provenance_invalid_streams).toBe(0);
      expect(bulk.totals.failed).toBe(0);
    });
  });
});
