import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  initializeCustomTool,
  runCustomToolDemo,
} from "../../packages/sdk-tool/index.mjs";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("SDK-only custom tool exemplar", () => {
  it("initializes a standalone tracker through the public SDK", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-sdk-tool-init-"));
    const pmRoot = path.join(tempRoot, ".agents", "pm");

    try {
      await expect(initializeCustomTool(pmRoot)).resolves.toMatchObject({
        ok: true,
      });
      await expect(fs.stat(path.join(pmRoot, "settings.json"))).resolves.toBeDefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs a complete customizable lifecycle without CLI implementation imports", async () => {
    await withTempPmPath(async (context) => {
      await fs.writeFile(
        path.join(context.tempRoot, "README.md"),
        "# SDK custom tool fixture\n",
        "utf8",
      );

      const result = await runCustomToolDemo({
        pmRoot: context.pmPath,
        artifactPath: "README.md",
      });

      expect(result).toMatchObject({
        listed: 2,
        searched: 2,
        contextItems: 2,
        validationOk: true,
        healthOk: true,
      });
      expect(result.relationshipEdges).toBeGreaterThanOrEqual(2);

      const parent = context.runCli(["get", result.parentId, "--json"], {
        expectJson: true,
      });
      const child = context.runCli(["get", result.childId, "--json"], {
        expectJson: true,
      });
      expect(parent.json).toMatchObject({
        item: { status: "closed", type: "WorkUnit" },
      });
      expect(child.json).toMatchObject({
        item: { status: "closed", type: "WorkUnit", parent: result.parentId },
      });
    });
  });
});
