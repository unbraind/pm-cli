import { afterEach, describe, expect, it, vi } from "vitest";

describe("item-format TOON decode failures", () => {
  afterEach(() => {
    vi.doUnmock("@toon-format/toon");
    vi.resetModules();
  });

  it("wraps TOON decode exceptions with validation error text", async () => {
    vi.resetModules();
    vi.doMock("@toon-format/toon", () => ({
      decode: () => {
        throw new Error("decode exploded");
      },
      encode: (value: unknown) => JSON.stringify(value),
    }));

    const { parseItemDocument } = await import("../../../../src/core/item/item-format.js");
    expect(() => parseItemDocument("front_matter: {}", { format: "toon" })).toThrow("TOON item document is not valid TOON");
  });
});
