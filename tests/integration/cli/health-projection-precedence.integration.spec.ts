import { describe, expect, it } from "vitest";
import { PmClient, runAction } from "../../../src/sdk/runtime.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

/**
 * GH-1670 (pm-gh1670): `--full` widens the health check scope, while an explicit
 * `--summary` or `--brief` selects the projection. The combination must never
 * silently drop the compact projection.
 */
interface HealthEnvelope {
  checks: Array<{ name: string; status: string }>;
  projection?: { mode: string; omitted_checks?: string[] };
}

const SLOW_CHECKS = ["integrity", "history_drift", "vectorization"];

describe("health projection precedence (GH-1670)", () => {
  it("summarizes the complete check set for --full --summary in CLI, SDK and MCP", async () => {
    await withTempPmPath(async (context) => {
      expect(
        context.runCli(["create", "--json", "--title", "Health precedence seed", "--type", "Task"]).code,
      ).toBe(0);
      const cli = (args: string[]) => {
        const result = context.runCli(["health", ...args, "--json"], { expectJson: true });
        expect(result.code, args.join(" ")).toBe(0);
        return { json: result.json as HealthEnvelope, bytes: result.stdout.length };
      };

      const summary = cli(["--summary"]);
      const full = cli(["--full"]);
      expect(summary.json.projection?.mode).toBe("summary");
      expect(full.json.projection).toBeUndefined();

      for (const order of [["--full", "--summary"], ["--summary", "--full"]]) {
        const combined = cli(order);
        expect(combined.json.projection?.mode, order.join(" ")).toBe("summary");
        expect(combined.json.projection?.omitted_checks).toEqual([]);
        expect(combined.json.checks.map(({ name }) => name)).toEqual(
          full.json.checks.map(({ name }) => name),
        );
        expect(combined.bytes).toBeLessThan(full.bytes);
      }

      // --check-only alone skips the slow checks; --full forces them while the
      // explicit summary still governs the rendered projection.
      const checkOnly = cli(["--check-only", "--summary"]);
      expect(checkOnly.json.projection?.omitted_checks).toEqual(SLOW_CHECKS);
      const checkOnlyFull = cli(["--check-only", "--full", "--summary"]);
      expect(checkOnlyFull.json.projection).toMatchObject({ mode: "summary", omitted_checks: [] });
      for (const name of SLOW_CHECKS) {
        expect(checkOnlyFull.json.checks.map((check) => check.name)).toContain(name);
      }

      expect(cli(["--full", "--brief"]).json.projection?.mode).toBe("brief");
      // Strict exit only implies the summary; --full keeps complete details.
      expect(cli(["--strict-exit", "--full"]).json.projection).toBeUndefined();
      expect(cli(["--strict-exit"]).json.projection?.mode).toBe("summary");

      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      const sdk = (await client.health({ full: true, summary: true })) as HealthEnvelope;
      expect(sdk.projection).toMatchObject({ mode: "summary", omitted_checks: [] });

      const mcp = (await runAction({
        action: "health",
        path: context.pmPath,
        noExtensions: true,
        options: { full: true, summary: true },
      })) as HealthEnvelope;
      expect(mcp.projection).toMatchObject({ mode: "summary", omitted_checks: [] });
      const mcpFull = (await runAction({
        action: "health",
        path: context.pmPath,
        noExtensions: true,
        options: { full: true },
      })) as HealthEnvelope;
      expect(mcpFull.projection).toBeUndefined();
    });
  });
});
