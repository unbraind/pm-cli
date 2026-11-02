import { describe, expect, it, vi } from "vitest";
import type { ItemDocument } from "../../../../src/types/index.js";

const HASH = "e".repeat(64);
const MODULE = "../../../../src/core/store/item-mutation-precondition.js";

describe("pm-gh1576 revision scopes across SDK bundle graphs", () => {
  it("shares one scope store between independently loaded module instances", async () => {
    vi.resetModules();
    const first = await import(MODULE);
    vi.resetModules();
    const second = await import(MODULE);
    expect(second).not.toBe(first);
    const document = { metadata: { id: "pm-a", title: "A" }, body: "" } as unknown as ItemDocument;
    const scope = first.createItemRevisionScope();
    first.bindItemRevisionScope(scope, "/tracker", [{ id: "pm-a", itemHash: HASH }]);
    // A guard opened through one entrypoint constrains a write made through another.
    await first.runWithItemRevisionScope(scope, async () => {
      expect(() => second.assertItemMutationPreconditions("/tracker", document)).toThrow(
        expect.objectContaining({ context: expect.objectContaining({ code: "item_revision_conflict" }) }),
      );
    });
    expect(first.itemRevisionScopeReceipt(scope).checked).toEqual(["pm-a"]);
  });

  it("advances a deleted item's expectation through its pre-delete embedded id", async () => {
    const precondition = await import(MODULE);
    const { hashDocument } = await import("../../../../src/core/history/history.js");
    const tombstone = { metadata: {}, body: "" } as unknown as ItemDocument;
    const scope = precondition.createItemRevisionScope();
    precondition.bindItemRevisionScope(scope, "/tracker", [{ id: "pm-a", itemHash: HASH }]);
    await precondition.runWithItemRevisionScope(scope, async () => {
      // Deleted through the case-variant spelling PM-A; the embedded id pm-a is carried as an alias.
      precondition.advanceItemMutationPreconditions("/tracker", tombstone, "PM-A", ["pm-a"]);
      expect(() => precondition.assertItemMutationPreconditions("/tracker", tombstone, "pm-a")).not.toThrow();
    });
    expect(hashDocument(tombstone)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
