import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

async function installStrictFlagsExtension(context: TempPmContext, flags: string): Promise<void> {
  const extensionDir = path.join(context.pmPath, "extensions", "strict-flags-ext");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    path.join(extensionDir, "manifest.json"),
    `${JSON.stringify({ name: "strict-flags-ext", version: "1.0.0", entry: "./index.mjs", capabilities: ["commands", "schema"] }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(extensionDir, "index.mjs"),
    [
      "export default {",
      "  activate(api) {",
      `    api.registerFlags("acme echo", ${flags});`,
      "    api.registerCommand({ name: 'acme echo', run: (context) => ({ ok: true, args: context.args, options: context.options }) });",
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("extension flag value validation (pm-extension-scalar-validation)", () => {
  it("refuses malformed strict scalars before the handler runs while preserving valid coercion and switch grammar", async () => {
    await withTempPmPath(async (context) => {
      await installStrictFlagsExtension(
        context,
        JSON.stringify([
          { long: "--limit", value_type: "number", value_validation: "strict" },
          { long: "--enabled", type: "bool", value_validation: "strict" },
          { long: "--verbose", value_type: "boolean", value_validation: "strict" },
          { long: "--ratio", value_type: "number" },
          { long: "--ids", value_type: "number", list: true, value_validation: "strict" },
          { long: "--choices", short: "-c", value_type: "boolean", list: true, value_validation: "strict" },
          { long: "--toggles", short: "-t", value_type: "boolean", list: true, repeatable: true, value_validation: "strict" },
        ]),
      );
      const valid = context.runCli(
        ["acme", "echo", "--limit", "5", "--enabled", "true", "--verbose", "--ratio", "abc", "--ids", "1,2", "artifact-A", "--json"],
        { expectJson: true },
      );
      expect(valid.code).toBe(0);
      expect(valid.json).toMatchObject({
        ok: true,
        args: ["artifact-A"],
        options: { limit: 5, enabled: true, verbose: true, ratio: "abc", ids: [1, 2] },
      });
      const bareBool = context.runCli(["acme", "echo", "--enabled", "--json"], { expectJson: true });
      expect(bareBool.json).toMatchObject({ options: { enabled: true } });
      const validLists = context.runCli(["acme", "echo", "--choices=true,false", "--toggles=true", "--toggles=false", "--json"], { expectJson: true });
      expect(validLists.code).toBe(0);
      expect(validLists.json).toMatchObject({ options: { choices: [true, false], toggles: [true, false] } });

      for (const [args, code, fragment] of [
        [["--limit", "abc"], "extension_flag_value_invalid", "expects a finite number; received"],
        [["--enabled", "not-a-boolean"], "extension_flag_value_invalid", "expects true, false, 1, or 0"],
        [["--ids", "1,x"], "extension_flag_value_invalid", "expects a finite number; received"],
        [["--choices=maybe"], "extension_flag_value_invalid", "expects true, false, 1, or 0"],
        [["--choices=true,maybe"], "extension_flag_value_invalid", "received \"maybe\""],
        [["--toggles=true", "--toggles=maybe"], "extension_flag_value_invalid", "received \"maybe\""],
      ] as const) {
        const refused = context.runCli(["acme", "echo", ...args, "--json"]);
        expect(refused.code).toBe(2);
        const refusal = JSON.parse(refused.stderr) as { code: string; detail: string };
        expect(refusal.code).toBe(code);
        expect(refusal.detail).toContain(fragment);
        expect(refusal.detail).toContain("for extension command 'acme echo'");
      }
    });
  });

  it("keeps the compatible passthrough default and refuses contradictory policies at activation", async () => {
    await withTempPmPath(async (context) => {
      await installStrictFlagsExtension(context, JSON.stringify([{ long: "--limit", value_type: "number" }]));
      const passthrough = context.runCli(["acme", "echo", "--limit", "abc", "--json"], { expectJson: true });
      expect(passthrough.code).toBe(0);
      expect(passthrough.json).toMatchObject({ options: { limit: "abc" } });
    });
    await withTempPmPath(async (context) => {
      await installStrictFlagsExtension(context, JSON.stringify([{ long: "--name", value_type: "string", value_validation: "strict" }]));
      const doctor = context.runCli(["package", "doctor", "--project", "--json"], { expectJson: true });
      expect((doctor.json as { warnings: string[] }).warnings).toContain("extension_activate_failed:project:strict-flags-ext");
      const inactive = context.runCli(["acme", "echo", "--json"]);
      expect(inactive.code).toBe(2);
      expect(inactive.stderr).toContain("unknown_command");
    });
  });
});
