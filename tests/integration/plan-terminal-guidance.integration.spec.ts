import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("terminal plan guidance", () => {
  it("never recommends closing an already closed completed plan", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "plan",
          "create",
          "--json",
          "--title",
          "Terminal guidance fixture",
          "--step",
          "Complete me",
          "--create-mode",
          "progressive",
        ],
        { expectJson: true },
      );
      const planId = created.json?.plan?.id as string;
      expect(created.code).toBe(0);

      expect(
        context.runCli(
          [
            "plan",
            "complete-step",
            planId,
            "plan-step-001",
            "--step-evidence",
            "verified",
            "--json",
          ],
          { expectJson: true },
        ).code,
      ).toBe(0);
      expect(
        context.runCli(
          [
            "close",
            planId,
            "plan complete",
            "--resolution",
            "completed",
            "--expected-result",
            "Plan is complete",
            "--actual-result",
            "Plan completed",
            "--json",
          ],
          { expectJson: true },
        ).code,
      ).toBe(0);

      const shown = context.runCli(
        ["plan", "show", planId, "--depth", "deep", "--json"],
        { expectJson: true },
      );
      expect(shown.code).toBe(0);
      expect(shown.json?.plan).toMatchObject({
        status: "closed",
        mode: "completed",
        steps_summary: { completion_pct: 100 },
      });
      expect(shown.json?.next_actions).not.toContain(
        `pm close ${planId} "plan complete"`,
      );
    });
  });
});
