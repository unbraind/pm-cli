import { describe, expect, it } from "vitest";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

type HelpPayload = {
  subcommands: Array<{ name: string }>;
};

describe("package lifecycle namespace", () => {
  it("keeps only package visible while hidden legacy spellings retain behavior", async () => {
    await withTempPmPath(async (context) => {
      const rootHelp = context.runCli(["--help", "--json"], {
        expectJson: true,
      });
      expect(rootHelp.code).toBe(0);
      const visibleCommands = (rootHelp.json as HelpPayload).subcommands.map(
        ({ name }) => name,
      );
      expect(visibleCommands).not.toContain("extension");
      expect(visibleCommands).not.toContain("install");
      expect(visibleCommands).not.toContain("upgrade");

      const packageHelp = context.runCli(["package", "--help", "--json"], {
        expectJson: true,
      });
      expect(packageHelp.code).toBe(0);
      expect(
        (packageHelp.json as HelpPayload).subcommands.map(({ name }) => name),
      ).toContain("upgrade");

      const canonical = context.runCli([
        "package",
        "upgrade",
        "--packages-only",
        "--dry-run",
        "--json",
      ]);
      const legacy = context.runCli([
        "upgrade",
        "--packages-only",
        "--dry-run",
        "--json",
      ]);
      expect(legacy.code).toBe(canonical.code);
      expect(legacy.stdout).toBe(canonical.stdout);
      expect(legacy.stderr).toContain(
        "Deprecated command `upgrade`; use `pm package upgrade`.",
      );

      const canonicalDoctor = context.runCli([
        "package",
        "doctor",
        "--project",
        "--json",
      ]);
      const legacyDoctor = context.runCli([
        "extension",
        "doctor",
        "--project",
        "--json",
      ]);
      expect(legacyDoctor.code).toBe(canonicalDoctor.code);
      expect(legacyDoctor.stdout).toBe(canonicalDoctor.stdout);
      expect(legacyDoctor.stderr).toContain(
        "Deprecated command `extension`; use `pm package`.",
      );

      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, {
        ...settings,
        ux: {
          ...settings.ux,
          deprecation_hints: false,
        },
      });
      const quietLegacy = context.runCli([
        "upgrade",
        "--packages-only",
        "--dry-run",
        "--json",
      ]);
      expect(quietLegacy.stdout).toBe(canonical.stdout);
      expect(quietLegacy.stderr).not.toContain("Deprecated command");
    });
  });
});
