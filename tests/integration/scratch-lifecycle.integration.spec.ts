/** @module tests/integration/scratch-lifecycle
 * Verifies the actual minimal-project CLI lifecycle and its fixed output costs.
 */
import { describe, expect, it } from "vitest";
import { PmClient } from "../../src/sdk/runtime.js";
import { summarizeInitResult } from "../../src/sdk/init.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("scratch project lifecycle", () => {
  it("offers a compact SDK display while preserving full results and actionable warnings", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      const result = await client.init(undefined, {
        defaults: true,
        agentGuidance: "skip",
      });
      expect(summarizeInitResult(result).created_dirs).toEqual(
        result.created_dirs,
      );
      for (const enabled of [true, false]) {
        const display = summarizeInitResult(
          {
            ...result,
            warnings: [],
            settings: {
              ...result.settings,
              telemetry: { ...result.settings.telemetry, enabled },
            },
          },
          true,
        );
        expect(display.telemetry).toContain(enabled ? "enabled" : "disabled");
        expect(display).not.toHaveProperty("warnings");
        expect(display.details).toContain(context.pmPath);
      }
      const display = summarizeInitResult(
        {
          ...result,
          warnings: [
            "already_exists:settings.json",
            "merge_fence_skipped:install_failed:retry pm merge install",
          ],
        },
        true,
      );
      expect(display.warnings).toBe(
        "merge_fence_skipped:install_failed:retry pm merge install",
      );
    });
  });
  it("initializes concisely, captures three tasks, selects work, and closes it", async () => {
    await withTempPmPath(async (context) => {
      let bytes = 0;
      const started = performance.now();
      const init = context.runCli(
        ["init", "--yes", "--agent-guidance", "skip"],
        { preserveDefaultMutationOutput: true },
      );
      expect(init.status).toBe(0);
      expect(init.stdout.trim().split("\n").length).toBeLessThanOrEqual(12);
      bytes += Buffer.byteLength(init.stdout);
      for (const args of [
        ["config", "set", "governance-metadata-validation-profile", "custom"],
        [
          "config",
          "set",
          "metadata-required-fields",
          "--criterion",
          "author",
          "--criterion",
          "close_reason",
        ],
      ]) {
        const configured = context.runCli(args);
        expect(configured.status).toBe(0);
        bytes += Buffer.byteLength(configured.stdout);
      }
      const ids: string[] = [];
      for (const title of ["Understand", "Implement", "Verify"]) {
        const created = context.runCli(["create", "Task", title, "--json"], {
          expectJson: true,
          preserveDefaultMutationOutput: true,
        });
        expect(created.status).toBe(0);
        ids.push((created.json as { id: string }).id);
        bytes += Buffer.byteLength(created.stdout);
      }
      const next = context.runCli(["next", "--json"], { expectJson: true });
      expect(next.status).toBe(0);
      expect(next.stdout).toContain(ids[0]);
      bytes += Buffer.byteLength(next.stdout);
      const workingContext = context.runCli(["context", "--json"], {
        expectJson: true,
      });
      expect(workingContext.status).toBe(0);
      expect(workingContext.stdout).toContain(ids[0]);
      bytes += Buffer.byteLength(workingContext.stdout);
      const closed = context.runCli(
        [
          "close",
          ids[0],
          "Scratch work verified",
          "--resolution",
          "Understood the task",
          "--expected",
          "Clear scope",
          "--actual",
          "Scope documented",
        ],
        { preserveDefaultMutationOutput: true },
      );
      expect(closed.status).toBe(0);
      bytes += Buffer.byteLength(closed.stdout);
      expect(Math.ceil(bytes / 4)).toBeLessThanOrEqual(3000);
      expect(performance.now() - started).toBeLessThan(15000);
      const validation = context.runCli(["validate", "--json"], {
        expectJson: true,
      });
      expect(validation.json).toMatchObject({ ok: true, has_warnings: false });
      const full = context.runCli(["init", "--yes", "--json"], {
        expectJson: true,
      });
      expect(full.json).toHaveProperty("created_dirs");
      expect(full.json).toHaveProperty("settings");
    });
  });
});
