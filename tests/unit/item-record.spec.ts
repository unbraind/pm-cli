import { describe, expect, it } from "vitest";

import { toItemRecord } from "../../src/core/item/item-record.js";
import type { ItemMetadata } from "../../src/types/index.js";

function buildItemMetadata(overrides: Partial<ItemMetadata> = {}): ItemMetadata {
  return {
    id: "pm-test",
    title: "Test item",
    description: "",
    type: "Task",
    status: "open",
    priority: 2,
    tags: [],
    created_at: "2026-05-25T00:00:00.000Z",
    updated_at: "2026-05-25T00:00:00.000Z",
    ...overrides,
  } as ItemMetadata;
}

describe("toItemRecord", () => {
  it("returns the same object reference (no runtime transformation)", () => {
    const item = buildItemMetadata();
    const record = toItemRecord(item);
    expect(record).toBe(item as unknown as Record<string, unknown>);
  });

  it("exposes the item fields through a generic record shape", () => {
    const item = buildItemMetadata({ id: "pm-abcd", title: "Widen me", priority: 1 });
    const record = toItemRecord(item);
    expect(record.id).toBe("pm-abcd");
    expect(record.title).toBe("Widen me");
    expect(record.priority).toBe(1);
  });

  it("reflects subsequent mutations because it is the same reference", () => {
    const item = buildItemMetadata();
    const record = toItemRecord(item);
    record.assignee = "maintainer";
    expect(item.assignee).toBe("maintainer");
  });
});
