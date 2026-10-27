import { describe, expect, it } from "vitest";
import { PmClient } from "../../../../src/sdk/runtime.js";
import { isPmCliExpectedError } from "../../../../src/sdk/errors.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("producer-owned SDK refusal parity (pm-gh1613)", () => {
  it("preserves validation facts, active status domains and lookup identity across SDK and CLI", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      await client.schemaAddStatus("reviewing", { role: ["active"] });
      const { item } = await client.create({ type: "Task", title: "Refusal parity", createMode: "progressive" });
      const before = await client.get(item.id);
      const fixtures = [
        { run: () => client.update(item.id, { status: "doing" }), args: ["update", item.id, "--status", "doing"], code: "invalid_argument_value", facts: { field: "status", value: "doing", allowed: expect.arrayContaining(["open", "reviewing"]) } },
        { run: () => client.create({ type: "Task", title: "Invalid status", status: "doing", createMode: "progressive" }), args: ["create", "--type", "Task", "--title", "Invalid status", "--status", "doing", "--create-mode", "progressive"], code: "invalid_argument_value", facts: { field: "status", value: "doing", allowed: expect.arrayContaining(["reviewing"]) } },
        { run: () => client.update(item.id, { priority: 9 }), args: ["update", item.id, "--priority", "9"], code: "invalid_argument_value", facts: { field: "priority", value: "9", allowed: expect.arrayContaining(["0", "4", "critical", "minimal"]) } },
        { run: () => client.create({ type: "Task", title: "Invalid priority", priority: "urgent", createMode: "progressive" }), args: ["create", "--type", "Task", "--title", "Invalid priority", "--priority", "urgent", "--create-mode", "progressive"], code: "invalid_argument_value", facts: { field: "priority", value: "urgent", allowed: expect.arrayContaining(["high"]) } },
        { run: () => client.get("pm-nope"), args: ["get", "pm-nope"], code: "item_not_found", facts: { id: "pm-nope" } },
        { run: () => client.update("pm-nope", { title: "Missing" }), args: ["update", "pm-nope", "--title", "Missing"], code: "item_not_found", facts: { id: "pm-nope" } },
      ];
      for (const fixture of fixtures) {
        const error: unknown = await fixture.run().catch((caught: unknown) => caught);
        expect(isPmCliExpectedError(error)).toBe(true);
        if (!isPmCliExpectedError(error)) throw new Error("Expected a public SDK refusal");
        expect(error.code).toBe(fixture.code);
        expect(error.context).toMatchObject({ code: fixture.code, ...fixture.facts });
        expect(error.message).not.toContain("--status");
        const cli = context.runCli([...fixture.args, "--json"], { expectJson: true });
        expect(cli.code).toBe(error.exitCode);
        expect(JSON.parse(cli.stderr)).toMatchObject({ code: error.code, exit_code: error.exitCode });
      }
      expect(await client.get(item.id)).toEqual(before);
      const custom = await client.update(item.id, { status: "reviewing" });
      expect(custom.item.status).toBe("reviewing");
    });
  });
});
