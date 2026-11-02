import { describe, expect, it, vi } from "vitest";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { runClaim } from "../../../../src/sdk/lifecycle/claim.js";
import { START_BLOCKED_REFUSAL_CODE } from "../../../../src/sdk/lifecycle/start-blockers.js";
import { releaseRefusedStartClaim, runStartTask } from "../../../../src/sdk/lifecycle/task-composition.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

// Schedule a peer write between an explicit start's claim and its status update.
const race = vi.hoisted(() => ({ beforeStatusUpdate: undefined as undefined | (() => Promise<void>) }));
vi.mock("../../../../src/sdk/lifecycle/update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/sdk/lifecycle/update.js")>();
  return {
    ...actual,
    runUpdate: async (...args: Parameters<typeof actual.runUpdate>) => {
      const peer = race.beforeStatusUpdate;
      race.beforeStatusUpdate = undefined;
      if (peer) await peer();
      return actual.runUpdate(...args);
    },
  };
});

describe("pm-urzubi explicit start race", () => {
  it("refuses a blocker opened after the claim and releases the claim it took", async () => {
    await withTempPmPath(async (context) => {
      const blocker = createTestItemId(context, { title: "Late blocker" });
      const target = createTestItemId(context, { title: "Raced start" });
      const global = { path: context.pmPath };
      const { runUpdate } = await import("../../../../src/sdk/lifecycle/update.js");
      race.beforeStatusUpdate = async () => {
        await runUpdate(target, { dep: [`id=${blocker},kind=blocked_by`], author: "peer-agent", force: true }, global);
      };
      const refusal = await runStartTask(target, {}, global).then(() => { throw new Error("expected refusal"); }, (error: PmCliError) => error);
      expect(refusal).toMatchObject({ exitCode: EXIT_CODE.CONFLICT, context: { code: START_BLOCKED_REFUSAL_CODE, item_id: target } });
      expect(refusal.context.why).toContain("the claim was released and no ownership remains");
      const item = (await new PmClient({ pmRoot: context.pmPath, noExtensions: true }).get(target, { full: true })).item;
      expect(item.assignee ?? null).toBeNull();
      expect(item.status).toBe("open");
      const history = context.runCli(["history", target, "--full", "--json"], { expectJson: true }).json as { history: Array<{ op: string }> };
      expect(history.history.map((entry) => entry.op)).toEqual(["create", "claim", "update", "release"]);
    });
  });

  it("keeps an earlier owner's claim and reports the partial composition", async () => {
    await withTempPmPath(async (context) => {
      const blocker = createTestItemId(context, { title: "Late blocker" });
      const target = createTestItemId(context, { title: "Owned start" });
      const global = { path: context.pmPath };
      await runClaim(target, false, global, {});
      const { runUpdate } = await import("../../../../src/sdk/lifecycle/update.js");
      race.beforeStatusUpdate = async () => {
        await runUpdate(target, { dep: [`id=${blocker},kind=blocked_by`], author: "peer-agent", force: true }, global);
      };
      const refusal = await runStartTask(target, {}, global).then(() => { throw new Error("expected refusal"); }, (error: PmCliError) => error);
      expect(refusal.context.why).toContain("No rollback was performed");
      expect((await new PmClient({ pmRoot: context.pmPath, noExtensions: true }).get(target)).item.assignee).toBe("test-author");
    });
  });

  it("returns the original refusal when its claim can no longer be released", async () => {
    await withTempPmPath(async (context) => {
      const refusal = new PmCliError("blocked", EXIT_CODE.CONFLICT, { code: START_BLOCKED_REFUSAL_CODE });
      expect(await releaseRefusedStartClaim(refusal, { item: { id: "pm-gone" }, previous_assignee: null }, { path: context.pmPath }, undefined)).toBe(refusal);
    });
  });
});
