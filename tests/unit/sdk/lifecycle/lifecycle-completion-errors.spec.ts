import { describe, expect, it } from "vitest";
import { finishComposition } from "../../../../src/sdk/lifecycle/task-composition.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";

describe("partial lifecycle failure diagnostics", () => {
  it("preserves typed refusals and original causes without losing committed-step recovery", async () => {
    const refusal = new PmCliError("Release refused", 4, {
      code: "already_claimed_by", why: "Assignment changed concurrently.", nextSteps: ["Contact the current owner."],
    });
    for (const cause of [refusal, new Error("Storage unavailable"), "Extension failure"]) {
      const pending = finishComposition("pm-example", "close", async () => { throw cause; });
      await expect(pending).rejects.toMatchObject({
        cause,
        context: { item_id: "pm-example", why: expect.stringContaining("close completed") },
      });
      if (cause === refusal) {
        await expect(pending).rejects.toMatchObject({
          exitCode: 4, code: "already_claimed_by",
          context: { why: expect.stringContaining("Assignment changed concurrently."), nextSteps: expect.arrayContaining(["Contact the current owner."]) },
        });
      } else {
        await expect(pending).rejects.toMatchObject({ exitCode: 1 });
      }
    }
  });
});
