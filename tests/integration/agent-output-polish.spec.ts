import { describe, expect, it } from "vitest";
import { PmClient } from "../../src/sdk/index.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("agent output polish", () => {
  it("makes terminal triage compact and keeps full and field projections explicit", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      const { item } = await client.create({ title: "Closed triage", description: "Rich metadata ".repeat(1000), createMode: "progressive" });
      await client.close(item.id, "Verified", { validateClose: "warn" });
      for (const command of [["list-closed"], ["list", "--status", "closed"]]) {
        const result = context.runCli([...command, "--json"], { expectJson: true });
        expect(result.code, result.stderr).toBe(0);
        expect(result.json).toMatchObject({ items: [{ id: item.id, status: "closed" }], projection: { mode: "brief" } });
        expect(result.stdout.length).toBeLessThan(2000);
        const full = context.runCli([...command, "--full", "--json", "--output-budget", "unbounded"], { expectJson: true });
        expect(full.json).toMatchObject({ items: [{ description: item.description }] });
        const fields = context.runCli([...command, "--fields", "id,closed_at", "--json"], { expectJson: true });
        expect(fields.json).toMatchObject({ projection: { mode: "fields" } });
      }
    });
  });

  it("groups field authoring help and keeps recovery tied to actual command contracts", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["schema", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toMatch(/Field options \(add-field\):[\s\S]*--type[\s\S]*--required-types/);
      const typo = context.runCli(["list", "--limti", "1", "--json"], { expectJson: true });
      expect(typo.code).toBe(2);
      expect(typo.stderr).toContain("--limit");
      const unknown = context.runCli(["search", "probe", "--brief", "--json"], { expectJson: true });
      expect(unknown.code).toBe(2);
      expect(JSON.parse(unknown.stderr)).toMatchObject({ recovery: { candidate_commands: expect.arrayContaining(["list", "health"]) } });
    });
  });
});
