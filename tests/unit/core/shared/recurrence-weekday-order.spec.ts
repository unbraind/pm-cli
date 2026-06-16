import { describe, expect, it } from "vitest";
import { RECURRENCE_WEEKDAY_VALUES, weekdayOrderIndex } from "../../../../src/types/index.js";

describe("weekdayOrderIndex", () => {
  it("maps each recurrence weekday to its canonical mon=0..sun=6 index", () => {
    expect(RECURRENCE_WEEKDAY_VALUES.map((value) => weekdayOrderIndex(value))).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it("returns the indexOf the shared weekday ordering for individual values", () => {
    expect(weekdayOrderIndex("mon")).toBe(0);
    expect(weekdayOrderIndex("sun")).toBe(6);
    for (const value of RECURRENCE_WEEKDAY_VALUES) {
      expect(weekdayOrderIndex(value)).toBe(RECURRENCE_WEEKDAY_VALUES.indexOf(value));
    }
  });

  it("orders an out-of-order weekday selection week-first when used as a comparator", () => {
    const shuffled = ["sun", "wed", "mon", "fri", "tue", "sat", "thu"] as const;
    const ordered = [...shuffled].sort((left, right) => weekdayOrderIndex(left) - weekdayOrderIndex(right));
    expect(ordered).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  });
});
