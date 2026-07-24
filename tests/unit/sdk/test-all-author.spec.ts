import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTestAll } from "../../../src/sdk/index.js";
import { setTestResultTracking } from "../../helpers/pmWorkspace.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("SDK test-all author parity", () => {
  it("records the explicit SDK option author on tracked results", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Explicit test-all author",
          "--description",
          "Author parity fixture",
          "--type",
          "Task",
          "--status",
          "open",
          "--test",
          "command=node --version,scope=project",
          "--author",
          "fixture-author",
        ],
        { expectJson: true },
      );
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;
      await setTestResultTracking(context.pmPath, true);

      await expect(
        runTestAll(
          { status: "open", timeout: "20", author: "sdk-test-agent" },
          { path: context.pmPath },
        ),
      ).resolves.toMatchObject({ ok: true });
      const history = (
        await readFile(
          path.join(context.pmPath, "history", `${id}.jsonl`),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { author: string; op: string });
      expect(history.at(-1)).toMatchObject({
        author: "sdk-test-agent",
        op: "test_run_track",
      });
    });
  });
});
