/** Exercise real runner refusal and owned-child shutdown before temporary checkout disposal. */
import { existsSync, watch } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../helpers/temp.js";
import { createScriptHarness } from "../../helpers/scriptModule.js";

interface RegressionModule {
  /** Run a source-mutated child in a separately owned checkout. */
  runIsolatedRegressionControl(options: {
    sourcePath: string;
    testPath: string;
    testName: string;
    before: string;
    after: string;
  }, negativeControl: boolean): Promise<{ exit_code: number; output: string }>;
}

const harness = createScriptHarness();
const runner = {
  sourcePath: "scripts/run-tests.mjs",
  testPath: "tests/unit/scripts/agent-evidence-consistency-control.spec.ts",
  testName: "owned-control-child",
  before: "#!/usr/bin/env node",
};

describe("isolated regression child ownership", () => {
  it("rejects an actual runner infrastructure exit instead of treating it as a regression verdict", async () => {
    const mod = await harness.importModule<RegressionModule>("scripts/release/isolated-regression-control.mjs");
    await expect(mod.runIsolatedRegressionControl({ ...runner, after: "#!/usr/bin/env node\nprocess.exit(2);" }, true)).rejects.toMatchObject({ code: 2, killed: false });
  });

  it("rejects an invalid source premise before starting a child and releases its registration", async () => {
    const before = process.listeners("SIGTERM");
    const mod = await harness.importModule<RegressionModule>("scripts/release/isolated-regression-control.mjs");
    await expect(mod.runIsolatedRegressionControl({ ...runner, before: "source premise that is deliberately absent", after: "unused" }, true)).rejects.toThrow("source mutant must match exactly once");
    expect(process.listeners("SIGTERM")).toEqual(before);
  });

  // Windows cannot deliver Unix signal handlers; its runner exits are covered above and in platform CI.
  it.skipIf(process.platform === "win32").each([
    { mode: "responsive", exitCode: 0 },
    { mode: "responsive", exitCode: 1 },
    { mode: "unresponsive", exitCode: 0 },
  ])("keeps the checkout until a $mode child closes with $exitCode", async ({ mode, exitCode }) => {
    await withTempDir("pm-control-shutdown-", async (parent) => {
      const signals = path.join(parent, "signals");
      await mkdir(signals);
      process.env.TMPDIR = parent;
      const mod = await harness.importModule<RegressionModule>("scripts/release/isolated-regression-control.mjs");
      const before = new Set(process.listeners("SIGTERM"));
      const watcher = watch(signals);
      const ready = new Promise<void>((resolve, reject) => {
        watcher.on("error", reject);
        watcher.on("change", (_event, filename) => { if (String(filename) === "ready.json") resolve(); });
      });
      const source = `#!/usr/bin/env node
import * as fixtureFs from 'node:fs';
const fixtureRoot = process.cwd();
const fixtureSignals = ${JSON.stringify(signals)};
console.log(${JSON.stringify(runner.testName)});
fixtureFs.writeFileSync(fixtureSignals + '/ready.tmp', JSON.stringify({ root: fixtureRoot }));
fixtureFs.renameSync(fixtureSignals + '/ready.tmp', fixtureSignals + '/ready.json');
process.on('SIGTERM', () => {
  if (${JSON.stringify(mode)} === 'unresponsive') return;
  fixtureFs.writeFileSync(fixtureSignals + '/stopped.json', JSON.stringify({ phase: 'signal', root_exists: fixtureFs.existsSync(fixtureRoot) }));
  process.exit(${exitCode});
});
setTimeout(() => {
  fixtureFs.writeFileSync(fixtureSignals + '/stopped.json', JSON.stringify({ phase: 'fallback', root_exists: fixtureFs.existsSync(fixtureRoot) }));
  process.exit(0);
}, ${mode === "unresponsive" ? 7000 : 3000});
await new Promise(() => {});
`;
      const completion = mod.runIsolatedRegressionControl({ ...runner, after: source }, true)
        .then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
      try {
        await Promise.race([ready, completion.then(() => { throw new Error("Child closed before readiness"); })]);
        watcher.close();
        const { root } = JSON.parse(await readFile(path.join(signals, "ready.json"), "utf8")) as { root: string };
        vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit:${code}`); });
        const onSignal = process.listeners("SIGTERM").find((listener) => !before.has(listener)) as (signal: string) => Promise<void>;
        await expect(onSignal("SIGTERM")).rejects.toThrow("exit:143");
        expect(existsSync(root)).toBe(mode === "unresponsive");
        const result = await completion;
        expect(JSON.parse(await readFile(path.join(signals, "stopped.json"), "utf8"))).toEqual({ phase: mode === "unresponsive" ? "fallback" : "signal", root_exists: true });
        expect(existsSync(root)).toBe(false);
        if (exitCode === 1) expect(result.error).toMatchObject({ code: 1, killed: true });
        else expect(result.value).toMatchObject({ exit_code: 0 });
      } finally {
        watcher.close();
        await completion;
      }
    });
  }, 30_000);
});
