import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("embedded CLI re-entrancy", () => {
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
