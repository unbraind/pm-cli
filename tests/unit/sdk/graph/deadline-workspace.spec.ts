import { describe, expect, it } from "vitest";
import { runGraph } from "../../../../src/sdk/graph/run.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("workspace deadline population", () => {
  it("excludes completed historical constraints and refreshes dated evidence on cache hits", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "Task",
          "Finished milestone",
          "--create-mode",
          "progressive",
          "--estimate",
          "60",
          "--deadline",
          "2020-01-01",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      expect(
        context.runCli([
          "close",
          id,
          "Completed",
          "--resolution",
          "Delivered",
          "--expected",
          "Delivered",
          "--actual",
          "Delivered",
          "--validate-close",
          "warn",
        ]).code,
      ).toBe(0);
      for (const summary of [false, true]) {
        const result = await runGraph(
          "slack",
          undefined,
          undefined,
          { summary },
          { path: context.pmPath },
        );
        expect(result).toMatchObject({
          deadline_schedule: {
            population: "active",
            scheduled_count: 0,
            overcommitted_count: 0,
            complete: true,
          },
        });
      }
    });
  });
});
