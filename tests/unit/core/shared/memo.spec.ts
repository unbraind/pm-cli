import { describe, expect, it } from "vitest";
import { evictOldestMemoEntries } from "../../../../src/core/shared/memo.js";

describe("core/shared/memo", () => {
  it("evicts the oldest-inserted half and keeps the newer half", () => {
    const memo = new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
    ]);
    evictOldestMemoEntries(memo);
    expect([...memo.keys()]).toEqual(["c", "d"]);
  });

  it("rounds up on odd sizes and exhausts a single-entry map without early return", () => {
    const odd = new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    evictOldestMemoEntries(odd);
    expect([...odd.keys()]).toEqual(["c"]);

    const single = new Map<string, number>([["only", 1]]);
    evictOldestMemoEntries(single);
    expect(single.size).toBe(0);
  });

  it("is a no-op on an empty map", () => {
    const empty = new Map<string, number>();
    evictOldestMemoEntries(empty);
    expect(empty.size).toBe(0);
  });
});
