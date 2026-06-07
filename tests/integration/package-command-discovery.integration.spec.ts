import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("package command discovery integration", () => {
  it("reports exported command paths after fresh package install and invokes them immediately", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "sample-package");
      const extensionDir = path.join(sourceDir, "extensions", "sample-package");
      await mkdir(extensionDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "package.json"),
        `${JSON.stringify({ name: "sample-package-bundle", version: "1.0.0", pm: { extensions: ["extensions"] } }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify({ name: "sample-package", version: "1.0.0", entry: "index.js", capabilities: ["commands"] }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(extensionDir, "index.js"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'sample package ping',",
          "      run: () => ({ ok: true, marker: 'sample-package-ping' })",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const install = context.runCli(["install", sourceDir, "--json"], { expectJson: true });
      expect(install.code).toBe(0);
      expect(install.json).toMatchObject({
        action: "install",
        details: {
          extension: { name: "sample-package" },
          activated: true,
          command_discovery: {
            package_name: "sample-package",
            extension_name: "sample-package",
            command_paths: ["sample package ping"],
            help_commands: ["pm sample package ping --help"],
          },
        },
      });

      const invoked = context.runCli(["sample", "package", "ping", "--json"], { expectJson: true });
      expect(invoked.code).toBe(0);
      expect(invoked.json).toMatchObject({ ok: true, marker: "sample-package-ping" });
    });
  });
});
