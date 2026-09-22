import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

it("recovers an absent calendar shortcut through real text and JSON errors, installation, and legacy help", async () => {
  await withTempPmPath(async (context) => {
    const cli = path.resolve("dist/cli.js");
    const options = { cwd: context.tempRoot, env: context.env, encoding: "utf8" as const, timeout: 60_000 };
    for (const format of [[], ["--json"]]) {
      const missing = spawnSync(process.execPath, [cli, "remind", "--help", ...format], options);
      expect(missing.status, missing.stderr).toBe(2);
      const output = missing.stdout + missing.stderr;
      expect(output).toContain("pm package install calendar --project");
      expect(output).toContain("pm calendar remind");
      expect(output).not.toContain("suggested command paths above");
    }
    const installed = spawnSync(process.execPath, [cli, "package", "install", "calendar", "--project"], options);
    expect(installed.status, installed.stderr).toBe(0);
    const available = spawnSync(process.execPath, [cli, "remind", "--help"], options);
    expect(available.status, available.stderr).toBe(0);
    expect(available.stdout).toContain("pm calendar remind");
  });
}, 120_000);
