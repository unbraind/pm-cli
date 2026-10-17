/** Public event consumers retain cursors and availability when optional repair is contended. */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listMutationEvents,
  subscribeMutationEventBatches,
} from "../../../../src/sdk/mutation-events.js";
import {
  _testOnly,
  rebuildHistoryEventIndex,
} from "../../../../src/core/history/event-index.js";
import { acquireLock } from "../../../../src/core/lock/lock.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("mutation event accelerator fallback", () => {
  it("resumes SDK and CLI pages through authoritative history while repair is locked", async () => {
    await withTempPmPath(async (context) => {
      const restore = _testOnly.setDatabaseSync(DatabaseSync);
      for (const title of ["first", "second"]) {
        context.runCli(
          ["create", "--title", title, "--type", "Task", "--json"],
          { expectJson: true },
        );
      }
      const initial = await listMutationEvents({
        pmRoot: context.pmPath,
        type: "create",
        limit: 1,
      });
      expect(initial.source).toBe("derived_index");
      const release = await acquireLock(
        context.pmPath,
        "history-event-index",
        300,
        "active-writer",
        false,
        false,
        0,
      );
      const previousWait = process.env.PM_LOCK_WAIT_MS;
      process.env.PM_LOCK_WAIT_MS = "30000";
      await fs.rm(
        path.join(context.pmPath, "runtime", "history-event-index.sqlite"),
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const reading = listMutationEvents({
        pmRoot: context.pmPath,
        type: "create",
        since: initial.next_cursor,
      });
      try {
        const page = await Promise.race([
          reading,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("optional rebuild blocked event read")),
              1500,
            );
          }),
        ]);
        expect(page).toMatchObject({
          source: "authoritative_history",
          count: 1,
          has_more: false,
        });
        expect(page.events[0].item_id).not.toBe(initial.events[0].item_id);
        const cli = context.runCli([
          "events",
          "--type",
          "create",
          "--since",
          initial.next_cursor!,
        ]);
        expect(cli.code).toBe(0);
        expect(
          cli.stdout
            .trim()
            .split("\n")
            .map((row) => JSON.parse(row)),
        ).toMatchObject([
          { item_id: page.events[0].item_id },
          { source: "authoritative_history", next_cursor: page.next_cursor },
        ]);
        const controller = new AbortController();
        const subscription = subscribeMutationEventBatches({
          pmRoot: context.pmPath,
          type: "create",
          since: page.next_cursor,
          signal: controller.signal,
        });
        expect(await subscription.next()).toMatchObject({
          value: {
            count: 0,
            next_cursor: page.next_cursor,
            source: "authoritative_history",
          },
        });
        controller.abort();
        await subscription.next();
      } finally {
        clearTimeout(timeout);
        await release();
        await reading;
        if (previousWait === undefined) delete process.env.PM_LOCK_WAIT_MS;
        else process.env.PM_LOCK_WAIT_MS = previousWait;
        restore();
      }
      await rebuildHistoryEventIndex(context.pmPath);
      expect(
        await listMutationEvents({
          pmRoot: context.pmPath,
          type: "create",
          since: initial.next_cursor,
        }),
      ).toMatchObject({ source: "derived_index", count: 1 });
    });
  });

  it("propagates authoritative corruption when optional repair fails", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await fs.writeFile(
        path.join(pmPath, "history", "pm-corrupt.jsonl"),
        "{invalid}\n",
      );
      await expect(listMutationEvents({ pmRoot: pmPath })).rejects.toThrow(
        /invalid JSON/,
      );
      await fs.rm(path.join(pmPath, "history"), { recursive: true });
      await fs.writeFile(path.join(pmPath, "history"), "not a directory");
      await expect(
        listMutationEvents({ pmRoot: pmPath }),
      ).rejects.toMatchObject({
        context: { code: "event_index_unavailable", why: expect.any(String) },
      });
    });
  });
});
