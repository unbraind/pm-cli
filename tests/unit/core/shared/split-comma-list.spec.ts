import { describe, expect, it } from "vitest";
import { splitCommaList } from "../../../../src/core/shared/split-comma-list.js";

// pm-1b96: shared helper consolidating 7 hand-rolled `split(",").map(trim).filter(...)`
// (often `[...new Set(...)]`-wrapped) call sites across the CLI commands. The unit
// suite below pins the exact semantics relied on by each call site (dedup default,
// custom regex separators for linked-test parsers, opt-out dedup for plan toArray,
// opt-in sort for update-many tag previews) so accidental drift in those flags is
// caught in this fast unit test rather than at the consumer call site.

describe("splitCommaList", () => {
  it("splits a comma-separated string into trimmed entries", () => {
    expect(splitCommaList("alpha, beta ,gamma")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns [] for undefined input", () => {
    expect(splitCommaList(undefined)).toEqual([]);
  });

  it("returns [] for null input", () => {
    expect(splitCommaList(null)).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(splitCommaList("")).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(splitCommaList("   ")).toEqual([]);
    expect(splitCommaList(" , , , ")).toEqual([]);
  });

  it("collapses leading, trailing, and duplicate separators", () => {
    expect(splitCommaList(",alpha,,beta,")).toEqual(["alpha", "beta"]);
  });

  it("de-duplicates by default while preserving first-seen order", () => {
    expect(splitCommaList("alpha,beta,alpha,gamma,beta")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("disables de-duplication when unique=false", () => {
    expect(splitCommaList("alpha,beta,alpha", { unique: false })).toEqual(["alpha", "beta", "alpha"]);
  });

  it("accepts a custom regex separator", () => {
    expect(splitCommaList("a;b\nc,d", { separators: /[;,\n]/ })).toEqual(["a", "b", "c", "d"]);
  });

  it("accepts a custom string separator", () => {
    expect(splitCommaList("a|b|c", { separators: "|" })).toEqual(["a", "b", "c"]);
  });

  it("sorts lexicographically when sort=true", () => {
    expect(splitCommaList("delta,alpha,charlie,bravo", { sort: true })).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
  });

  it("sort=true does not mutate the de-dup phase or its first-seen ordering input", () => {
    // dedup first (preserves first-seen), THEN sort the deduped array.
    expect(splitCommaList("b,a,b,c,a", { sort: true })).toEqual(["a", "b", "c"]);
  });

  it("sort=true with unique=false sorts the entire (unfiltered) list", () => {
    expect(splitCommaList("b,a,b", { unique: false, sort: true })).toEqual(["a", "b", "b"]);
  });

  it("returns a new array each call (no shared mutable reference)", () => {
    const first = splitCommaList("a,b,c");
    const second = splitCommaList("a,b,c");
    expect(first).not.toBe(second);
    first.push("mutated");
    expect(second).toEqual(["a", "b", "c"]);
  });
});
