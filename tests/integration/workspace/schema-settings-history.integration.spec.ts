import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExtensionCommandSdk } from "../../../src/sdk/extension-command-context.js";
import { PmClient } from "../../../src/sdk/runtime.js";
import { runTest } from "../../../src/sdk/test/execution.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { overwriteTaskTests } from "../../helpers/pmWorkspace.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("schema linked-test settings audit", () => {
  it("seeds audited project and global settings without items and still rejects sandbox drift", async () => {
    await withTempPmPath(async (context) => {
      const globalRoot = context.env.PM_GLOBAL_PATH!;
      expect(context.runCli(["init", "--pm-path", globalRoot, "--json"]).code).toBe(0);
      for (const pmRoot of [context.pmPath, globalRoot]) {
        const sdk = createExtensionCommandSdk(pmRoot, new PmClient({ pmRoot, noExtensions: true }));
        await sdk.mutateWorkspaceSettings({ operationId: "source-policy", mutate: (current) => ({ ...current, author_default: "schema-source-policy" }) });
      }
      const id = createTestItemId(context, { title: "schema history smoke" });
      const cli = path.resolve("dist/cli.js");
      const script = path.join(context.tempRoot, "schema-audit.mjs");
      await writeFile(script, [
        "import assert from 'node:assert/strict';",
        "import { execFileSync, spawnSync } from 'node:child_process';",
        "import { readFileSync, writeFileSync } from 'node:fs';",
        `const cli = ${JSON.stringify(cli)};`,
        "for (const root of [process.env.PM_PATH, process.env.PM_GLOBAL_PATH]) {",
        "  const env = { ...process.env, PM_PATH: root };",
        "  const settingsPath = root + '/settings.json';",
        "  assert.equal(JSON.parse(readFileSync(settingsPath)).author_default, 'schema-source-policy');",
        "  execFileSync(process.execPath, [cli, 'validate', '--check-history-drift', '--strict-exit', '--json'], { env });",
        "  const items = JSON.parse(execFileSync(process.execPath, [cli, 'list', '--all', '--json'], { env, encoding: 'utf8' }));",
        "  assert.equal(items.total, 0);",
        "  const raw = readFileSync(settingsPath, 'utf8');",
        "  writeFileSync(settingsPath, raw.replace('schema-source-policy', 'out-of-band-policy'));",
        "  const drift = spawnSync(process.execPath, [cli, 'validate', '--check-history-drift', '--strict-exit', '--json'], { env, encoding: 'utf8' });",
        "  assert.notEqual(drift.status, 0);",
        "  assert.deepEqual(JSON.parse(drift.stdout).checks[0].details.workspace_state_mismatches, ['settings.json']);",
        "}",
        "process.stdout.write('schema-audit-pass');",
      ].join("\n"));
      await overwriteTaskTests(context, id, [{ command: `node "${script}"`, pm_context_mode: "schema" }]);
      const sourcePaths = [context.pmPath, globalRoot].flatMap((root) => [path.join(root, "settings.json"), path.join(root, "history", "_workspace.jsonl")]);
      const before = await Promise.all(sourcePaths.map((file) => readFile(file, "utf8")));
      const result = await runTest(id, { run: true }, { path: context.pmPath });
      expect(result.run_results[0], JSON.stringify(result.run_results)).toMatchObject({ status: "passed", stdout: "schema-audit-pass" });
      expect(await Promise.all(sourcePaths.map((file) => readFile(file, "utf8")))).toEqual(before);
    });
  });
});
