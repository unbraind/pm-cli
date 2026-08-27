import { describe, expect, it } from "vitest";

import { writeTestExtension } from "../helpers/extensions.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("standalone full help extension discovery", () => {
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
