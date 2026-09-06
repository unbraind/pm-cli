import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

/** Measured verdict fields common to the diagnostic and restored evidence projections. */
interface DiagnosticResult {
  ok: boolean;
  checks: {
    name: string;
    ok: boolean;
    status: string;
    details: Record<string, unknown>;
  }[];
  failed_because: string[];
  verdict: { authority: string; exit_code: number };
}

describe("recommended health diagnostic", () => {
  it("executes the documented diagnostic and restores complete evidence without changing its verdict", async () => {
    const root = process.cwd();
    const [agents, guide, projection, manifest] = await Promise.all([
      readFile(path.join(root, "AGENTS.md"), "utf8"),
      readFile(path.join(root, "docs/AGENT_GUIDE.md"), "utf8"),
      readFile(path.join(root, "docs/OUTPUT_PROJECTION_CONTRACTS.md"), "utf8"),
      readFile(path.join(root, "scripts/release/token-budgets.json"), "utf8"),
    ]);
    expect(agents).toContain("pm health --check-only");
    expect(guide).toContain("pm health --check-only");
    expect(projection).toContain("health --check-only --full");
    const budgets = JSON.parse(manifest) as {
      budgets: {
        id: string;
        args: string[];
        max_estimated_tokens: number;
        scale_tier: string;
      }[];
    };
    const healthBudget = budgets.budgets.find(
      (entry) => entry.id === "health-default",
    );
    expect(healthBudget).toMatchObject({
      args: ["health", "--check-only"],
      scale_tier: "medium",
    });
    expect(healthBudget?.max_estimated_tokens).toBeLessThanOrEqual(164);
    await withTempPmPath(async (context) => {
      const compact = context.runCli(["health", "--check-only", "--json"], {
        expectJson: true,
      });
      const restored = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { expectJson: true },
      );
      expect(compact.code).toBe(0);
      expect(restored.code).toBe(0);
      const brief = compact.json as DiagnosticResult;
      const full = restored.json as DiagnosticResult;
      expect(brief.ok).toBe(full.ok);
      expect(brief.verdict).toEqual(full.verdict);
      expect(brief.failed_because).toEqual(full.failed_because);
      expect(
        brief.checks.map(({ name, status, ok }) => ({ name, status, ok })),
      ).toEqual(
        full.checks.map(({ name, status, ok }) => ({ name, status, ok })),
      );
      expect(
        brief.checks.every(
          (check) => Object.keys(check.details ?? {}).length === 0,
        ),
      ).toBe(true);
      expect(
        full.checks.some((check) => Object.keys(check.details).length > 0),
      ).toBe(true);
      expect(Buffer.byteLength(compact.stdout)).toBeLessThan(
        Buffer.byteLength(restored.stdout) / 2,
      );
    });
  });
});
