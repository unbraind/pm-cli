/** @module tests/unit/cli/first-run-error-display
 * Keeps initialization refusals short without losing exact tracker recovery.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatPmCliErrorForDisplay,
  formatPmCliErrorForJson,
} from "../../../src/cli/error-guidance.js";
import { buildTrackerInitializationRecovery } from "../../../src/sdk/environment/tracker-preflight.js";

describe("first-run refusal display", () => {
  it("preserves existing custom-tracker selection guidance", () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), "pm-nearby-recovery-"),
    );
    const previousCwd = process.cwd();
    try {
      const existing = path.join(workspace, "custom");
      mkdirSync(existing);
      writeFileSync(
        path.join(existing, "settings.json"),
        '{"id_prefix":"pm-"}',
      );
      process.chdir(workspace);
      const missing = path.join(workspace, ".agents", "pm");
      const display = formatPmCliErrorForDisplay(
        `Tracker is not initialized at ${missing}. Run pm init first.`,
        {
          code: "tracker_root_missing",
          recovery: buildTrackerInitializationRecovery(missing),
        },
      );
      expect(display).toContain("Select the existing tracker root explicitly.");
      expect(display).toContain(existing);
    } finally {
      process.chdir(previousCwd);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("retains full guidance when a caller supplies no executable retry", () => {
    const display = formatPmCliErrorForDisplay(
      "Tracker is not initialized at /missing. Run pm init first.",
      { code: "tracker_not_initialized" },
    );
    expect(display).toContain("Next steps:");
    expect(display).not.toContain("Run: pm");
  });

  it.each(["tracker_root_missing", "tracker_not_initialized"])(
    "keeps %s actionable in three lines",
    (code) => {
      const root = "/tmp/pm scratch/.agents/pm";
      const message = `Tracker is not initialized at ${root}. Run pm init first.`;
      const context = {
        code,
        recovery: buildTrackerInitializationRecovery(root),
      };
      const display = formatPmCliErrorForDisplay(message, context);
      expect(display.split("\n")).toHaveLength(3);
      expect(display).toContain(
        'Run: pm --pm-path "/tmp/pm scratch/.agents/pm" init --defaults --agent-guidance skip',
      );
      expect(formatPmCliErrorForJson(message, 3, context)).toHaveProperty(
        "recovery.suggested_retry_args",
        context.recovery.suggested_retry_args,
      );
    },
  );
});
