import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionCommandSdk } from "../../../src/sdk/extension-command-context.js";
import { PmClient } from "../../../src/sdk/runtime.js";
import { runTest } from "../../../src/sdk/test/execution.js";
import { readFileIfExists } from "../../../src/core/fs/fs-utils.js";
import { writeWorkspaceJsonWithHistory } from "../../../src/core/history/workspace-history.js";
import { readSettings } from "../../../src/core/store/settings.js";
import { runInit } from "../../../src/sdk/init.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { overwriteTaskTests } from "../../helpers/pmWorkspace.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

afterEach(() => vi.useRealTimers());

describe("schema linked-test settings audit", () => {
  it.each([false, true])("seeds audited settings without items and rejects drift (custom policy: %s)", async (customPolicy) => {
    await withTempPmPath(async (context) => {
      const globalRoot = context.env.PM_GLOBAL_PATH!;
      expect(context.runCli(["init", "--pm-path", globalRoot, "--json"]).code).toBe(0);
      if (customPolicy) {
        for (const pmRoot of [context.pmPath, globalRoot]) {
          const sdk = createExtensionCommandSdk(pmRoot, new PmClient({ pmRoot, noExtensions: true }));
          await sdk.mutateWorkspaceSettings({ operationId: "source-policy", mutate: (current) => ({ ...current, author_default: "schema-source-policy" }) });
        }
      } else {
        vi.useFakeTimers({ toFake: ["Date"] });
        const defaultRoot = path.join(context.tempRoot, "default-control");
        await runInit(undefined, { path: defaultRoot }, { defaults: true, agentGuidance: "skip" });
        const raw = await readFile(path.join(defaultRoot, "settings.json"), "utf8");
        for (const pmRoot of [context.pmPath, globalRoot]) {
          const settings = await readSettings(pmRoot);
          await writeWorkspaceJsonWithHistory({ pmRoot, filePath: path.join(pmRoot, "settings.json"), raw,
            op: "settings:write", author: "test-author", lockTtlSeconds: settings.locks.ttl_seconds, lockWaitMs: settings.locks.wait_ms });
        }
      }
      const id = createTestItemId(context, { title: "schema history smoke" });
      const cli = path.resolve("dist/cli.js");
      const script = path.join(context.tempRoot, "schema-audit.mjs");
      await writeFile(script, [
        "import assert from 'node:assert/strict';",
        "import { execFileSync, spawnSync } from 'node:child_process';",
        "import { readFileSync, writeFileSync } from 'node:fs';",
        `import { inspectWorkspaceHistoryState } from ${JSON.stringify(path.resolve("dist/sdk/index.js"))};`,
        `const cli = ${JSON.stringify(cli)};`,
        "for (const root of [process.env.PM_PATH, process.env.PM_GLOBAL_PATH]) {",
        "  const env = { ...process.env, PM_PATH: root };",
        "  const settingsPath = root + '/settings.json';",
        "  const baseline = await inspectWorkspaceHistoryState(root);",
        "  assert.ok(baseline.matching_documents.includes('settings.json'), JSON.stringify(baseline));",
        ...(customPolicy ? ["  assert.equal(JSON.parse(readFileSync(settingsPath)).author_default, 'schema-source-policy');"] : []),
        "  execFileSync(process.execPath, [cli, 'validate', '--check-history-drift', '--strict-exit', '--json'], { env });",
        "  const items = JSON.parse(execFileSync(process.execPath, [cli, 'list', '--all', '--json'], { env, encoding: 'utf8' }));",
        "  assert.equal(items.total, 0);",
        "  const raw = readFileSync(settingsPath, 'utf8');",
        "  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(raw), author_default: 'out-of-band-policy' }));",
        "  const drift = spawnSync(process.execPath, [cli, 'validate', '--check-history-drift', '--strict-exit', '--json'], { env, encoding: 'utf8' });",
        "  assert.notEqual(drift.status, 0);",
        "  assert.deepEqual(JSON.parse(drift.stdout).checks[0].details.workspace_state_mismatches, ['settings.json']);",
        "}",
        "process.stdout.write('schema-audit-pass');",
      ].join("\n"));
      await overwriteTaskTests(context, id, [{ command: `node "${script}"`, pm_context_mode: "schema" }]);
      const sourcePaths = [context.pmPath, globalRoot].flatMap((root) => [path.join(root, "settings.json"), path.join(root, "history", "_workspace.jsonl")]);
      const before = await Promise.all(sourcePaths.map((file) => readFileIfExists(file)));
      const result = await runTest(id, { run: true }, { path: context.pmPath });
      expect(result.run_results[0], JSON.stringify(result.run_results)).toMatchObject({ status: "passed", stdout: "schema-audit-pass" });
      expect(await Promise.all(sourcePaths.map((file) => readFileIfExists(file)))).toEqual(before);
    });
  });
});
