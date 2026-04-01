import { describe, expect, it } from "vitest";

import { normalizeStatusInput } from "../../src/core/item/status.js";

describe("normalizeStatusInput", () => {
  it("accepts canonical statuses and in-progress alias", () => {
    expect(normalizeStatusInput("in_progress")).toBe("in_progress");
    expect(normalizeStatusInput(" in-progress ")).toBe("in_progress");
    expect(normalizeStatusInput("OPEN")).toBe("open");
  });

  it("returns undefined for blank and invalid status inputs", () => {
    expect(normalizeStatusInput("")).toBeUndefined();
    expect(normalizeStatusInput("   ")).toBeUndefined();
    expect(normalizeStatusInput("in progress")).toBeUndefined();
    expect(normalizeStatusInput("doing")).toBeUndefined();
  });
});
