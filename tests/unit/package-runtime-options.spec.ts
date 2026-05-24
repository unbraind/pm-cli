import { describe, expect, it } from "vitest";
import {
  readBooleanOption,
  readCsvListOption,
  readStringOption,
} from "../../src/sdk/package-runtime-options.js";

describe("package runtime option helpers", () => {
  describe("readStringOption", () => {
    it("returns the first non-empty string for the primary key", () => {
      expect(readStringOption({ status: "open" }, "status")).toBe("open");
    });

    it("returns normalized trimmed strings", () => {
      expect(readStringOption({ status: "  open  " }, "status")).toBe("open");
    });

    it("skips empty/whitespace strings and falls through to aliases", () => {
      expect(readStringOption({ status: "   ", status_alias: "done" }, "status", ["status_alias"])).toBe("done");
    });

    it("ignores non-string and missing values", () => {
      expect(readStringOption({ status: 42 }, "status")).toBeUndefined();
      expect(readStringOption({}, "status")).toBeUndefined();
    });
  });

  describe("readBooleanOption", () => {
    it("returns native booleans directly", () => {
      expect(readBooleanOption({ force: true }, "force")).toBe(true);
      expect(readBooleanOption({ force: false }, "force")).toBe(false);
    });

    it("coerces canonical truthy string literals", () => {
      for (const value of ["true", "1", "yes", "on", " ON "]) {
        expect(readBooleanOption({ flag: value }, "flag")).toBe(true);
      }
    });

    it("coerces canonical falsy string literals", () => {
      for (const value of ["false", "0", "no", "off", " OFF "]) {
        expect(readBooleanOption({ flag: value }, "flag")).toBe(false);
      }
    });

    it("skips undefined values and continues to aliases", () => {
      expect(readBooleanOption({ force: undefined, force_alias: "yes" }, "force", ["force_alias"])).toBe(true);
    });

    it("ignores unrecognized strings and other types", () => {
      expect(readBooleanOption({ flag: "maybe" }, "flag")).toBeUndefined();
      expect(readBooleanOption({ flag: 5 }, "flag")).toBeUndefined();
      expect(readBooleanOption({}, "flag")).toBeUndefined();
    });
  });

  describe("readCsvListOption", () => {
    it("splits comma-separated values and trims entries", () => {
      expect(readCsvListOption({ tags: "a, b ,c" }, "tags")).toEqual(["a", "b", "c"]);
    });

    it("drops empty entries", () => {
      expect(readCsvListOption({ tags: "a,,b, ,c" }, "tags")).toEqual(["a", "b", "c"]);
    });

    it("returns an empty array when the option is absent or empty", () => {
      expect(readCsvListOption({}, "tags")).toEqual([]);
      expect(readCsvListOption({ tags: "   " }, "tags")).toEqual([]);
    });

    it("resolves through aliases", () => {
      expect(readCsvListOption({ item_types: "Task,Bug" }, "itemTypes", ["item_types"])).toEqual(["Task", "Bug"]);
    });
  });
});
