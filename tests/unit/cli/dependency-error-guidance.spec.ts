import { describe, expect, it } from "vitest";
import {
  classifyPmCliError,
  formatPmCliErrorForJson,
} from "../../../src/cli/error-guidance.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";

describe("dependency error guidance", () => {
  it("preserves malformed-flag identity in JSON and classification envelopes", () => {
    const context = {
      code: "dependency_flag_value_invalid",
      flag: "--dep-remove",
      value: "OTHER,related",
      required: "Use a bare item id or an explicit structured entry.",
    };

    expect(
      formatPmCliErrorForJson(
        "Invalid --dep-remove value",
        EXIT_CODE.USAGE,
        context,
      ),
    ).toMatchObject({
      code: "dependency_flag_value_invalid",
      flag: "--dep-remove",
      value: "OTHER,related",
    });
    expect(classifyPmCliError("Invalid --dep-remove value", context)).toMatchObject(
      {
        flag: "--dep-remove",
        value: "OTHER,related",
      },
    );
  });

  it("preserves unmatched selectors and available edge identities", () => {
    const unmatchedSelectors = [
      { id: "pm-missing", kind: "related", source_kind: "manual" },
    ];
    const availableDependencies = [
      { id: "pm-real", kind: "related", source_kind: "manual" },
    ];

    expect(
      formatPmCliErrorForJson(
        "Dependency removal did not match a stored edge.",
        EXIT_CODE.NOT_FOUND,
        {
          code: "dependency_remove_no_match",
          required: "Use an exact stored dependency selector.",
          unmatched_selectors: unmatchedSelectors,
          available_dependencies: availableDependencies,
        },
      ),
    ).toMatchObject({
      code: "dependency_remove_no_match",
      unmatched_selectors: unmatchedSelectors,
      available_dependencies: availableDependencies,
    });
  });
});
