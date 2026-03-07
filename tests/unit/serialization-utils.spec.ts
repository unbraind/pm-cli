import { describe, expect, it } from "vitest";
import { orderObject, sha256Hex, stableStringify } from "../../src/core/shared/serialization.js";

class ToJsonValue {
  public readonly marker = "ignored";

  toJSON(): unknown {
    return {
      b: 2,
      a: 1,
      at: new Date("2026-02-19T00:00:00.000Z"),
    };
  }
}

class ToJsonSelf {
  public readonly b = 2;
  public readonly a = 1;

  toJSON(): unknown {
    return this;
  }
}

function namedFallback(): void {
  // no-op
}

describe("core/shared/serialization", () => {
  it("stableStringify deterministically sorts nested object keys and drops undefined object fields", () => {
    const serialized = stableStringify({
      z: 1,
      nested: {
        b: 2,
        a: 1,
        skip: undefined,
      },
      drop: undefined,
    });
    expect(serialized).toBe('{"nested":{"a":1,"b":2},"z":1}');
  });

  it("stableStringify handles primitive, array, and fallback coercion branches", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify(7)).toBe("7");
    expect(stableStringify(7n)).toBe('"7"');
    expect(stableStringify("value")).toBe('"value"');
    expect(stableStringify([1, undefined, { b: 2, a: 1 }])).toBe('[1,"undefined",{"a":1,"b":2}]');
    expect(stableStringify(Symbol.for("serialization"))).toBe('"Symbol(serialization)"');
    expect(stableStringify(namedFallback)).toBe('"[function:namedFallback]"');
    expect(stableStringify(function () {})).toBe('"[function:anonymous]"');
  });

  it("stableStringify normalizes Date and toJSON objects deterministically", () => {
    const fromDate = stableStringify({
      at: new Date("2026-02-19T00:00:00.000Z"),
    });
    expect(fromDate).toBe('{"at":"2026-02-19T00:00:00.000Z"}');

    const fromToJsonValue = stableStringify(new ToJsonValue());
    expect(fromToJsonValue).toBe('{"a":1,"at":"2026-02-19T00:00:00.000Z","b":2}');

    const fromToJsonSelf = stableStringify(new ToJsonSelf());
    expect(fromToJsonSelf).toBe('{"a":1,"b":2}');
  });

  it("orderObject keeps known keys first, sorts unknown keys, and skips undefined values", () => {
    const ordered = orderObject(
      {
        z: 26,
        b: 2,
        keep: "x",
        omit: undefined,
        a: 1,
      },
      ["keep", "a"],
    );
    expect(ordered).toEqual({
      keep: "x",
      a: 1,
      b: 2,
      z: 26,
    });
    expect(Object.keys(ordered)).toEqual(["keep", "a", "b", "z"]);
  });

  it("sha256Hex is deterministic and returns lowercase hex", () => {
    const one = sha256Hex("stable-input");
    const two = sha256Hex("stable-input");
    const different = sha256Hex("stable-input-2");

    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(one).not.toBe(different);
  });
});
