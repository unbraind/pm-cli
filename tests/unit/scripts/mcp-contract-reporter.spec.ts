import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Vitest } from "vitest/node";
import McpContractReporter, { MCP_OPTION_WARNING_ALLOWLIST } from "../../../scripts/mcp-contract-reporter.mts";
import { withTempDir } from "../../helpers/temp.js";

describe("MCP contract warning gate", () => {
  it("rejects new option warnings and limits exemptions to an exact test and warning identity", () => {
    const entry = MCP_OPTION_WARNING_ALLOWLIST[0];
    const reporter = new McpContractReporter();
    reporter.onInit({ state: { getReportedEntityById: () => ({ module: { relativeModuleId: entry.file.replaceAll("/", "\\") }, fullName: entry.test }) } } as unknown as Vitest);
    reporter.onUserConsoleLog({ content: "ordinary diagnostic", type: "stderr", time: 0, size: 1 });
    reporter.onUserConsoleLog({ content: '[pm-mcp] Unknown option "dep" for pm_deps action "deps"', taskId: "intentional", type: "stderr", time: 0, size: 1 });
    expect(() => reporter.onTestRunEnd()).not.toThrow();
    reporter.onUserConsoleLog({ content: '[pm-mcp] Unknown option "newMistake" for pm_deps action "deps"', taskId: "intentional", type: "stderr", time: 0, size: 1 });
    reporter.onUserConsoleLog({ content: '[pm-mcp] Unknown option "dep" for pm_deps action "deps"', type: "stderr", time: 0, size: 1 });
    expect(() => reporter.onTestRunEnd()).toThrow("mcp_unknown_option_contract_drift");
    expect(() => reporter.onTestRunEnd()).toThrow("<unknown>");
  });

  it("fails a real otherwise-green Vitest process when an undeclared MCP option is emitted", async () => {
    await withTempDir("pm-mcp-warning-gate-", async (root) => {
      const reporterUrl = pathToFileURL(path.resolve("scripts/mcp-contract-reporter.mts")).href;
      const vitestUrl = pathToFileURL(path.resolve("node_modules/vitest/dist/index.js")).href;
      await writeFile(path.join(root, "vitest.config.mts"), `import Reporter from ${JSON.stringify(reporterUrl)};\nexport default { test: { include: ['probe.spec.mjs'], reporters: [new Reporter()] } };\n`);
      await writeFile(path.join(root, "probe.spec.mjs"), `import { it, expect } from ${JSON.stringify(vitestUrl)};\nit('otherwise green', () => { console.error('[pm-mcp] Unknown option "drift" for pm_run action "get"'); expect(1).toBe(1); });\n`);
      const result = spawnSync(process.execPath, [path.resolve("scripts/run-tests.mjs"), "test", "--", "--root", root, "--config", path.join(root, "vitest.config.mts"), "--reporter=default"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, CI: "1", PM_RUN_TESTS_SKIP_BUILD: "1" } });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("mcp_unknown_option_contract_drift");
      expect(result.stderr).toContain("drift:pm_run:get");
    });
  });
});
