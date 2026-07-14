import { copyFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  MAX_CHILD_PROJECTION_ITEMS,
  PmClient,
  buildItemChildrenRollup,
  buildItemSchedule,
  getItemAt,
  getHistoryPath,
  historyCompact as compactHistory,
  historyCompactBulk as compactHistoryBulk,
  historyRedact as redactHistory,
  historyRepair as repairHistory,
  historyRepairAll as repairAllHistory,
} from "../../../src/sdk/index.js";
import {
  applyHistoryPatch,
  extractPatchFailureContext,
  replayHistoryToTarget,
  resolveHistoryTarget,
} from "../../../src/core/history/projection.js";
import { resolveRuntimeStatusRegistry } from "../../../src/core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { readSettings } from "../../../src/core/store/settings.js";
import { parseRuntimeInteger } from "../../../src/sdk/runtime-input.js";
import type { ItemMetadata } from "../../../src/types/index.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../helpers/withTempPmPath.js";

function createSdkHistoryFixture(context: TempPmContext): string {
  const created = context.runCli(
    [
      "create",
      "--json",
      "--title",
      "SDK history primitive secret",
      "--description",
      "SDK history primitive fixture",
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--tags",
      "sdk,history",
      "--body",
      "secret body",
      "--deadline",
      "none",
      "--estimate",
      "10",
      "--acceptance-criteria",
      "SDK maintenance methods return typed results",
      "--author",
      "sdk-test",
      "--assignee",
      "none",
      "--dep",
      "none",
      "--file",
      "none",
      "--test",
      "none",
      "--doc",
      "none",
    ],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

function metadata(id: string, parent: string, status = "open"): ItemMetadata {
  return {
    id,
    title: `Child ${id}`,
    description: "Synthetic child",
    type: "CompanyUnit",
    status,
    priority: 2,
    tags: [],
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
    parent,
  };
}

describe("public SDK history and rich-read primitives", () => {
  it("uses the canonical usage exit code for invalid runtime integers", () => {
    expect(parseRuntimeInteger("7", "limit")).toBe(7);

    for (const value of [1.5, "1.5"]) {
      expect(() => parseRuntimeInteger(value, "limit")).toThrow(
        expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
      );
    }
  });

  it("exposes mutation-free time travel and typed maintenance methods", async () => {
    await withTempPmPath(async (context) => {
      const id = createSdkHistoryFixture(context);
      const reconstructed = await getItemAt(id, "1", {
        pmRoot: context.pmPath,
      });
      expect(reconstructed).toMatchObject({
        reconstructed: true,
        as_of_version: 1,
        document: { metadata: { id, title: "SDK history primitive secret" } },
      });

      const client = new PmClient({
        pmRoot: context.pmPath,
        author: "sdk-test",
      });
      const redaction = await client.historyRedact(id, {
        literal: ["secret"],
        dryRun: true,
      });
      expect(redaction).toMatchObject({ id, dry_run: true, changed: true });
      const repair = await client.historyRepair(id, { dryRun: true });
      expect(repair).toMatchObject({ id, dry_run: true });
      const compact = await client.historyCompact(id, { dryRun: true });
      expect(compact).toMatchObject({ id, dry_run: true });
      const bulk = await client.historyCompactBulk({
        ids: [id],
        minEntries: 0,
        dryRun: true,
      });
      expect(bulk).toMatchObject({
        bulk: true,
        dry_run: true,
        mode: "ids",
        totals: { selected: 1, items_errored: 0 },
      });
      const allRepair = await client.historyRepairAll({ dryRun: true });
      expect(allRepair).toMatchObject({ all: true, dry_run: true });

      expect(
        await redactHistory(id, { literal: ["secret"], dryRun: true }),
      ).toMatchObject({ id, dry_run: true });
      expect(await repairHistory(id)).toMatchObject({ id });
      expect(await repairAllHistory()).toMatchObject({ all: true });
      expect(await compactHistory(id)).toMatchObject({ id });
      expect(
        await compactHistoryBulk({
          ids: [id],
          minEntries: 999,
          dryRun: true,
        }),
      ).toMatchObject({ bulk: true, dry_run: true });
    });
  });

  it("reports missing, empty, and cross-item history corruption without mutation", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        getItemAt("pm-missing", "1", {
          pmRoot: `${context.tempRoot}/uninitialized`,
        }),
      ).rejects.toThrow(/Tracker is not initialized/);

      const firstId = createSdkHistoryFixture(context);
      await rm(getHistoryPath(context.pmPath, firstId));
      await expect(
        getItemAt(firstId, "1", { pmRoot: context.pmPath }),
      ).rejects.toThrow(/No history exists/);

      const secondId = createSdkHistoryFixture(context);
      await copyFile(
        getHistoryPath(context.pmPath, secondId),
        getHistoryPath(context.pmPath, firstId),
      );
      await expect(
        getItemAt(firstId, "1", { pmRoot: context.pmPath }),
      ).rejects.toThrow(`expected ${firstId}`);
    });
  });

  it("retains structured projection diagnostics for empty and invalid streams", () => {
    expect(() => resolveHistoryTarget("", [])).toThrow(PmCliError);
    expect(
      extractPatchFailureContext([], {
        index: 4,
        operation: { op: 42, path: 42 },
      }),
    ).toEqual({ patchIndex: 4 });
    expect(() => replayHistoryToTarget([], 0)).toThrow(
      /target entry 1 does not exist/,
    );
    expect(() =>
      applyHistoryPatch(
        { metadata: {}, body: "" },
        [{ op: "move", path: "/metadata/title", from: "/metadata/missing" }],
        1,
        "broken_move",
      ),
    ).toThrow(/from=\/metadata\/missing/);
  });

  it("builds type-agnostic bounded child samples with continuation metadata", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      const corpus = Array.from({ length: 23 }, (_, index) =>
        metadata(
          `custom-${String(22 - index).padStart(2, "0")}`,
          "custom-parent",
          index < 3 ? "closed" : "open",
        ),
      );
      const rollup = buildItemChildrenRollup(
        "CUSTOM-PARENT",
        corpus,
        resolveRuntimeStatusRegistry(settings.schema),
      );
      expect(rollup).toMatchObject({
        count: 23,
        active: 20,
        by_status: { closed: 3, open: 20 },
        sample_limit: 20,
        truncated: true,
        next_offset: 20,
        scanned: 23,
      });
      expect(rollup.sample).toHaveLength(20);
      expect(rollup.sample.map((row) => row.id)).toEqual(
        [...rollup.sample.map((row) => row.id)].sort((left, right) =>
          left.localeCompare(right),
        ),
      );
      expect(rollup.continuation).toContain(
        "--parent CUSTOM-PARENT --offset 20 --limit 20",
      );
      expect(() =>
        buildItemChildrenRollup(
          "custom-parent",
          corpus,
          resolveRuntimeStatusRegistry(settings.schema),
          -1,
        ),
      ).toThrow(PmCliError);
    });
  });

  it("enforces the one-million-row child projection safety bound", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      const repeated = metadata("custom-repeated", "other-parent");
      const oversized = {
        *[Symbol.iterator](): IterableIterator<ItemMetadata> {
          for (let index = 0; index <= MAX_CHILD_PROJECTION_ITEMS; index += 1) {
            yield repeated;
          }
        },
      };
      expect(() =>
        buildItemChildrenRollup(
          "custom-parent",
          oversized,
          resolveRuntimeStatusRegistry(settings.schema),
        ),
      ).toThrow(/1,000,000 item safety bound/);
    });
  });

  it("normalizes schedule aliases from the earliest event", () => {
    const scheduled = metadata("custom-scheduled", "custom-parent");
    scheduled.deadline = "2026-07-20T12:00:00.000Z";
    scheduled.events = [
      {
        start_at: "2026-07-20T10:00:00.000Z",
        title: "Later",
      },
      {
        start_at: "2026-07-20T09:00:00.000Z",
        end_at: "2026-07-20T09:30:00.000Z",
        location: "Room 7",
      },
    ];
    expect(buildItemSchedule(scheduled)).toMatchObject({
      deadline: "2026-07-20T12:00:00.000Z",
      start_at: "2026-07-20T09:00:00.000Z",
      end_at: "2026-07-20T09:30:00.000Z",
      location: "Room 7",
      events: [
        { start_at: "2026-07-20T09:00:00.000Z" },
        { start_at: "2026-07-20T10:00:00.000Z" },
      ],
    });
    expect(
      buildItemSchedule(metadata("custom-plain", "custom-parent")),
    ).toBeUndefined();
    const meeting = metadata("custom-meeting", "custom-parent");
    meeting.type = "Meeting";
    expect(buildItemSchedule(meeting)).toMatchObject({
      deadline: null,
      start_at: null,
      end_at: null,
      location: null,
      reminders: [],
      events: [],
    });
  });
});
