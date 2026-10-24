import { describe, expect, it } from "vitest";
import { checkpointMutationHistoryContext, withCheckpointMutation } from "../../../../src/core/checkpoint/mutation-context.js";

describe("bulk checkpoint attribution isolation", () => {
  it("scopes nested and concurrent contexts to their own tracker and item", async () => {
    const root = "/tracker";
    const context = { pmRoot: root, itemId: "pm-a", checkpointId: "batch-a" };
    expect(checkpointMutationHistoryContext(root, "pm-a")).toBeUndefined();
    await Promise.all([withCheckpointMutation(context, async () => {
      expect(checkpointMutationHistoryContext(root, "pm-a")).toEqual({ bulk_checkpoint: "batch-a" });
      expect(checkpointMutationHistoryContext("/other", "pm-a")).toBeUndefined();
      expect(checkpointMutationHistoryContext(root, "pm-peer")).toBeUndefined();
      await withCheckpointMutation({ ...context, checkpointId: "nested" }, async () => {
        expect(checkpointMutationHistoryContext(root, "pm-a")).toEqual({ bulk_checkpoint: "nested" });
      });
      expect(checkpointMutationHistoryContext(root, "pm-a")).toEqual({ bulk_checkpoint: "batch-a" });
    }), withCheckpointMutation({ ...context, checkpointId: "batch-b" }, async () => {
      await Promise.resolve();
      expect(checkpointMutationHistoryContext(root, "pm-a")).toEqual({ bulk_checkpoint: "batch-b" });
    })]);
    expect(checkpointMutationHistoryContext(root, "pm-a")).toBeUndefined();
  });
});
