import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("executable invocation profiling", () => {
  it("measures the process lifetime across command families and refusal paths", async () => {
    await withTempPmPath(async ({ runCli, tempRoot }) => {
      const commands = [
        ["--version"],
        ["--help"],
        ["list", "--limit", "1"],
        ["context", "--limit", "1"],
        ["next"],
        ["schema", "list"],
        ["ops", "health", "--check-only"],
        ["config", "get", "id_prefix"],
        ["create", "Profile acceptance", "--create-mode", "progressive"],
        ["get", "pm-missing"],
        ["list", "--unknown-profile-option"],
      ];
      for (const args of commands) {
        const start = performance.now();
        const result = runCli(["--profile", "--no-extensions", ...args], {
          cwd: tempRoot,
        });
        const wallMs = performance.now() - start;
        const totals = [
          ...result.stderr.matchAll(/profile:invocation total_ms=([\d.]+)/gu),
        ];
        expect(totals, args.join(" ")).toHaveLength(1);
        const total = Number(totals[0]?.[1]);
        expect(total).toBeGreaterThan(0);
        expect(total).toBeLessThanOrEqual(wallMs + 5);
        // Runtime start excludes parent scheduling/spawn and final OS teardown.
        expect(wallMs - total).toBeLessThan(Math.max(250, wallMs * 0.25));
        expect(result.stderr).toContain("command_took_ms_scope=handler");
        for (const match of result.stderr.matchAll(
          /profile:command=\S+ took_ms=(\d+)/gu,
        )) {
          expect(Number(match[1])).toBeLessThanOrEqual(total);
        }
      }
      const plain = runCli(["list", "--json"], {
        cwd: tempRoot,
        expectJson: true,
      });
      expect(plain.code).toBe(0);
      expect(plain.stderr).not.toContain("profile:invocation");
    });
  });
});
