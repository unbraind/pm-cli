import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  readSettings,
  writeSettings,
} from "../../../../src/core/store/settings.js";
import { runHealth } from "../../../../src/sdk/governance/health.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("health invocation verdict authority", () => {
  it("keeps advisory checks passing and exposes the strict decision in every projection", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });
      const created = context.runCli(
        ["create", "Compaction advisory", "--type", "Issue", "--json"],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const itemId = (created.json as { item: { id: string } }).item.id;
      expect(
        context.runCli(["comments", itemId, "Add a second history entry"]).code,
      ).toBe(0);
      const settings = await readSettings(context.pmPath);
      settings.history.compact_policy = {
        enabled: true,
        max_entries: 1,
        trigger: "health_warn",
      };
      await writeSettings(context.pmPath, settings, "test:advisory-storage");
      for (const projection of [
        {},
        { summary: true },
        { brief: true },
        { full: true },
      ]) {
        for (const strictExit of [false, true]) {
          const result = await runHealth(
            { path: context.pmPath },
            { ...projection, strictExit },
          );
          expect(result.ok).toBe(!strictExit);
          expect(result.verdict).toMatchObject({
            authority: "ok",
            exit_code: strictExit ? 1 : 0,
          });
          expect(result.verdict?.strict_exit).toBe(strictExit || undefined);
          expect(result.verdict?.require_merge_drivers).toBe(
            strictExit || undefined,
          );
          expect(
            result.checks.find((check) => check.name === "integrity"),
          ).toMatchObject({
            status: "warn",
            ok: !strictExit,
          });
          expect(
            result.checks.find((check) => check.name === "storage"),
          ).toMatchObject({ status: "warn", ok: true });
          expect(result.findings).toContainEqual(
            expect.objectContaining({
              warning: `history_stream_over_compact_threshold:${itemId}`,
              check: "storage",
              severity: "advisory",
            }),
          );
          expect(result.failed_because).toEqual(
            strictExit ? ["merge_driver_configuration_missing:5"] : [],
          );
        }
      }
      const alias = await runHealth(
        { path: context.pmPath },
        { failOnWarn: true },
      );
      expect(alias.verdict).toMatchObject({
        strict_exit: true,
        require_merge_drivers: true,
        exit_code: 1,
      });
      const cli = context.runCli(["health", "--strict-exit", "--json"], {
        cwd: context.tempRoot,
        expectJson: true,
      });
      expect(cli.status).toBe(1);
      expect(cli.json).toMatchObject({
        ok: false,
        verdict: { authority: "ok", exit_code: 1 },
      });
    });
  });
  it("attributes orphan history failures to storage in the complete verdict", async () => {
    await withTempPmPath(async (context) => {
      await mkdir(path.join(context.pmPath, "history"), { recursive: true });
      await writeFile(
        path.join(context.pmPath, "history", "pm-orphan.jsonl"),
        "{}\n",
      );
      const result = await runHealth(
        { path: context.pmPath },
        { checkOnly: true, strictExit: true },
      );
      expect(result.ok).toBe(false);
      expect(result.failed_because).toContain(
        "history_orphaned_stream:pm-orphan",
      );
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          check: "storage",
          severity: "gate_failing",
          warning: "history_orphaned_stream:pm-orphan",
        }),
      );
      expect(
        result.checks.find((check) => check.name === "storage"),
      ).toMatchObject({ ok: false, status: "warn" });
    });
  });
});
