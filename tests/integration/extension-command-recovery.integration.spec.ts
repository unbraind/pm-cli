import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeTestExtension } from "../helpers/extensions.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("extension command activation recovery", () => {
  it("leads with the declared extension failure before generic typo guidance", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "broken-command-package",
        manifest: {
          name: "broken-command-package",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: ["commands"],
          activation: { commands: ["broken ping"] },
          contributions: {
            schema_version: 1,
            commands: ["broken ping"],
            command_handlers: ["broken ping"],
          },
        },
        entryFilename: "index.mjs",
        entrySource:
          'import "missing-extension-runtime-dependency";\nexport default { activate() {} };\n',
      });
      const completed = spawnSync(
        process.execPath,
        [
          path.resolve(process.cwd(), "dist", "cli.js"),
          "broken",
          "ping",
        ],
        {
          cwd: process.cwd(),
          env: context.env,
          encoding: "utf8",
        },
      );
      expect(completed.status).not.toBe(0);
      expect(completed.stderr).toMatch(
        /^Extension command unavailable: project:broken-command-package/m,
      );
      expect(completed.stderr).toContain(
        "missing-extension-runtime-dependency",
      );
      expect(completed.stderr).toContain(
        "pm package doctor --project --detail deep",
      );
      expect(completed.stderr.indexOf("Extension command unavailable")).toBeLessThan(
        completed.stderr.indexOf("Unknown command"),
      );

      const structured = spawnSync(
        process.execPath,
        [
          path.resolve(process.cwd(), "dist", "cli.js"),
          "broken",
          "ping",
          "--json",
        ],
        {
          cwd: process.cwd(),
          env: context.env,
          encoding: "utf8",
        },
      );
      expect(structured.status).not.toBe(0);
      expect(JSON.parse(structured.stderr)).toMatchObject({
        extension_command_failure: {
          code: "extension_command_activation_failed",
          extension: "broken-command-package",
          layer: "project",
        },
      });
    });
  });
});
