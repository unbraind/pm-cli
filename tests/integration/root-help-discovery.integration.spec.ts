import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

type RootHelpPayload = {
  options: Array<{ long: string | null }>;
  subcommands: Array<{ name: string }>;
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
    });
  });
});
