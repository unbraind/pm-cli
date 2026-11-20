import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHealth } from "../../../../src/sdk/governance/health.js";
import { renderContextMarkdown, runContext } from "../../../../src/sdk/query/context.js";
import { quoteCommandArg, renderPmCommand } from "../../../../src/core/shared/command-line.js";
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
      // Remedies stay on the tracker the diagnosis read (an explicit --pm-path here).
      const sweep = (...args: string[]): string =>
        renderPmCommand(["list", "--status", "in_progress", "--pm-path", context.pmPath, ...args]);

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
            unowned: { count: 1, items: [{ id: unowned }], sweep: sweep("--assignee-filter", "unassigned") },
            idle: { count: 3, sweep: sweep("--updated-before", "-48h") },
            item_remedies: { return_to_open: `pm update <id> --status open --pm-path ${quoteCommandArg(context.pmPath)}` },
          },
          remediation_map: {
            stale_in_progress_items: sweep("--assignee-filter", "unassigned", "--updated-before", "-48h"),
            in_progress_unowned: sweep("--assignee-filter", "unassigned"),
            in_progress_idle: sweep("--updated-before", "-48h"),
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
            remediation: sweep("--updated-before", "-48h"),
          }),
        ]),
      );

      const orient = await runContext({}, global);
      expect(orient.summary).toMatchObject({ in_progress: 3, in_progress_unowned: 1, in_progress_idle: 3 });
      expect(renderContextMarkdown(orient)).toContain("(in_progress: 3, in_progress_unowned: 1, in_progress_idle: 3, open: 0)");
    });
  });

  it("counts a custom progress status as one population for in_progress and both advisories, whatever its role (GH-1756)", async () => {
    await withTempPmPath(async (context) => {
      const schema = path.join(context.pmPath, "schema");
      const writeProgressRoles = async (roles: string[]): Promise<void> => {
        const statusesPath = path.join(schema, "statuses.json");
        const document = JSON.parse(await readFile(statusesPath, "utf8")) as {
          statuses: Array<{ id: string; roles?: string[]; aliases?: string[] }>;
        };
        document.statuses = document.statuses.map((status) =>
          status.id === "in_progress" || status.id === "doing" ? { id: "doing", roles } : status,
        );
        await writeFile(statusesPath, `${JSON.stringify(document, null, 2)}\n`);
      };
      await writeProgressRoles(["blocked"]);
      const workflowsPath = path.join(schema, "workflows.json");
      const workflows = JSON.parse(await readFile(workflowsPath, "utf8")) as { workflow: Record<string, string> };
      workflows.workflow.in_progress_status = "doing";
      await writeFile(workflowsPath, `${JSON.stringify(workflows, null, 2)}\n`);
      for (const title of ["First", "Second"]) {
        expect(context.runCli(["create", "Task", title, "--status", "doing", "--json", "--author", "test-author"]).code).toBe(0);
      }
      expect(context.runCli(["create", "Task", "Queued", "--json", "--author", "test-author"]).code).toBe(0);
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 96 * HOUR) });
      const global = { path: context.pmPath };

      const blockedRole = await runContext({}, global);
      expect(blockedRole.summary).toMatchObject({
        active_items: 1,
        open: 1,
        in_progress: 2,
        in_progress_unowned: 2,
        in_progress_idle: 2,
      });

      await writeProgressRoles(["active"]);
      const activeRole = await runContext({}, global);
      expect(activeRole.summary).toMatchObject({
        active_items: 3,
        open: 1,
        in_progress: 2,
        in_progress_unowned: 2,
        in_progress_idle: 2,
      });
      // The workflow may name the progress status by an alias; every count resolves it like item statuses.
      const statusesPath = path.join(schema, "statuses.json");
      const statuses = JSON.parse(await readFile(statusesPath, "utf8")) as { statuses: Array<{ id: string; aliases?: string[] }> };
      statuses.statuses = statuses.statuses.map((status) => (status.id === "doing" ? { ...status, aliases: ["wip"] } : status));
      await writeFile(statusesPath, `${JSON.stringify(statuses, null, 2)}\n`);
      workflows.workflow.in_progress_status = "wip";
      await writeFile(workflowsPath, `${JSON.stringify(workflows, null, 2)}\n`);
      const aliased = await runContext({}, global);
      expect(aliased.summary).toMatchObject({ active_items: 3, open: 1, in_progress: 2, in_progress_unowned: 2, in_progress_idle: 2 });
      for (const summary of [blockedRole.summary, activeRole.summary, aliased.summary]) {
        expect(summary.in_progress_unowned ?? 0).toBeLessThanOrEqual(summary.in_progress);
        expect(summary.in_progress_idle ?? 0).toBeLessThanOrEqual(summary.in_progress);
      }
      // A progress status outside the active role renders apart from active_items, not as a part of it.
      expect(renderContextMarkdown(blockedRole)).toContain(
        "- active_items: 1 (open: 1)\n- in_progress: 2 (outside active_items, in_progress_unowned: 2, in_progress_idle: 2)",
      );
      expect(renderContextMarkdown(activeRole)).toContain(
        "- active_items: 3 (in_progress: 2, in_progress_unowned: 2, in_progress_idle: 2, open: 1)",
      );
    });
  });

  it("omits the context counts when every in-progress item is held and active", async () => {
    await withTempPmPath(async (context) => {
      createInProgress(context, "Held", "agent-a");
      const orient = await runContext({}, { path: context.pmPath });
      expect(orient.summary).toMatchObject({ in_progress: 1 });
      expect(orient.summary).not.toHaveProperty("in_progress_unowned");
      expect(orient.summary).not.toHaveProperty("in_progress_idle");
      expect(renderContextMarkdown(orient)).toContain("(in_progress: 1, open: 0)");
    });
  });
});
