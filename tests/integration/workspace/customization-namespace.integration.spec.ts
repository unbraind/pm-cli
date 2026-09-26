/** @module tests/integration/workspace-customization-namespace
 * Proves canonical customization commands retain persistent SDK behavior and compatibility.
 */
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("workspace customization namespace", () => {
  it("preserves aliases, schema mutations, configuration and orientation", async () => {
    await withTempPmPath(async (context) => {
      context.env.PM_CLOCK = "2026-09-26T00:00:00.000Z";
      context.env.PM_CLOCK_TICK_MS = "0";
      context.env.PM_SEED = "workspace-customization";
      for (const args of [
        ["init", "--defaults"],
        ["config", "project", "set", "ux_deprecation_hints", "false"],
        ["schema", "add-type", "Specimen", "--description", "A tracked research specimen"],
      ]) {
        const result = context.runCli(["workspace", ...args, "--json"], { expectJson: true });
        expect(result.code, result.stderr).toBe(0);
      }
      for (const args of [["config", "project", "get", "ux_deprecation_hints"], ["schema", "show", "Specimen"], ["profile", "list"]]) {
        const canonical = context.runCli(["workspace", ...args, "--json"], { expectJson: true });
        const legacy = context.runCli([...args, "--json"], { expectJson: true });
        expect(canonical.code, canonical.stderr).toBe(0);
        expect(legacy.code, legacy.stderr).toBe(0);
        expect(canonical.json).toEqual(legacy.json);
      }
      const created = context.runCli(["create", "Specimen", "Namespace specimen", "--json"], { expectJson: true });
      expect(created.code, created.stderr).toBe(0);
      const rootHelp = context.runCli(["--help", "--json"], { expectJson: true });
      expect(rootHelp.json).toMatchObject({ subcommands: expect.arrayContaining([expect.objectContaining({ name: "workspace" })]) });
      const help = context.runCli(["workspace", "--help", "--json"], { expectJson: true });
      expect(help.code, help.stderr).toBe(0);
      expect(help.json).toMatchObject({ subcommands: expect.arrayContaining(["init", "config", "schema", "profile"].map((name) => expect.objectContaining({ name }))) });
      for (const args of [["context", "--for", "orient"], ["contracts", "--command", "workspace schema", "--flags-only"]]) {
        const result = context.runCli([...args, "--json"], { expectJson: true });
        expect(result.code, result.stderr).toBe(0);
      }
    });
  });
});
