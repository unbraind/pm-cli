import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

type RootHelpPayload = {
  options: Array<{ long: string | null }>;
  subcommands: Array<{ name: string }>;
  command_aliases?: Array<{
    alias: string;
    canonical: string;
    available: boolean;
  }>;
  omission_receipt?: {
    omitted_field_groups: Array<{ name: string; restore_with: string }>;
  };
};

describe("root help discovery", () => {
  it("advertises --all and expands the process-level command inventory", async () => {
    await withTempPmPath(async (context) => {
      const compact = context.runCli(["--help", "--json"], {
        expectJson: true,
      });
      const expanded = context.runCli(["--all", "--help", "--json"], {
        expectJson: true,
      });
      const compactPayload = compact.json as RootHelpPayload;
      const expandedPayload = expanded.json as RootHelpPayload;

      expect(compact.code).toBe(0);
      expect(expanded.code).toBe(0);
      expect(compactPayload.options).toContainEqual(
        expect.objectContaining({ long: "--all" }),
      );
      expect(compactPayload.subcommands).not.toContainEqual(
        expect.objectContaining({ name: "graph" }),
      );
      expect(compactPayload.subcommands).not.toContainEqual(
        expect.objectContaining({ name: "history" }),
      );
      expect(expandedPayload.subcommands.length).toBeGreaterThan(
        compactPayload.subcommands.length,
      );
      expect(expandedPayload.subcommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "graph" }),
          expect.objectContaining({ name: "history" }),
        ]),
      );
      expect(
        compactPayload.omission_receipt?.omitted_field_groups,
      ).toContainEqual({
        name: "command_aliases",
        restore_with: "--all",
      });
      expect(expandedPayload.command_aliases?.length).toBeGreaterThan(70);
      for (const alias of expandedPayload.command_aliases ?? []) {
        if (!alias.available) continue;
        const help = context.runCli(
          ["help", ...alias.alias.split(" "), "--json"],
          {
            expectJson: true,
          },
        );
        expect(help.code, alias.alias).toBe(0);
        expect(help.json?.resolved_path, alias.alias).toBe(alias.canonical);
      }
    });
  });
});
