import { describe, expect, it } from "vitest";
import { EMPTY_CANONICAL_DOCUMENT } from "../../../../src/core/shared/constants.js";
import { assertItemMutationPreconditions, runWithItemMutationPrecondition } from "../../../../src/core/store/item-mutation-precondition.js";

describe("locked item mutation precondition scope", () => {
  it("matches tracker and item, composes nested guards, and isolates concurrent and completed operations", async () => {
    const document = structuredClone(EMPTY_CANONICAL_DOCUMENT);
    document.metadata.id = "pm-target";
    const observed: string[] = [];
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const pending = runWithItemMutationPrecondition({
      pmRoot: "/tracker/a/../a",
      id: document.metadata.id,
      validate: () => { observed.push("outer"); },
    }, async () => {
      assertItemMutationPreconditions("/tracker/b", document);
      assertItemMutationPreconditions("/tracker/a", { ...document, metadata: { ...document.metadata, id: "pm-other" } });
      await runWithItemMutationPrecondition({ pmRoot: "/tracker/a", id: document.metadata.id, validate: () => { observed.push("inner"); } }, async () => {
        entered.resolve();
        await resume.promise;
        assertItemMutationPreconditions("/tracker/a", document);
      });
      assertItemMutationPreconditions("/tracker/a", document);
    });
    await entered.promise;
    assertItemMutationPreconditions("/tracker/a", document);
    expect(observed).toEqual([]);
    resume.resolve();
    await pending;
    assertItemMutationPreconditions("/tracker/a", document);
    expect(observed).toEqual(["outer", "inner", "outer"]);
  });
});
