import { describe, expect, it } from "vitest";
import { runClose } from "../../src/sdk/lifecycle/close.js";
import { runCreate } from "../../src/sdk/lifecycle/create.js";
import {
  PmClient,
  analyzeSdkActionCoverage,
  runAction,
} from "../../src/sdk/runtime.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("recurrence presentation contracts", () => {
  it("exposes item reopen through noun-first CLI and immutable history", async () => {
    await withTempPmPath(async (context) => {
      const created = await runCreate(
        {
          title: "CLI recurrence contract",
          type: "Issue",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      await runClose(
        created.item.id,
        "Initially completed",
        {},
        { path: context.pmPath },
      );

      const reopened = context.runCli(
        [
          "item",
          "reopen",
          created.item.id,
          "Failure returned in production",
          "--status",
          "in_progress",
          "--json",
        ],
        { expectJson: true },
      );
      expect(reopened.code).toBe(0);
      expect(reopened.json).toMatchObject({
        id: created.item.id,
        status: "in_progress",
        recurrence: {
          reason: "Failure returned in production",
          from_status: "closed",
          to_status: "in_progress",
        },
      });

      const history = context.runCli(
        ["history", created.item.id, "--full", "--json"],
        { expectJson: true },
      );
      expect(
        (history.json as { history: Array<{ op: string }> }).history.map(
          (entry) => entry.op,
        ),
      ).toEqual(["create", "close", "reopen"]);
    });
  });

  it("exposes the same operation through typed SDK and generic MCP dispatch", async () => {
    await withTempPmPath(async (context) => {
      const created = await runCreate(
        {
          title: "SDK recurrence contract",
          type: "Issue",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      await runClose(
        created.item.id,
        "Initially completed",
        {},
        { path: context.pmPath },
      );

      const client = new PmClient({ pmRoot: context.pmPath });
      const reopened = await client.reopen(
        created.item.id,
        "SDK observed a recurrence",
      );
      expect(reopened.recurrence).toMatchObject({
        reason: "SDK observed a recurrence",
        from_status: "closed",
        to_status: "open",
      });
      expect(
        analyzeSdkActionCoverage().find((row) => row.action === "item-reopen"),
      ).toMatchObject({ covered: true, route: "native" });

      const genericTarget = await runCreate(
        {
          title: "Generic dispatch recurrence contract",
          type: "Issue",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      await runClose(
        genericTarget.item.id,
        "Initially completed through the shared lifecycle",
        {},
        { path: context.pmPath },
      );
      await expect(
        runAction({
          action: "item-reopen",
          id: genericTarget.item.id,
          reason: "Generic dispatch observed a recurrence",
          path: context.pmPath,
        }),
      ).resolves.toMatchObject({
        id: genericTarget.item.id,
        status: "open",
        recurrence: {
          reason: "Generic dispatch observed a recurrence",
          from_status: "closed",
          to_status: "open",
        },
      });
    });
  });
});
