import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redactSensitiveCommandArgs } from "../../src/sdk/command-line.js";
import { resolvePmCommandOutputEnvelope } from "../../src/sdk/output-contracts.js";
import { createTaskFixture } from "../helpers/createTaskFixture.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("native history namespace compatibility", () => {
  it("rejects unsafe compaction thresholds in native and legacy commands", async () => {
    await withTempPmPath(async (context) => {
      for (const command of [["history", "compact"], ["history-compact"]]) {
        for (const flag of ["--all-over", "--min-entries"]) {
          for (const value of ["9007199254740992", "9".repeat(310)]) {
            const result = context.runCli([
              ...command, "--all-streams", flag, value, "--dry-run", "--json",
            ]);
            expect(result.code).toBe(2);
            expect(result.stderr + result.stdout).toContain("must be a non-negative integer");
          }
          const valid = context.runCli([
            ...command, "--all-streams", flag, String(Number.MAX_SAFE_INTEGER), "--dry-run", "--json",
          ]);
          expect(valid.code, valid.stderr).toBe(0);
        }
      }
    });
  });

  it("withholds option-shaped matcher values from SDK and CLI failure recovery", async () => {
    await withTempPmPath(async (context) => {
      for (const command of [["history", "redact"], ["history-redact"]]) {
        for (const flag of ["--literal", "--regex", "--replacement"]) {
          for (const value of ["--force=privacy-canary", "--json=privacy-canary"]) {
            const args = [...command, "pm-missing", flag, value, "--json"];
            expect(redactSensitiveCommandArgs(args)).toEqual([
              ...command, "pm-missing", flag, "[redacted]", "--json",
            ]);
            const failed = context.runCli(args);
            expect(failed.code).not.toBe(0);
            expect(failed.stderr + failed.stdout).not.toContain("privacy-canary");
            expect(failed.stderr + failed.stdout).toContain("[redacted]");
          }
          for (const value of ["--force", "--json", "--dry_run"]) {
            const args = [...command, flag, value];
            expect(redactSensitiveCommandArgs(args)).toEqual([...command, flag, "[redacted]"]);
          }
        }
      }
    });
  });

  it("preserves maintenance previews, activity projections, and default item history", async () => {
    await withTempPmPath(async (context) => {
      context.env.PM_CLOCK = "2026-09-07T00:00:00.000Z";
      context.env.PM_CLOCK_TICK_MS = "0";
      context.env.PM_SEED = "history-namespace";
      const id = "pm-history-native";
      createTaskFixture(context, id, "History namespace matcher fixture");
      const historyPath = path.join(
        context.pmPath,
        "history",
        `${id}.jsonl`,
      );
      const before = await readFile(historyPath, "utf8");
      for (const [leaf, alias, args] of [
        ["repair", "history-repair", [id, "--dry-run"]],
        ["compact", "history-compact", [id, "--dry-run"]],
        [
          "redact",
          "history-redact",
          [id, "--literal", "matcher", "--dry-run"],
        ],
        ["activity", "activity", ["--id", id, "--full", "--limit", "1"]],
      ] as const) {
        const native = context.runCli(
          ["history", leaf, ...args, "--json"],
          { expectJson: true },
        );
        const legacy = context.runCli([alias, ...args, "--json"], {
          expectJson: true,
        });
        expect(native.code, native.stderr).toBe(0);
        expect(legacy.code, legacy.stderr).toBe(0);
        expect(native.json).toEqual(legacy.json);
      }
      const withGlobals = context.runCli(
        ["history", "--json", "repair", "--id", id, "--dry_run"],
        { expectJson: true },
      );
      expect(withGlobals.code, withGlobals.stderr).toBe(0);
      expect(withGlobals.json).toMatchObject({ id, dry_run: true });
      const compactBulk = context.runCli(
        [
          "history",
          "compact",
          "--ids",
          id,
          "--ids",
          id,
          "--dry-run",
          "--json",
        ],
        { expectJson: true },
      );
      expect(compactBulk.code, compactBulk.stderr).toBe(0);
      expect(await readFile(historyPath, "utf8")).toBe(before);
      const history = context.runCli(
        ["history", id, "--verify", "--json"],
        { expectJson: true },
      );
      expect(history.code, history.stderr).toBe(0);
      expect(history.json).toMatchObject({ verification: { ok: true } });
      const namedHistory = context.runCli(
        ["history", "--id", id, "--verify", "--json"],
        { expectJson: true },
      );
      expect(namedHistory.code, namedHistory.stderr).toBe(0);
      expect(namedHistory.json).toEqual(history.json);
      const activity = context.runCli(
        [
          "history",
          "activity",
          "--id",
          id,
          "--output-include",
          "full",
          "--json",
        ],
        { expectJson: true },
      );
      expect(activity.code, activity.stderr).toBe(0);
      expect(activity.json).toMatchObject({ activity: expect.any(Array) });
    });
  });

  it("restores through the default mutation receipt and verifies the resulting chain", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-native-restore";
      createTaskFixture(context, id, "Restore namespace fixture");
      expect(
        context.runCli(["update", id, "--title", "Changed title"]).code,
      ).toBe(0);
      const restored = context.runCli(
        ["history", "restore", id, "1", "--json"],
        { expectJson: true, preserveDefaultMutationOutput: true },
      );
      expect(restored.code, restored.stderr).toBe(0);
      expect(restored.json).toMatchObject({
        id,
        status: "open",
        changed_field_count: expect.any(Number),
      });
      expect(restored.json).not.toHaveProperty("item");
      expect(
        resolvePmCommandOutputEnvelope("history restore"),
      ).toMatchObject({ kind: "mutation_receipt" });
      const verified = context.runCli(
        ["history", id, "--verify", "--strict-exit", "--json"],
        { expectJson: true },
      );
      expect(verified.code, verified.stderr).toBe(0);
      expect(verified.json).toMatchObject({ verification: { ok: true } });
    });
  });

  it("redacts native matcher values before constructing failure recovery guidance", async () => {
    const args = [
      "history",
      "redact",
      "pm-missing",
      "--literal",
      "matcher-canary",
      "--regex=regex-canary",
      "--replacement",
      "replacement-canary",
      "--json",
    ];
    const safe = redactSensitiveCommandArgs(args);
    expect(safe.join(" ")).not.toContain("canary");
    expect(
      redactSensitiveCommandArgs([
        "history",
        "redact",
        "pm-missing",
        "--literal",
        "--matcher-canary",
      ]).join(" "),
    ).not.toContain("canary");
    await withTempPmPath(async (context) => {
      const failed = context.runCli(args);
      expect(failed.code).not.toBe(0);
      expect(failed.stderr + failed.stdout).not.toContain("canary");
      expect(failed.stderr + failed.stdout).toContain("[redacted]");
    });
  });
});
