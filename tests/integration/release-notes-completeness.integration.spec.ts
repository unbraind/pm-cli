import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { PmClient } from "../../src/sdk/index.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

const executeFile = promisify(execFile);

it("summarizes complete release evidence when the workspace exceeds the default JSON budget", async () => {
  await withTempPmPath(async (context) => {
    const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
    let closedId = "";
    for (let index = 0; index < 128; index += 1) {
      const created = await client.create({
        title: `Release evidence ${index}: preserve complete tracker context across machine-consumer boundaries`,
        type: "Task", description: "Real workspace input for release-note completeness.",
        priority: index === 127 ? "4" : "0",
      });
      closedId = created.item.id;
    }
    expect(closedId).not.toBe("");
    const closed = await context.runCliInProcess([
      "close", closedId, "Release evidence fixture", "--resolution", "Verified complete input",
      "--expected", "Eligible item survives budget truncation", "--actual", "Fixture closed", "--json",
    ], { expectJson: true });
    expect(closed.code).toBe(0);
    const bounded = context.runCli(["list-all", "--json"], { expectJson: true });
    expect(bounded.code).toBe(0);
    expect(bounded.json).toMatchObject({ truncated: true, total: 128 });

    const notes = await executeFile(process.execPath, [
      path.resolve("scripts/generate-release-notes.mjs"), "--version", "9999.1.1",
      "--from", "refs/tags/pm-no-such-fixture-release",
    ], { env: context.env, encoding: "utf8", timeout: 90_000 });
    expect(notes.stdout).toContain("Closed pm items in release window: 1");
    expect(notes.stdout).toContain(closedId);
    expect(notes.stdout).not.toContain("summary skipped");
  });
}, 120_000);
