import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHistoryEntry } from "../../../../src/core/history/history.js";
import { resolveItemTypeRegistry } from "../../../../src/core/item/type-registry.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import { runHistoryMaintenance } from "../../../../src/sdk/history/maintenance.js";
import { resolveHistorySubject } from "../../../../src/sdk/history-redact.js";
import { runHistoryRedact } from "../../../../src/sdk/history-redact.js";
import {
  runHistoryRepair,
  runHistoryRepairAll,
} from "../../../../src/sdk/history-repair.js";
import {
  runHistoryCompact,
  runHistoryCompactBulk,
} from "../../../../src/sdk/history-compact.js";
import { createTaskFixture } from "../../../helpers/createTaskFixture.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("SDK history maintenance transaction", () => {
  it("refuses uninitialized workspaces before every single and bulk maintenance plan", async () => {
    await withTempPmPath(async (context) => {
      const root = path.join(context.tempRoot, "uninitialized");
      await mkdir(root);
      const global = { path: root, json: true };
      const id = "pm-uninitialized";
      const operations = [
        () => runHistoryRedact(id, { literal: ["private"] }, global),
        () => runHistoryRepair(id, {}, global),
        () => runHistoryRepairAll({}, global),
        () => runHistoryCompact(id, {}, global),
        () => runHistoryCompactBulk({ ids: [id] }, global),
      ];
      for (const operation of operations) {
        await expect(operation()).rejects.toMatchObject({
          code: "tracker_not_initialized",
        });
      }
    });
  });

  it("previews without writing, applies a verified transform, and refuses a concurrent stream change", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-maintenance-transaction";
      createTaskFixture(
        context,
        id,
        "Independent history transaction fixture",
      );
      const settings = await readSettings(context.pmPath);
      const typeRegistry = resolveItemTypeRegistry(settings, []);
      const subject = await resolveHistorySubject(
        context.pmPath,
        id,
        settings,
        typeRegistry.type_to_folder,
      );
      const original = await readFile(subject.historyPath, "utf8");
      const itemRaw = await readFile(
        path.join(context.pmPath, "tasks", `${id}.toon`),
        "utf8",
      );
      const base = {
        pmRoot: context.pmPath,
        subject,
        settings,
        typeRegistry,
        operation: "history-repair" as const,
      };
      for (const dryRun of [true, false]) {
        const result = await runHistoryMaintenance({
          ...base,
          options: { dryRun },
          transform: (snapshot) => ({
            changed: true,
            rewrittenEntries: [
              ...snapshot.entries,
              createHistoryEntry({
                nowIso: "2026-09-07T00:00:00.000Z",
                author: snapshot.author,
                op: "history_repair",
                before: snapshot.loadedItem!.document,
                after: snapshot.loadedItem!.document,
              }),
            ],
            report: (outcome) => outcome,
          }),
        });
        expect(result.verification.ok).toBe(true);
        const persisted = await readFile(subject.historyPath, "utf8");
        expect(persisted === original).toBe(dryRun);
        expect(
          await readFile(
            path.join(context.pmPath, "tasks", `${id}.toon`),
            "utf8",
          ),
        ).toBe(itemRaw);
      }
      const changed = await readFile(subject.historyPath, "utf8");
      await expect(
        runHistoryMaintenance({
          ...base,
          options: {},
          transform: async (snapshot) => {
            await writeFile(subject.historyPath, `${changed}\n`);
            return {
              changed: true,
              rewrittenEntries: snapshot.entries,
              report: (outcome) => outcome,
            };
          },
        }),
      ).rejects.toThrow(/changed while waiting for lock/);
      expect(await readFile(subject.historyPath, "utf8")).toBe(
        `${changed}\n`,
      );
    });
  });

  it("rejects an invalid planned chain before any custom writer executes, including dry runs", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-invalid-maintenance";
      createTaskFixture(context, id, "Refuse invalid history plans");
      const settings = await readSettings(context.pmPath);
      const typeRegistry = resolveItemTypeRegistry(settings, []);
      const subject = await resolveHistorySubject(
        context.pmPath,
        id,
        settings,
        typeRegistry.type_to_folder,
      );
      const original = await readFile(subject.historyPath, "utf8");
      for (const dryRun of [true, false]) {
        let writerRan = false;
        await expect(
          runHistoryMaintenance({
            pmRoot: context.pmPath,
            subject,
            settings,
            typeRegistry,
            operation: "history-redact",
            options: { dryRun },
            transform: (snapshot) => ({
              changed: true,
              rewrittenEntries: snapshot.entries.map((entry) => ({
                ...entry,
                after_hash: "invalid",
              })),
              applyRewrite: async () => {
                writerRan = true;
              },
              report: (outcome) => outcome,
            }),
          }),
        ).rejects.toThrow(/produced an invalid rewritten chain/);
        expect(writerRan).toBe(false);
        expect(await readFile(subject.historyPath, "utf8")).toBe(original);
      }
    });
  });
});
