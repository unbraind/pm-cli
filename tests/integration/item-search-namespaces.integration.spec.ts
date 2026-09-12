/** @module tests/integration/item-search-namespaces
 * Exercises bundled package activation and canonical command parsing in isolated trackers.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createTaskFixture } from "../helpers/createTaskFixture.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("item and search package namespaces", () => {
  it("preserves command results, package flags, and literal search operands", async () => {
    await withTempPmPath(async (context) => {
      context.env.PM_CLOCK = "2026-09-10T00:00:00.000Z";
      context.env.PM_CLOCK_TICK_MS = "0";
      context.env.PM_SEED = "item-search-namespaces";
      createTaskFixture(context, "pm-namespace-source", "advanced namespace fixture");
      const facets = [
        ["search advanced", "search-advanced", "--mode"],
        ["item duplicates audit", "dedupe-audit", "--mode"],
        ["item duplicates merge", "dedupe-merge", "--keep"],
        ["item audit-comments", "comments-audit", "--latest"],
      ];
      for (const [canonical, action] of facets) {
        const missing = context.runCli(["contracts", "--command", canonical, "--availability-only", "--json"], { expectJson: true });
        expect(missing.code, missing.stderr).toBe(0);
        expect(missing.json).toMatchObject({ action_availability: [expect.objectContaining({ action, available: false })] });
        for (const command of [canonical, action]) {
          const unavailable = context.runCli([...command.split(" "), "--help"]);
          expect(unavailable.code, unavailable.stdout).toBe(2);
          expect(unavailable.stderr).toContain("Unknown command");
        }
      }
      const guide = context.runCli(["package", "install", "guide-shell", "--project", "--json"], { expectJson: true });
      expect(guide.code, guide.stderr).toBe(0);
      for (const packageActive of [false, true]) {
        if (packageActive) {
          for (const name of ["search-advanced", "audit"]) {
            const installed = context.runCli(["package", "install", name, "--project", "--json"], { expectJson: true });
            expect(installed.code, installed.stderr).toBe(0);
          }
        }
        const completion = context.runCli(["completion", "bash", "--json"], { expectJson: true, cwd: context.tempRoot });
        expect(completion.code, completion.stderr).toBe(0);
        const input = `${(completion.json as { script: string }).script}\nCOMP_WORDS=(pm item duplicates ''); COMP_CWORD=3; _pm_completion; printf '%s\\n' "\${COMPREPLY[@]}"`;
        const suggestions = execFileSync("bash", ["-s"], { input, encoding: "utf8" }).trim().split(/\s+/);
        expect(suggestions.includes("merge")).toBe(packageActive);
      }
      const boundedFlags = context.runCli(["contracts", "--flags-only", "--json"], { expectJson: true });
      expect(boundedFlags.code, boundedFlags.stderr + boundedFlags.stdout).toBe(0);
      const boundedReceipt = (boundedFlags.json as { read_output: { budget_tokens: number; estimated_tokens: number } }).read_output;
      const emittedTokens = Math.ceil(Buffer.byteLength(boundedFlags.stdout, "utf8") / 4);
      expect(emittedTokens).toBeLessThanOrEqual(boundedReceipt.budget_tokens);
      expect(boundedReceipt.estimated_tokens).toBe(emittedTokens);
      for (const [canonical, action, flag] of facets) {
        for (const command of [canonical, action]) {
          const contract = context.runCli(["contracts", "--command", command, "--full", "--json", "--output-budget", "unbounded"], { expectJson: true });
          expect(contract.code, contract.stderr).toBe(0);
          expect(contract.json).toMatchObject({
            action_availability: [expect.objectContaining({ action, available: true })],
            command_flags: [expect.objectContaining({ flags: expect.arrayContaining([expect.objectContaining({ flag })]) })],
            extension_commands: expect.arrayContaining([expect.objectContaining({ command: canonical, action })]),
          });
        }
      }
      for (const [legacy, canonical, args] of [
        ["duplicates", ["item", "duplicates"], ["--limit", "2"]],
        ["search-advanced", ["search", "advanced"], ["namespace", "--mode", "keyword"]],
        ["dedupe-audit", ["item", "duplicates", "audit"], []],
        ["comments-audit", ["item", "audit-comments"], []],
      ] as const) {
        const native = context.runCli([...canonical, ...args, "--json"], { expectJson: true });
        const alias = context.runCli([legacy, ...args, "--json"], { expectJson: true });
        expect(native.code, native.stderr).toBe(0);
        expect(alias.code, alias.stderr).toBe(0);
        const receipts = [native.json, alias.json].map((value) => {
          const { now, ...result } = value as Record<string, unknown>;
          if (now !== undefined) expect(Number.isFinite(Date.parse(String(now)))).toBe(true);
          return result;
        });
        expect(receipts[0]).toEqual(receipts[1]);
      }
      const literal = context.runCli(["--json", "search", "--", "advanced"], { expectJson: true });
      expect(literal.code, literal.stderr).toBe(0);
      expect(JSON.stringify(literal.json)).toContain("pm-namespace-source");
      const copy = context.runCli(["item", "copy", "--id", "pm-namespace-source", "--title", "Copied namespace fixture", "--json"], { expectJson: true });
      expect(copy.code, copy.stderr).toBe(0);
      const copiedId = (copy.json as { id: string }).id;
      const copied = context.runCli(["get", copiedId, "--json"], { expectJson: true });
      expect(copied.code, copied.stderr).toBe(0);
      expect(JSON.stringify(copied.json)).toContain("Copied namespace fixture");
      createTaskFixture(context, "pm-namespace-duplicate", "advanced namespace fixture");
      const dryRun = context.runCli(["item", "duplicates", "merge", "--keep", "pm-namespace-source", "--close", "pm-namespace-duplicate", "--dry-run", "--json"], { expectJson: true });
      expect(dryRun.code, dryRun.stderr).toBe(0);
      expect(context.runCli(["get", "pm-namespace-duplicate", "--json"], { expectJson: true }).json).toMatchObject({ item: { status: "open" } });
      const contracts = context.runCli(["contracts", "--command", "search advanced", "--flags-only", "--json"], { expectJson: true });
      expect(contracts.code, contracts.stderr).toBe(0);
      expect(JSON.stringify(contracts.json)).toContain("--mode");
    });
  }, 120_000);
});
