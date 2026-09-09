import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskFixture } from "../helpers/createTaskFixture.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import { runPmCli } from "../../src/cli/main.js";
import { runInProcessDistCli } from "../helpers/cliRunner.js";

describe("native context and operations namespaces", () => {
  it("suppresses alias guidance for native, machine-readable, quiet, and configured invocations", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, "pm-hint-target", "Alias hint target");
      for (const command of ["next", "stats"]) {
        const hinted = await runInProcessDistCli([command], { env: context.env }, runPmCli);
        expect(hinted.code, hinted.stderr).toBe(0);
        expect(hinted.stderr).toContain(`Command \`${command}\` is an alias`);
      }
      for (const args of [["context", "focus", "--id", "pm-hint-target"], ["fetch", "pm-hint-target"], ["next", "--json"], ["next", "--quiet"]]) {
        const result = await runInProcessDistCli(args, { env: context.env }, runPmCli);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).not.toContain("is an alias");
      }
      const settings = await readSettings(context.pmPath);
      settings.ux = { ...settings.ux, deprecation_hints: false };
      await writeSettings(context.pmPath, settings);
      const suppressed = await runInProcessDistCli(["next"], { env: context.env }, runPmCli);
      expect(suppressed.code, suppressed.stderr).toBe(0);
      expect(suppressed.stderr).not.toContain("is an alias");
    });
  });
  it("preserves real read results, focus persistence, history events, and default context", async () => {
    await withTempPmPath(async (context) => {
      context.env.PM_CLOCK = "2026-09-09T00:00:00.000Z";
      context.env.PM_CLOCK_TICK_MS = "0";
      context.env.PM_SEED = "context-ops-namespace";
      createTaskFixture(context, "pm-native-navigation", "Namespace acceptance fixture");
      for (const [noun, verb, args] of [
        ["context", "next", ["--limit", "1"]],
        ["context", "focus", []],
        ["ops", "stats", []],
        ["ops", "validate", ["--check-history-drift"]],
        ["history", "events", ["--limit", "1"]],
      ] as const) {
        const native = context.runCli([noun, verb, ...args, "--json"], { expectJson: true });
        const legacy = context.runCli([verb, ...args, "--json"], { expectJson: true });
        expect(native.code, native.stderr).toBe(0);
        expect(legacy.code, legacy.stderr).toBe(0);
        expect(native.json).toEqual(legacy.json);
      }
      const focused = context.runCli(["context", "focus", "--id", "pm-native-navigation", "--json"], { expectJson: true });
      expect(focused.code, focused.stderr).toBe(0);
      expect(context.runCli(["context", "--limit", "1", "--json"]).code).toBe(0);
      expect(context.runCli(["context", "focus", "--clear", "--json"]).code).toBe(0);
      const globals = context.runCli(["--json", "ops", "--quiet", "stats"]);
      expect(globals.code, globals.stderr).toBe(0);
      for (const [noun, leaves] of [["context", ["focus", "next"]], ["ops", ["gc", "health", "stats", "validate", "telemetry", "eval", "test-all"]], ["history", ["events"]]] as const) {
        const help = context.runCli([noun, "--help"]);
        expect(help.code, help.stderr).toBe(0);
        for (const leaf of leaves) expect(help.stdout).toMatch(new RegExp(`^  ${leaf}(?:\\s|\\[|\\()`, "m"));
      }
    });
  });
  it("activates package-owned maintenance commands at native and compatibility paths", async () => {
    await withTempPmPath(async (context) => {
      const source = path.join(context.tempRoot, "maintenance-provider");
      await mkdir(source);
      await writeFile(path.join(source, "manifest.json"), JSON.stringify({ name: "maintenance-provider", version: "1.0.0", entry: "index.js", capabilities: ["commands"] }));
      await writeFile(path.join(source, "index.js"), `export default { activate(api) {
        for (const name of ["normalize", "reindex"]) api.registerCommand({ name, run: () => ({ provider: "maintenance-provider", operation: name }) });
      } };`);
      const missing = context.runCli(["contracts", "--command", "ops reindex", "--availability-only", "--json"], { expectJson: true });
      expect(missing.code, missing.stderr).toBe(0);
      expect(missing.json).toMatchObject({ action_availability: [expect.objectContaining({ action: "reindex", available: false, disabled_reason: expect.stringContaining("optional") })] });
      for (const [command, packageName] of [["normalize", "audit"], ["reindex", "search-advanced"]]) {
        const missingHelp = await runInProcessDistCli(["ops", command, "--help", "--json"], { env: context.env }, runPmCli);
        expect(missingHelp.code).toBe(2);
        expect(JSON.parse(missingHelp.stderr)).toMatchObject({
          code: "unknown_command",
          examples: expect.arrayContaining([`pm install ${packageName}`]),
        });
      }
      const install = context.runCli(["package", "install", source, "--json"], { expectJson: true });
      expect(install.code, install.stderr).toBe(0);
      for (const command of ["normalize", "reindex"]) {
        for (const prefix of [[], ["ops"]]) {
          const invoked = context.runCli([...prefix, command, "--json"], { expectJson: true });
          expect(invoked.code, invoked.stderr).toBe(0);
          expect(invoked.json).toMatchObject({ provider: "maintenance-provider", operation: command });
          const help = context.runCli([...prefix, command, "--help", "--json"], { expectJson: true });
          expect(help.code, help.stderr).toBe(0);
        }
        const contracts = context.runCli(["contracts", "--command", `ops ${command}`, "--availability-only", "--json"], { expectJson: true });
        expect(contracts.code, contracts.stderr).toBe(0);
        expect(contracts.json).toMatchObject({ action_availability: [expect.objectContaining({ action: command, available: true })] });
        const fullContracts = context.runCli(["contracts", "--command", `ops ${command}`, "--full", "--json"], { expectJson: true });
        expect(fullContracts.code, fullContracts.stderr).toBe(0);
        expect(fullContracts.json).toMatchObject({ extension_commands: [expect.objectContaining({ command })] });
      }
    });
  });

});
