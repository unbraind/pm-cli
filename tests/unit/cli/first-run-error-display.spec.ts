/** @module tests/unit/cli/first-run-error-display
 * Keeps initialization refusals short without losing exact tracker recovery.
 */
import { describe, expect, it } from "vitest";
import {
  formatPmCliErrorForDisplay,
  formatPmCliErrorForJson,
} from "../../../src/cli/error-guidance.js";
import { buildTrackerInitializationRecovery } from "../../../src/sdk/environment/tracker-preflight.js";

describe("first-run refusal display", () => {
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
