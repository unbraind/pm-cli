import { describe, expect, it } from "vitest";
import { _testOnlyUpdateCommand, parseDependencyAdditions } from "../../../../src/sdk/lifecycle/update.js";
import { ensureEnumValue } from "../../../../src/sdk/lifecycle/recurrence-parsers.js";
import { DEPENDENCY_KIND_VALUES } from "../../../../src/types/index.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("enum constraint recovery", () => {
  it("separates the stored field key from its readable dependency label", () => {
    expect(() => parseDependencyAdditions(["id=pm-target,kind=invalid"], "pm", "2026-09-08T00:00:00.000Z", "writer")).toThrow(expect.objectContaining({
      context: expect.objectContaining({ field: "kind", required: expect.stringContaining("dependency kind") }),
    }));
    expect(() => _testOnlyUpdateCommand.parseDependencyRemovals(["id=pm-target,kind=invalid"], "pm")).toThrow(expect.objectContaining({
      context: expect.objectContaining({ field: "kind", required: expect.stringContaining("dependency kind") }),
    }));
    expect(() => ensureEnumValue("invalid", ["low", "high"], "risk")).toThrow(expect.objectContaining({
      context: expect.objectContaining({ field: "risk" }),
    }));
  });
  it("preserves dependency kind guidance in text and JSON without changing the item", async () => {
    await withTempPmPath(async ({ runCli }) => {
      const created = runCli(["create", "Constraint fixture", "--json"], { expectJson: true });
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      const before = runCli(["get", id, "--depth", "full", "--json"], { expectJson: true });
      for (const json of [false, true]) {
        const result = runCli([
          "update", id, "--dep", `id=${id},kind=relates_to`, ...(json ? ["--json"] : []),
        ]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("dependency kind");
        expect(result.stderr).toContain(DEPENDENCY_KIND_VALUES.join(", "));
        if (json) expect(JSON.parse(result.stderr)).toMatchObject({ required: `dependency kind must be one of: ${DEPENDENCY_KIND_VALUES.join(", ")}.` });
      }
      for (const args of [
        ["create", "Invalid dependency", "--dep", `id=${id},kind=relates_to`],
        ["update", id, "--dep-remove", `id=${id},kind=relates_to`],
      ]) {
        const result = runCli([...args, "--json"]);
        expect(result.code).toBe(2);
        expect(JSON.parse(result.stderr).required).toContain("dependency kind must be one of:");
      }
      const unchanged = runCli(["get", id, "--depth", "full", "--json"], { expectJson: true });
      expect(unchanged.json).toEqual(before.json);
    });
  });
});
