import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("CLI help runtime coverage (sandboxed)", () => {
  it("describes top-level help as a universal extensible CLI", async () => {
    await withTempPmPath(async (context) => {
      const compactHelp = context.runCli(["--help"]);
      expect(compactHelp.code).toBe(0);
      expect(compactHelp.stdout.replaceAll(/\s+/g, " ").trim()).toContain(
        "Universal, flexible, extensible, agent-optimized project management CLI for any project or programming language.",
      );
      expect(compactHelp.stdout).toContain("Intent:");
      expect(compactHelp.stdout).toContain("Need deeper rationale and more examples?");
      expect(compactHelp.stdout).toContain("Re-run with --explain.");

      const detailedHelp = context.runCli(["--help", "--explain"]);
      expect(detailedHelp.code).toBe(0);
      expect(detailedHelp.stdout).toContain("Why use this command:");
      expect(detailedHelp.stdout).toContain("Examples:");
      expect(detailedHelp.stdout).toContain("Tips:");
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

  it("renders structured usage guidance for missing required options", async () => {
    await withTempPmPath(async (context) => {
      const usage = context.runCli(["create", "--title", "Only title", "--description", "Only description", "--json"]);
      expect(usage.code).toBe(2);
      const envelope = JSON.parse(usage.stderr) as {
        type: string;
        code: string;
        title: string;
        detail: string;
        required: string;
        exit_code: number;
        examples?: string[];
        next_steps?: string[];
      };
      expect(envelope).toMatchObject({
        type: "urn:pm-cli:error:missing_required_option",
        code: "missing_required_option",
        title: "Missing required option --type <value>",
        exit_code: 2,
      });
      expect(envelope.detail).toContain("--type <value>");
      expect(envelope.required).toContain("Pass --type <value>");
      expect(envelope.examples?.length ?? 0).toBeGreaterThan(0);
      expect(envelope.next_steps?.length ?? 0).toBeGreaterThan(0);
    });
  });
});
