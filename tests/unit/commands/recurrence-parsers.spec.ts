import { describe, expect, it } from "vitest";

import {
  ensureEnumValue,
  parseDelimitedList,
  parseEventBoolean,
  parseRecurrenceRule,
} from "../../../src/cli/commands/recurrence-parsers.js";

const NOW = new Date("2026-05-24T00:00:00.000Z");
const START = "2026-05-24T09:00:00.000Z";

describe("parseEventBoolean", () => {
  it("parses truthy and falsy spellings", () => {
    expect(parseEventBoolean("TRUE", "--event all_day")).toBe(true);
    expect(parseEventBoolean("1", "--event all_day")).toBe(true);
    expect(parseEventBoolean("yes", "--event all_day")).toBe(true);
    expect(parseEventBoolean("false", "--event all_day")).toBe(false);
    expect(parseEventBoolean("0", "--event all_day")).toBe(false);
    expect(parseEventBoolean("no", "--event all_day")).toBe(false);
  });

  it("throws on invalid value", () => {
    expect(() => parseEventBoolean("maybe", "--event all_day")).toThrow(/must be one of true\|false/);
  });
});

describe("parseDelimitedList", () => {
  it("returns empty array for falsy input", () => {
    expect(parseDelimitedList(undefined)).toEqual([]);
    expect(parseDelimitedList("")).toEqual([]);
  });

  it("splits, trims, and filters empties", () => {
    expect(parseDelimitedList("a | b | ")).toEqual(["a", "b"]);
  });
});

describe("ensureEnumValue", () => {
  it("returns the value when allowed", () => {
    expect(ensureEnumValue("a", ["a", "b"] as const, "thing")).toBe("a");
  });

  it("throws when not allowed", () => {
    expect(() => ensureEnumValue("c", ["a", "b"] as const, "thing")).toThrow(/Invalid thing value "c". Allowed: a, b/);
  });
});

describe("parseRecurrenceRule", () => {
  it("returns undefined when no recurrence inputs are provided", () => {
    expect(parseRecurrenceRule({}, START, NOW, "defined")).toBeUndefined();
  });

  it("requires recur_freq when other recurrence inputs are present", () => {
    expect(() => parseRecurrenceRule({ recur_interval: "2" }, START, NOW, "truthy")).toThrow(/require recur_freq/);
  });

  it("parses a full recurrence rule and sorts weekdays/month-days/exdates", () => {
    const rule = parseRecurrenceRule(
      {
        recur_freq: "WEEKLY",
        recur_interval: "2",
        recur_count: "5",
        recur_until: "2026-06-30T09:00:00.000Z",
        recur_by_weekday: "fri|mon|mon",
        recur_by_month_day: "15|1",
        recur_exdates: "2026-06-07T09:00:00.000Z|2026-06-01T09:00:00.000Z",
      },
      START,
      NOW,
      "defined",
    );
    expect(rule).toBeDefined();
    if (rule === undefined) {
      throw new TypeError("full recurrence rule was not parsed");
    }
    expect(rule.freq).toBe("weekly");
    expect(rule.interval).toBe(2);
    expect(rule.count).toBe(5);
    expect(rule.by_weekday).toEqual(["mon", "fri"]);
    expect(rule.by_month_day).toEqual([1, 15]);
    expect(rule.exdates).toHaveLength(2);
    const [firstExdate, secondExdate] = rule.exdates ?? [];
    expect(firstExdate).toBeDefined();
    expect(secondExdate).toBeDefined();
    if (firstExdate === undefined || secondExdate === undefined) {
      throw new TypeError("full recurrence rule did not include two exclusion dates");
    }
    expect(firstExdate < secondExdate).toBe(true);
  });

  it("omits optional collections when empty", () => {
    const rule = parseRecurrenceRule({ recur_freq: "daily" }, START, NOW, "truthy");
    expect(rule).toEqual({
      freq: "daily",
      interval: undefined,
      count: undefined,
      until: undefined,
      by_weekday: undefined,
      by_month_day: undefined,
      exdates: undefined,
    });
  });

  it("rejects interval < 1", () => {
    expect(() => parseRecurrenceRule({ recur_freq: "daily", recur_interval: "0" }, START, NOW, "defined")).toThrow(
      /recur_interval must be an integer >= 1/,
    );
  });

  it("rejects count < 1", () => {
    expect(() => parseRecurrenceRule({ recur_freq: "daily", recur_count: "0" }, START, NOW, "defined")).toThrow(
      /recur_count must be an integer >= 1/,
    );
  });

  it("rejects recur_until before start", () => {
    expect(() =>
      parseRecurrenceRule(
        { recur_freq: "daily", recur_until: "2026-05-23T09:00:00.000Z" },
        START,
        NOW,
        "truthy",
      ),
    ).toThrow(/recur_until must be at or after start/);
  });

  it("rejects out-of-range month days", () => {
    expect(() => parseRecurrenceRule({ recur_freq: "daily", recur_by_month_day: "32" }, START, NOW, "defined")).toThrow(
      /must be integers 1..31/,
    );
  });

  describe("emptyNumericGuard differences", () => {
    it("'defined' parses an empty recur_interval and rejects it (create behaviour)", () => {
      expect(() => parseRecurrenceRule({ recur_freq: "daily", recur_interval: "" }, START, NOW, "defined")).toThrow(
        /recur_interval must be an integer >= 1/,
      );
    });

    it("'truthy' skips an empty recur_interval (update behaviour)", () => {
      const rule = parseRecurrenceRule({ recur_freq: "daily", recur_interval: "" }, START, NOW, "truthy");
      expect(rule?.interval).toBeUndefined();
    });

    it("'defined' parses an empty recur_count and rejects it (create behaviour)", () => {
      expect(() => parseRecurrenceRule({ recur_freq: "daily", recur_count: "" }, START, NOW, "defined")).toThrow(
        /recur_count must be an integer >= 1/,
      );
    });

    it("'truthy' skips an empty recur_count (update behaviour)", () => {
      const rule = parseRecurrenceRule({ recur_freq: "daily", recur_count: "" }, START, NOW, "truthy");
      expect(rule?.count).toBeUndefined();
    });
  });
});
