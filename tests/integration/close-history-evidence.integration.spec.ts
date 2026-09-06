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
  it("routes warning closes and terminal retries to an evidence-only update", async () => {
    await withTempPmPath(async (context) => {
      for (const mode of ["warning", "terminal"]) {
        const id = createTestItemId(context, {
          title: "Recover incomplete close evidence",
        });
        const closed = await runClose(
          id,
          "Delivered",
          { validateClose: "warn", resolution: "Implemented" },
          { path: context.pmPath },
        );
        expect(closed).toHaveProperty("recovery.suggested_retry_args");
        const recovery = (
          closed as unknown as { recovery: { suggested_retry_args: string[] } }
        ).recovery;
        const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
        const before = await readFile(historyPath, "utf8");
        let args = recovery.suggested_retry_args.map((token) =>
          token === "<value>" ? "Verified evidence" : token,
        );
        if (mode === "terminal") {
          const terminal: unknown = await runClose(
            id,
            "Delivered",
            { expectedResult: "Expected", actualResult: "Observed" },
            { path: context.pmPath },
          ).catch((error: unknown) => error);
          expect(terminal).toMatchObject({
            context: {
              recovery: {
                suggested_retry_args: [
                  "--pm-path",
                  context.pmPath,
                  "update",
                  id,
                  "--expected-result",
                  "Expected",
                  "--actual-result",
                  "Observed",
                ],
              },
            },
          });
          args = (
            terminal as {
              context: { recovery: { suggested_retry_args: string[] } };
            }
          ).context.recovery.suggested_retry_args;
        }
        expect(context.runCli([...args, "--json"]).code).toBe(0);
        const after = await readFile(historyPath, "utf8");
        expect(after.startsWith(before)).toBe(true);
        expect(
          context.runCli(["get", id, "--full", "--json"], { expectJson: true })
            .json,
        ).toMatchObject({
          item: {
            status: "closed",
            expected_result:
              mode === "terminal" ? "Expected" : "Verified evidence",
            actual_result:
              mode === "terminal" ? "Observed" : "Verified evidence",
          },
        });
      }
    });
  });

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
      await expect(
        runClose(id, "Repeat close", {}, { path: context.pmPath }),
      ).rejects.toMatchObject({ context: { recovery: undefined } });
    });
  });
});
