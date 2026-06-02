import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("dependency CLI aliases", () => {
  it("accepts type=blocked-by as a structured --dep kind alias", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli(
        [
          "create",
          "--json",
          "--create-mode",
          "progressive",
          "--title",
          "Dependency alias item",
          "--description",
          "Validate dependency type alias parsing",
          "--type",
          "Task",
          "--author",
          "integration-test",
        ],
        { expectJson: true },
      );
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const updated = context.runCli(
        [
          "update",
          id,
          "--json",
          "--dep",
          "type=blocked-by,id=dep-blocker,created_at=2026-03-02T12:00:00.000Z",
          "--author",
          "integration-test",
          "--message",
          "Add dependency through type alias",
        ],
        { expectJson: true },
      );
      expect(updated.code).toBe(0);
      expect((updated.json as { item: { dependencies?: Array<Record<string, unknown>> } }).item.dependencies).toEqual([
        {
          id: "pm-dep-blocker",
          kind: "blocked_by",
          created_at: "2026-03-02T12:00:00.000Z",
        },
      ]);
    });
  });
});
