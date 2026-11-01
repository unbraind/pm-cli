import { describe, expect, it } from "vitest";
import { runUpdate } from "../../../../src/sdk/lifecycle/update.js";
import { runContext } from "../../../../src/sdk/query/context.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("filtered context keeps dependency edges outside the filter", () => {
  it("reports a task blocked through a reverse blocks edge declared by an item the filter excludes", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      const epic = createTestItemId(context, { title: "Scope epic", type: "Epic" });
      const task = createTestItemId(context, { title: "Reverse blocked task", type: "Task", priority: "0", parent: epic });
      const blocker = createTestItemId(context, { title: "Blocking issue", type: "Issue" });
      await runUpdate(blocker, { dep: [`id=${task},kind=blocks`] }, global);
      for (const options of [{}, { type: "Task" }]) {
        const result = await runContext(options, global);
        const rows = [...result.high_level, ...result.low_level];
        expect(rows.find((item) => item.id === task), JSON.stringify(options)).toMatchObject({ blocked: true, blocker_ids: [blocker] });
        // The filter still excludes the blocker's own row; only its edge is resolved.
        expect(rows.some((item) => item.id === blocker)).toBe(Object.keys(options).length === 0);
      }
      const scoped = await runContext({ type: "Task", parent: epic }, global);
      expect([...scoped.high_level, ...scoped.low_level].map((item) => item.id)).toEqual([task]);
    });
  });
});
