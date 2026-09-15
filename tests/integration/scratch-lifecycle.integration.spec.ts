/** @module tests/integration/scratch-lifecycle
 * Verifies the actual minimal-project CLI lifecycle and its fixed output costs.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient } from "../../src/sdk/runtime.js";
import { summarizeInitResult } from "../../src/sdk/init.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";
import { withTempDir } from "../helpers/temp.js";
import {
  runDirectDistCli,
  type DirectCliRunOptions,
} from "../helpers/cliRunner.js";

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
    await withTempDir("pm-scratch-first-run-", async (tempRoot) => {
      const pmPath = join(tempRoot, ".agents", "pm");
      const env = {
        ...process.env,
        PM_PATH: pmPath,
        PM_GLOBAL_PATH: join(tempRoot, "global"),
        PM_AUTHOR: "test-author",
        DO_NOT_TRACK: "1",
        PM_TELEMETRY_DISABLED: "1",
      };
      /** Execute the installed CLI in a fresh workspace without fixture initialization or output normalization. */
      const runCli = (args: string[], options: DirectCliRunOptions = {}) =>
        runDirectDistCli(args, { ...options, env, cwd: tempRoot });
      expect(existsSync(pmPath)).toBe(false);
      let bytes = 0;
      const started = performance.now();
      const init = runCli(["init", "--yes", "--agent-guidance", "skip"]);
      expect(init.status).toBe(0);
      expect(existsSync(join(pmPath, "settings.json"))).toBe(true);
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
        const configured = runCli(args);
        expect(configured.status).toBe(0);
        bytes += Buffer.byteLength(configured.stdout);
      }
      const ids: string[] = [];
      for (const title of ["Understand", "Implement", "Verify"]) {
        const created = runCli(["create", "Task", title, "--json"], {
          expectJson: true,
        });
        expect(created.status).toBe(0);
        ids.push((created.json as { id: string }).id);
        bytes += Buffer.byteLength(created.stdout);
      }
      const next = runCli(["next", "--json"], { expectJson: true });
      expect(next.status).toBe(0);
      expect(next.stdout).toContain(ids[0]);
      bytes += Buffer.byteLength(next.stdout);
      const workingContext = runCli(["context", "--json"], {
        expectJson: true,
      });
      expect(workingContext.status).toBe(0);
      expect(workingContext.stdout).toContain(ids[0]);
      bytes += Buffer.byteLength(workingContext.stdout);
      const closed = runCli([
        "close",
        ids[0],
        "Scratch work verified",
        "--resolution",
        "Understood the task",
        "--expected",
        "Clear scope",
        "--actual",
        "Scope documented",
      ]);
      expect(closed.status).toBe(0);
      bytes += Buffer.byteLength(closed.stdout);
      expect(Math.ceil(bytes / 4)).toBeLessThanOrEqual(3000);
      expect(performance.now() - started).toBeLessThan(15000);
      const validation = runCli(["validate", "--json"], {
        expectJson: true,
      });
      expect(validation.json).toMatchObject({ ok: true, has_warnings: false });
      const full = runCli(["init", "--yes", "--json"], {
        expectJson: true,
      });
      expect(full.json).toHaveProperty("created_dirs");
      expect(full.json).toHaveProperty("settings");
    });
  });
});
