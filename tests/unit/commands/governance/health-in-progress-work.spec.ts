import { afterEach, describe, expect, it, vi } from "vitest";
import { runHealth } from "../../../../src/sdk/governance/health.js";
import { runContext } from "../../../../src/sdk/query/context.js";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { withTempPmPath, type TempPmContext } from "../../../helpers/withTempPmPath.js";

const HOUR = 3_600_000;

function createInProgress(context: TempPmContext, title: string, assignee?: string): string {
  const created = context.runCli(
    [
      "create",
      "Task",
      title,
      "--status",
      "in_progress",
      ...(assignee === undefined ? [] : ["--assignee", assignee]),
      "--json",
      "--author",
      "test-author",
    ],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

describe("unowned and idle in-progress work (GH-1724)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports both advisories with the workspace's own sweeps in health and counts them in context", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.mutation_guard.stale_in_progress_hours = 48;
      await writeSettings(context.pmPath, settings);
      const unowned = createInProgress(context, "Nobody holds this");
      const owned = createInProgress(context, "Held but idle", "agent-a");
      createInProgress(context, "Held by another agent", "agent-b");
      const global = { path: context.pmPath };

      const fresh = await runHealth(global, { skipIntegrity: true, skipDrift: true, skipVectors: true });
      expect(fresh.warnings).toContain("in_progress_unowned:1");
      expect(fresh.warnings.some((warning) => warning.startsWith("in_progress_idle:"))).toBe(false);
      expect(fresh.ok).toBe(true);

      // Fifty hours later the unowned item is also stale, and the held one is idle.
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 50 * HOUR) });
      const health = await runHealth(global, { skipIntegrity: true, skipDrift: true, skipVectors: true });
      expect(health.ok).toBe(true);
      expect(health.warnings).toEqual(
        expect.arrayContaining(["stale_in_progress_items:1", "in_progress_unowned:1", "in_progress_idle:3"]),
      );
      const storage = health.checks.find((check) => check.name === "storage");
      expect(storage).toMatchObject({
        status: "warn",
        details: {
          in_progress_work: {
            threshold_hours: 48,
            unowned: { count: 1, items: [{ id: unowned }], sweep: "pm list --status in_progress --assignee-filter unassigned" },
            idle: { count: 3, sweep: "pm list --status in_progress --updated-before -48h" },
            item_remedies: { return_to_open: "pm update <id> --status open" },
          },
          remediation_map: {
            stale_in_progress_items: "pm list --status in_progress --assignee-filter unassigned --updated-before -48h",
            in_progress_unowned: "pm list --status in_progress --assignee-filter unassigned",
            in_progress_idle: "pm list --status in_progress --updated-before -48h",
          },
        },
      });
      expect(
        (storage?.details.in_progress_work as { idle: { items: Array<{ id: string; assignee?: string }> } }).idle.items,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ id: owned, assignee: "agent-a" })]));
      expect(health.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "in_progress_idle",
            severity: "advisory",
            remediation: "pm list --status in_progress --updated-before -48h",
          }),
        ]),
      );

      const orient = await runContext({}, global);
      expect(orient.summary).toMatchObject({ in_progress: 3, in_progress_unowned: 1, in_progress_idle: 3 });
    });
  });

  it("omits the context counts when every in-progress item is held and active", async () => {
    await withTempPmPath(async (context) => {
      createInProgress(context, "Held", "agent-a");
      const orient = await runContext({}, { path: context.pmPath });
      expect(orient.summary).toMatchObject({ in_progress: 1 });
      expect(orient.summary).not.toHaveProperty("in_progress_unowned");
      expect(orient.summary).not.toHaveProperty("in_progress_idle");
    });
  });
});
