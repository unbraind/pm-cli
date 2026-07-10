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
          verification: {
            status: "ok",
            target_pm_root: context.pmPath,
            activated: true,
            registered_commands: ["sample package ping"],
            health: { status: "ok", blocking_failure_count: 0 },
          },
        },
      });

      const invoked = context.runCli(["sample", "package", "ping", "--json"], { expectJson: true });
      expect(invoked.code).toBe(0);
      expect(invoked.json).toMatchObject({ ok: true, marker: "sample-package-ping" });
    });
  });

  it("returns a non-zero exit and coherent diagnostics when installed code cannot load", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "broken-package");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify({ name: "broken-package", version: "1.0.0", entry: "index.js", capabilities: ["commands"] }),
        "utf8",
      );
      await writeFile(
        path.join(sourceDir, "index.js"),
        'throw new Error("Cannot find package \'@unbrained/pm-cli\' imported from extension");\n',
        "utf8",
      );

      const install = context.runCli(["install", sourceDir, "--json"], { expectJson: true });
      expect(install.code).toBe(1);
      expect(install.json).toMatchObject({
        ok: false,
        details: {
          activated: false,
          runtime_activation_status: "failed",
          command_discovery: { sdk_dependency_status: "missing" },
          verification: { status: "degraded", health: { blocking_failure_count: 1 } },
        },
      });
    });
  });
});
