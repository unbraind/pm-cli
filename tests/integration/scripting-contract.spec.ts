import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("CLI scripting process contract", () => {
  it("keeps successful data on stdout and representative failures on stderr", async () => {
    await withTempPmPath(async (context) => {
      const success = context.runCli(["list", "--json"]);
      expect(success.code).toBe(0);
      expect(success.stdout.length).toBeGreaterThan(0);
      expect(success.stderr).toBe("");
      expect(JSON.parse(success.stdout)).toMatchObject({
        items: [],
        filters: { status: "all" },
      });

      for (const [args, exitCode] of [
        [["list", "--priority", "9", "--json"], 2],
        [["get", "pm-does-not-exist", "--json"], 3],
      ] as const) {
        const failure = context.runCli([...args]);
        expect(failure.code).toBe(exitCode);
        expect(failure.stdout).toBe("");
        expect(JSON.parse(failure.stderr)).toMatchObject({ exit_code: exitCode });
      }

      const created = context.runCli([
        "create",
        "--id",
        "scripting-conflict",
        "--title",
        "Scripting conflict",
        "--type",
        "Task",
        "--create-mode",
        "progressive",
        "--json",
      ]);
      expect(created.code).toBe(0);
      context.env.PM_AUTHOR = "first-script-agent";
      expect(context.runCli(["claim", "pm-scripting-conflict", "--json"]).code).toBe(0);
      context.env.PM_AUTHOR = "second-script-agent";
      const conflict = context.runCli(["claim", "pm-scripting-conflict", "--json"]);
      expect(conflict.code).toBe(4);
      expect(conflict.stdout).toBe("");
      expect(JSON.parse(conflict.stderr)).toMatchObject({ exit_code: 4 });
    });
  });
});
