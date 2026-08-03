import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderContextMarkdown,
  runContext,
} from "../../../src/sdk/query/context.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("context extension health", () => {
  it("reports static package health without importing modules and supports opt-out", async () => {
    await withTempPmPath(async (context) => {
      const empty = await runContext(
        { depth: "brief" },
        { path: context.pmPath },
      );
      expect(empty).not.toHaveProperty("extension_health");

      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "healthy-context-package",
        manifest: {
          name: "healthy-context-package",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: ["commands"],
          contributions: {
            schema_version: 1,
            commands: ["healthy ping"],
            command_handlers: ["healthy ping"],
          },
        },
        entryFilename: "index.mjs",
        entrySource: "throw new Error('context health must not import extension modules');\n",
      });
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "degraded-context-package",
        manifest: {
          name: "degraded-context-package",
          version: "1.0.0",
          entry: "missing.mjs",
          capabilities: ["commands"],
        },
        entryFilename: "unused.mjs",
        entrySource: "export default {};\n",
      });

      const result = await runContext(
        { depth: "brief" },
        { path: context.pmPath },
      );
      expect(result.extension_health).toEqual({
        total: 2,
        ok: 1,
        degraded: 1,
        packages: [
          { name: "degraded-context-package", status: "degraded" },
          { name: "healthy-context-package", status: "ok" },
        ],
      });
      expect(renderContextMarkdown(result)).toContain(
        "- extensions: 1 ok, 1 degraded (degraded-context-package)",
      );
      expect(
        renderContextMarkdown({
          ...result,
          extension_health: {
            total: 1,
            ok: 1,
            degraded: 0,
            packages: [{ name: "healthy-context-package", status: "ok" }],
          },
        }),
      ).toContain("- extensions: 1 ok, 0 degraded\n");

      const suppressed = await runContext(
        { depth: "brief", noExtensionHealth: true },
        { path: context.pmPath },
      );
      expect(suppressed).not.toHaveProperty("extension_health");

      await Promise.all(
        Array.from({ length: 21 }, (_, index) =>
          fs.mkdir(
            path.join(
              context.pmPath,
              "extensions",
              `missing-manifest-${String(index).padStart(2, "0")}`,
            ),
            { recursive: true },
          ),
        ),
      );
      const bounded = await runContext(
        { depth: "brief" },
        { path: context.pmPath },
      );
      expect(bounded.extension_health).toMatchObject({
        total: 23,
        ok: 1,
        degraded: 22,
        truncated: true,
      });
      expect(bounded.extension_health?.packages).toHaveLength(20);
      expect(bounded.extension_health?.packages[0]).toEqual({
        name: "degraded-context-package",
        status: "degraded",
      });
    });
  });
});
