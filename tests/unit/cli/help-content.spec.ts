import { describe, expect, it } from "vitest";

import { _testOnly, firstExampleOrEmpty } from "../../../src/cli/help-content.js";

describe("help-content.firstExampleOrEmpty", () => {
  it("returns only the first example when examples are present", () => {
    expect(firstExampleOrEmpty(["one", "two", "three"])).toEqual(["one"]);
  });

  it("returns an empty list when no examples exist", () => {
    expect(firstExampleOrEmpty([])).toEqual([]);
  });
});

describe("help-content rendering helpers", () => {
  it("renders compact bundles without examples and detailed bundles without tips", () => {
    expect(
      _testOnly.renderCompactHelpBundle({
        why: "Short rationale",
        examples: [],
      }),
    ).not.toContain("Example:");

    expect(
      _testOnly.renderDetailedHelpBundle({
        why: "Detailed rationale",
        examples: ["pm list --help"],
      }),
    ).not.toContain("Tips:");
  });
});
