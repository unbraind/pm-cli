import { describe, expect, it } from "vitest";
import { DEPENDENCY_KIND_VALUES } from "../../../../src/types/index.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("enum constraint recovery", () => {
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
      const unchanged = runCli(["get", id, "--depth", "full", "--json"], { expectJson: true });
      expect(unchanged.json).toEqual(before.json);
    });
  });
});
