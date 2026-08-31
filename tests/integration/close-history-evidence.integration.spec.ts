import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runClose } from "../../src/cli/commands/close.js";
import { createTestItemId } from "../helpers/itemFactory.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

interface HistoryPatch {
  op: string;
  path: string;
  value?: unknown;
}

interface HistoryEntry {
  op: string;
  patch: HistoryPatch[];
}

describe("close history evidence", () => {
  it("records structured closure evidence in the immutable close event", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "atomic close history evidence",
        tags: "close,history,integration",
        estimate: "20",
        parent: "none",
      });

      await runClose(
        id,
        "Acceptance criteria and verification complete",
        {
          validateClose: "strict",
          resolution: "Delivered the requested behavior",
          expectedResult: "Closure metadata is complete at transition time",
          actualResult: "One close event contains the complete evidence",
        },
        { path: context.pmPath },
      );

      const history = (
        await readFile(
          path.join(context.pmPath, "history", `${id}.jsonl`),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as HistoryEntry);
      const closeEntries = history.filter((entry) => entry.op === "close");
      expect(closeEntries).toHaveLength(1);
      expect(closeEntries[0]?.patch).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/metadata/resolution",
            value: "Delivered the requested behavior",
          }),
          expect.objectContaining({
            path: "/metadata/expected_result",
            value: "Closure metadata is complete at transition time",
          }),
          expect.objectContaining({
            path: "/metadata/actual_result",
            value: "One close event contains the complete evidence",
          }),
          expect.objectContaining({
            path: "/metadata/status",
            value: "closed",
          }),
        ]),
      );
      expect(history.at(-1)?.op).toBe("close");
    });
  });
});
