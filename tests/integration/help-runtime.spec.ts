import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("CLI help runtime coverage (sandboxed)", () => {
  it("describes top-level help as a universal extensible CLI", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout.replaceAll(/\s+/g, " ").trim()).toContain(
        "Universal, flexible, extensible, agent-optimized project management CLI for any project or programming language.",
      );
    });
  });

  it("describes reindex help text as keyword plus semantic and hybrid capable", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["reindex", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("Rebuild search artifacts for keyword, semantic, and hybrid modes.");
      expect(help.stdout).toContain("Reindex mode: keyword|semantic|hybrid");
    });
  });

  it("describes include-linked help text as keyword and hybrid lexical scoring", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["search", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout.replaceAll(/\s+/g, " ").trim()).toContain(
        "Include readable linked docs/files/tests content in keyword and hybrid lexical scoring",
      );
    });
  });
});
