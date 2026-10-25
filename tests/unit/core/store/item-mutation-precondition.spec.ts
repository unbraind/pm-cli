import { describe, expect, it } from "vitest";
import { EMPTY_CANONICAL_DOCUMENT } from "../../../../src/core/shared/constants.js";
import { advanceItemMutationPreconditions, assertItemMutationPreconditions, itemMutationPreconditionHistoryContext, runWithItemMutationPrecondition } from "../../../../src/core/store/item-mutation-precondition.js";

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
        advanceItemMutationPreconditions("/tracker/a", document);
        expect(itemMutationPreconditionHistoryContext("/tracker/a", document)).toEqual({});
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

  it("advances only matching committed writes and still refuses a peer change between internal steps", async () => {
    const document = structuredClone(EMPTY_CANONICAL_DOCUMENT);
    document.metadata.id = "pm-target";
    document.metadata.title = "Initial";
    let expected = document.metadata.title;
    expect(itemMutationPreconditionHistoryContext("/tracker", document)).toEqual({});
    await runWithItemMutationPrecondition({ pmRoot: "/tracker", id: "pm-target", historyContext: { step: "owned" }, validate: (current) => { expect(current.metadata.title).toBe(expected); }, committed: (current) => { expected = current.metadata.title; } }, async () => {
      expect(itemMutationPreconditionHistoryContext("/tracker", document)).toEqual({ step: "owned" });
      expect(itemMutationPreconditionHistoryContext("/other", document)).toEqual({});
      expect(itemMutationPreconditionHistoryContext("/tracker", { ...document, metadata: { ...document.metadata, id: "pm-other" } })).toEqual({});
      assertItemMutationPreconditions("/tracker", document);
      document.metadata.title = "Own write";
      advanceItemMutationPreconditions("/other", document);
      advanceItemMutationPreconditions("/tracker", { ...document, metadata: { ...document.metadata, id: "pm-other" } });
      expect(expected).toBe("Initial");
      advanceItemMutationPreconditions("/tracker", document);
      assertItemMutationPreconditions("/tracker", document);
      document.metadata.title = "Peer write";
      expect(() => assertItemMutationPreconditions("/tracker", document)).toThrow();
    });
    advanceItemMutationPreconditions("/tracker", document);
    expect(expected).toBe("Own write");
  });
});
