import path from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { _testOnly } from "../../../src/cli/main.js";
import {
  applyReadOutputIncludeModes,
  resolveReadOutputDimensions,
} from "../../../src/sdk/read-output-contracts.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("embedded CLI re-entrancy", () => {
  it("retains only caller-supplied legacy aliases across Commander defaults", () => {
    const root = new Command();
    const deps = root.command("deps");
    (root as Command & { rawArgs: string[] }).rawArgs = [
      "node",
      "pm",
      "deps",
      "pm-1",
      "--full",
      "--output-include",
      "full",
    ];
    const options: Record<string, unknown> = {
      collapse: "none",
      full: true,
    };
    _testOnly.recordCliReadOutputInvocationProvenance(
      deps,
      "deps",
      options,
    );
    applyReadOutputIncludeModes("deps", "full", options);
    expect(resolveReadOutputDimensions("deps", options)).toMatchObject({
      legacy_aliases_used: ["--full"],
      migration_hints: [
        "--full is a compatibility alias; prefer --output-include full.",
      ],
    });
  });

  it("does not leak extension flags between sequential worker invocations", async () => {
    await withTempPmPath(async (first) => {
      await writeTestExtension({
        root: path.join(first.pmPath, "extensions"),
        directory: "reentrant-list-flags",
        manifest: {
          name: "reentrant-list-flags",
          capabilities: ["schema"],
          activation: { commands: ["list"] },
          entry: "./index.mjs",
        },
        entryFilename: "index.mjs",
        entrySource: `
export default {
  activate(api) {
    api.registerFlags("list", [
      { long: "--workspace-note", value_name: "text", description: "Workspace-local note" }
    ]);
  }
};
`,
      });

      const enhanced = await first.runCliInProcess([
        "list",
        "--workspace-note",
        "first",
      ]);
      expect(enhanced.code).toBe(0);
    });

    await withTempPmPath(async (second) => {
      const isolated = await second.runCliInProcess(["list", "--type", "Task"]);
      expect(isolated.code).toBe(0);
      expect(isolated.stderr).not.toContain("--workspace-note");
    });
  });
});
