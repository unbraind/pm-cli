import { describe, expect, it } from "vitest";

import { firstExampleOrEmpty } from "../../../src/cli/help-content.js";

describe("help-content.firstExampleOrEmpty", () => {
  it("returns only the first example when examples are present", () => {
    expect(firstExampleOrEmpty(["one", "two", "three"])).toEqual(["one"]);
  });

  it("returns an empty list when no examples exist", () => {
    expect(firstExampleOrEmpty([])).toEqual([]);
  });
});
