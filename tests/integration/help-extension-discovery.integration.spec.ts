import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";

import { writeTestExtension } from "../helpers/extensions.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("standalone full help extension discovery", () => {
  it("discloses typed defaults without dispatch and preserves explicit list overrides (pm-gh1560)", async () => {
    await withTempPmPath(async (context) => {
      const marker = path.join(context.tempRoot, "dispatched");
      const defaults = { name: "agent", count: 0, enabled: false, label: "", scopes: ["seed", "other"] };
      const flags = [
        { long: "--name", value_type: "string", default: defaults.name },
        { long: "--count", value_type: "number", default: defaults.count },
        { long: "--enabled", value_type: "boolean", default: defaults.enabled },
        { long: "--label", value_type: "string", default: defaults.label },
        { long: "--scopes", value_type: "string", list: true, default: defaults.scopes },
      ];
      await writeTestExtension({
        root: context.pmPath, placement: "projectRoot", directory: "defaults-probe",
        manifest: { capabilities: ["commands", "schema"] }, entryFilename: "index.mjs",
        entrySource: `import { writeFileSync } from 'node:fs';
export default { activate(api) {
  api.registerCommand({ name: 'defaults-probe', flags: ${JSON.stringify(flags)},
    run: c => { writeFileSync(${JSON.stringify(marker)}, 'yes'); return c.options; } });
} };`,
      });
      const help = context.runCli(["defaults-probe", "--help"]);
      expect(help.code).toBe(0);
      for (const value of Object.values(defaults)) {
        expect(help.stdout).toContain(`default: ${JSON.stringify(value)}`);
      }
      const machine = context.runCli(["help", "defaults-probe", "--json"], { expectJson: true });
      expect(machine.code).toBe(0);
      expect((machine.json as { options: unknown[] }).options).toEqual(expect.arrayContaining(
        flags.map(flag => expect.objectContaining({ long: flag.long, default_value: flag.default })),
      ));
      const contracts = context.runCli(["contracts", "--command", "defaults-probe", "--flags-only", "--json"], { expectJson: true });
      expect(contracts.code).toBe(0);
      expect((contracts.json as { command_flags: { flags: unknown[] }[] }).command_flags[0].flags).toEqual(expect.arrayContaining(
        flags.map(flag => expect.objectContaining({ flag: flag.long, default: flag.default })),
      ));
      const schema = context.runCli(["contracts", "--command", "defaults-probe", "--runtime-only", "--schema-only", "--json"], { expectJson: true });
      expect(schema.code).toBe(0);
      const branches = (schema.json as { schema: { oneOf: { properties: Record<string, unknown>; "x-extension-command"?: string }[] } }).schema.oneOf;
      const properties = branches.find(branch => branch["x-extension-command"] === "defaults-probe")?.properties;
      for (const [key, value] of Object.entries(defaults)) {
        expect(properties?.[key]).toMatchObject({ default: value });
      }
      expect(existsSync(marker)).toBe(false);
      expect(context.runCli(["defaults-probe", "--json"], { expectJson: true }).json).toMatchObject(defaults);
      const explicit = context.runCli(["defaults-probe", "--name", "human", "--count", "3", "--enabled", "--scopes", "chosen", "--scopes", "last", "--json"], { expectJson: true });
      expect(explicit.code).toBe(0);
      expect(explicit.json).toMatchObject({ name: "human", count: 3, enabled: true, label: "", scopes: ["chosen", "last"] });
    });
  });

  it("registers public extension commands for standalone --all and --explain", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: context.pmPath,
        placement: "projectRoot",
        directory: "context-discovery-help",
        manifest: {
          name: "context-discovery-help",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'context-discovery',",
          "      description: 'Discover extension-owned project context.',",
          "      tier: 'full',",
          "      run: () => ({ ok: true })",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
      });

      for (const flag of ["--all", "--explain"]) {
        const result = context.runCli([flag]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("context-discovery");
      }
    });
  });
});
