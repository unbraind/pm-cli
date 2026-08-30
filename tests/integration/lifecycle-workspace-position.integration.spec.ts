import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("lifecycle roles and workspace position", () => {
  it("requires roles and reconciles active custom statuses across next, context, and list aliases", async () => {
    await withTempPmPath(async (context) => {
      const refused = await context.runCliInProcess([
        "schema",
        "add-status",
        "review",
        "--json",
      ]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("requires at least one lifecycle role");

      const registered = await context.runCliInProcess(
        ["schema", "add-status", "review", "--role", "active", "--json"],
        { expectJson: true },
      );
      expect(registered.code).toBe(0);

      const created = await context.runCliInProcess(
        [
          "create",
          "Review custom lifecycle",
          "--type",
          "Task",
          "--status",
          "review",
          "--description",
          "Exercise role-derived reads",
          "--json",
        ],
        { expectJson: true },
      );
      const id = (created.json as { item: { id: string } }).item.id;

      const open = await context.runCliInProcess(
        ["list-open", "--json", "--full"],
        { expectJson: true },
      );
      expect(
        (open.json as { items: Array<{ id: string }> }).items.map(
          (entry) => entry.id,
        ),
      ).toContain(id);

      const inProgress = await context.runCliInProcess(
        ["list-in-progress", "--json", "--full"],
        { expectJson: true },
      );
      expect(
        (inProgress.json as { items: Array<{ id: string }> }).items.map(
          (entry) => entry.id,
        ),
      ).not.toContain(id);

      const projectContext = await context.runCliInProcess(
        ["context", "--depth", "brief", "--json"],
        { expectJson: true },
      );
      expect(projectContext.json).toMatchObject({
        summary: { active_items: 1, open: 1, in_progress: 0 },
      });

      const next = await context.runCliInProcess(
        ["next", "--ready-only", "--json"],
        { expectJson: true },
      );
      expect(
        (next.json as { recommended: { id: string } }).recommended.id,
      ).toBe(id);

      await writeFile(
        path.join(context.pmPath, "schema", "workflows.json"),
        `${JSON.stringify({ workflow: { in_progress_status: "review" } }, null, 2)}\n`,
        "utf8",
      );
      const customInProgress = context.runCli(
        ["list-in-progress", "--json", "--full"],
        { expectJson: true },
      );
      expect(
        (customInProgress.json as { items: Array<{ id: string }> }).items.map(
          (entry) => entry.id,
        ),
      ).toContain(id);
      const customOpen = context.runCli(["list-open", "--json", "--full"], {
        expectJson: true,
      });
      expect(
        (customOpen.json as { items: Array<{ id: string }> }).items.map(
          (entry) => entry.id,
        ),
      ).not.toContain(id);
      const customContext = context.runCli(
        ["context", "--depth", "brief", "--json"],
        { expectJson: true },
      );
      expect(customContext.json).toMatchObject({
        summary: { active_items: 1, open: 0, in_progress: 1 },
      });
    });
  });

  it("diagnoses legacy roleless statuses in health and validate with affected ids", async () => {
    await withTempPmPath(async (context) => {
      const statusesPath = path.join(context.pmPath, "schema", "statuses.json");
      await writeFile(
        statusesPath,
        `${JSON.stringify({ statuses: [{ id: "review" }] }, null, 2)}\n`,
        "utf8",
      );
      const settingsPath = path.join(context.pmPath, "settings.json");
      expect((await readFile(settingsPath, "utf8")).length).toBeGreaterThan(0);

      const health = await context.runCliInProcess(
        ["health", "--check-only", "--full", "--json"],
        { expectJson: true },
      );
      expect((health.json as { warnings: string[] }).warnings).toContain(
        "schema_status_missing_lifecycle_role:1",
      );
      const settingsValues = (
        health.json as {
          checks: Array<{ name: string; details: Record<string, unknown> }>;
        }
      ).checks.find((check) => check.name === "settings_values");
      expect(settingsValues).toMatchObject({
        details: {
          lifecycle_status_roles: {
            roleless_statuses: ["review"],
            affected_item_count: 0,
          },
        },
      });

      const validate = await context.runCliInProcess(
        ["validate", "--check-lifecycle", "--json"],
        { expectJson: true },
      );
      expect((validate.json as { warnings: string[] }).warnings).toContain(
        "schema_status_missing_lifecycle_role:1",
      );
    });
  });

  it("fails strict health for an unprepared clone and exposes one position action", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });
      const strict = await context.runCliInProcess([
        "health",
        "--strict-exit",
        "--skip-drift",
        "--skip-vectors",
        "--json",
      ]);
      expect(strict.code).not.toBe(0);
      expect(strict.stdout).toContain("merge_driver_configuration_missing");

      const before = await context.runCliInProcess(
        ["workspace", "position", "--json"],
        { expectJson: true },
      );
      expect(before.json).toMatchObject({
        ok: false,
        state: "merge_fence_unprepared",
        next_action: {
          command: `pm --pm-path ${context.pmPath} merge install`,
        },
      });

      const installed = context.runCli(["merge", "install", "--json"], {
        expectJson: true,
        cwd: context.tempRoot,
      });
      expect(installed.code, installed.stderr).toBe(0);
      const after = await context.runCliInProcess(
        ["workspace", "position", "--json"],
        { expectJson: true },
      );
      expect(after.json).toMatchObject({
        ok: true,
        state: "ready",
        next_action: { command: null },
      });
    });
  });
});
