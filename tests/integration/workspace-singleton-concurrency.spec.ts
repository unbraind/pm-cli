import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { readSettings } from "../../src/core/store/settings.js";
import { getWorkspaceHistoryPath, inspectWorkspaceHistoryState } from "../../src/core/history/workspace-history.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

it("keeps synchronized settings edits from independent public SDK processes", async () => {
  await withTempPmPath(async ({ pmPath, tempRoot, env }) => {
    const sdkUrl = pathToFileURL(path.resolve("dist/cli-bundle/sdk.js")).href;
    const workers = Array.from({ length: 3 }, (_, index) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { readSettings, writeSettings } from ${JSON.stringify(sdkUrl)};
        const root = process.argv[1];
        const changes = [["activity_limit", 21], ["stale_threshold_days", 31], ["default_depth", "deep"]];
        const [key, value] = changes[Number(process.argv[2])];
        const settings = await readSettings(root);
        settings.context[key] = value;
        process.once("message", async () => {
          await writeSettings(root, settings, "test:concurrent-sdk");
          process.disconnect();
        });
        process.send("ready");
      `, pmPath, String(index)], {
        cwd: tempRoot, env, stdio: ["ignore", "ignore", "pipe", "ipc"],
        timeout: 20_000, killSignal: "SIGKILL",
      });
      const diagnostics = { stderr: "" };
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { diagnostics.stderr += chunk; });
      const done = once(child, "exit");
      const ready = Promise.race([
        once(child, "message"),
        done.then(() => { throw new Error(`SDK writer exited before release: ${diagnostics.stderr}`); }),
      ]);
      return { child, done, ready, diagnostics };
    });
    try {
      await Promise.all(workers.map((worker) => worker.ready));
      // Every process holds the same before-state; release them together.
      for (const worker of workers) worker.child.send("write");
      const results = await Promise.all(workers.map((worker) => worker.done));
      for (const [index, result] of results.entries()) {
        expect(result, workers[index]!.diagnostics.stderr).toEqual([0, null]);
      }
      expect((await readSettings(pmPath)).context).toMatchObject({
        activity_limit: 21, stale_threshold_days: 31, default_depth: "deep",
      });
      expect((await inspectWorkspaceHistoryState(pmPath)).ok).toBe(true);
      const entries = (await readFile(getWorkspaceHistoryPath(pmPath), "utf8")).trim().split("\n");
      expect(entries.filter((line) => (JSON.parse(line) as { op: string }).op === "test:concurrent-sdk")).toHaveLength(3);
    } finally {
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
      }
      await Promise.allSettled(workers.map((worker) => worker.done));
    }
  });
}, 30_000);
