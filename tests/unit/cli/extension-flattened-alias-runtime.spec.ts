import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExtensionRoots } from "../../../src/core/extensions/loader.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("flattened extension alias runtime contracts", () => {
  it("shares help flags and option parsing with the canonical nested command", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await writeTestExtension({
        root: roots.project,
        directory: "csv-parity",
        entryFilename: "index.mjs",
        manifest: {
          name: "csv-parity",
          capabilities: ["commands", "importers", "schema"],
        },
        entrySource: `
export default {
  activate(api) {
    api.registerCommand({
      name: "csv export",
      description: "Export workspace items with the canonical contract.",
      flags: [
        { long: "--output", value_name: "file", description: "Output path." },
        { long: "--delimiter", value_name: "char", description: "CSV delimiter." },
      ],
      run(context) {
        return { command: context.command, output: context.options.output };
      },
    });
    api.registerExporter("csv-export", (context) => ({
      command: context.command,
      output: context.options.output,
    }));
  },
};
`,
      });

      const nestedHelp = context.runCli(["csv", "export", "--help"]);
      const aliasHelp = context.runCli([
        "csv-export",
        "export",
        "--help",
      ]);
      expect(nestedHelp.code).toBe(0);
      expect(aliasHelp.code).toBe(0);
      for (const flag of ["--output <file>", "--delimiter <char>"]) {
        expect(nestedHelp.stdout).toContain(flag);
        expect(aliasHelp.stdout).toContain(flag);
      }

      const outputPath = path.join(context.tempRoot, "items.csv");
      const aliasRun = context.runCli(
        [
          "csv-export",
          "export",
          "--output",
          outputPath,
          "--json",
        ],
        { expectJson: true },
      );
      expect(aliasRun.code).toBe(0);
      expect(aliasRun.json).toMatchObject({
        command: "csv-export export",
        output: outputPath,
      });
    });
  });
});
