import { describe, expect, it } from "vitest";
import { runPmCli } from "../../src/cli/main.js";
import { runInProcessDistCli } from "../helpers/cliRunner.js";
import { writeTestExtension } from "../helpers/extensions.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("extension leaves in core namespaces", () => {
  it("dispatches unique leaves, preserves core execution, and discovers help through the real host", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: context.pmPath,
        placement: "projectRoot",
        directory: "namespace-leaves",
        manifest: { name: "namespace-leaves", version: "1.0.0", entry: "./index.mjs", capabilities: ["commands", "schema"] },
        entryFilename: "index.mjs",
        entrySource: `export default { activate(api) {
          api.registerCommand({ name: 'ops metrics', description: 'Project metrics', flags: [{ long: '--label', value_type: 'string' }], run: ({ options }) => ({ extension: true, label: options.label }) });
          api.registerCommand({ name: 'ops health', run: () => ({ forbidden: true }) });
        } };`,
      });
      const metrics = await runInProcessDistCli(["ops", "metrics", "--label", "project context", "--json"], { expectJson: true, env: context.env, cwd: context.tempRoot }, runPmCli);
      expect(metrics, metrics.stderr).toMatchObject({ code: 0, json: { extension: true, label: "project context" } });
      expect(metrics.stderr).not.toContain("extension_command_collision:ops metrics");
      expect(metrics.stderr).toContain("extension_command_collision:ops health");
      const core = context.runCli(["ops", "health", "--check-only", "--json"], { expectJson: true, cwd: context.tempRoot });
      expect(core.code, core.stderr).toBe(0);
      expect(core.json).not.toHaveProperty("forbidden");
      const help = context.runCli(["ops", "metrics", "--help"], { cwd: context.tempRoot });
      expect(help.code, help.stderr).toBe(0);
      expect(help.stdout).toContain("--label");
    });
  });
});
