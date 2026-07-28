import { describe, expect, it } from "vitest";
import {
  describeExtensionLongFlagFailure,
  findExtensionFlagTokenFailure,
  validateExtensionLongFlagToken,
} from "../../../src/core/extensions/flag-definition-validation.js";

describe("extension flag definition validation", () => {
  it("ignores absent declarations and classifies host-owned short aliases", () => {
    expect(validateExtensionLongFlagToken(undefined)).toBeNull();
    expect(validateExtensionLongFlagToken("--json")).toBe(
      "host_owned_flag_collision",
    );
    expect(findExtensionFlagTokenFailure(undefined, undefined)).toBeNull();
    expect(findExtensionFlagTokenFailure("--safe", "--json")).toEqual({
      token: "--json",
      failure: "host_owned_flag_collision",
    });
    expect(findExtensionFlagTokenFailure("--safe", "--json <mode>")).toEqual({
      token: "--json",
      failure: "host_owned_flag_collision",
    });
    expect(findExtensionFlagTokenFailure("missing-prefix", "-m")).toEqual({
      token: "missing-prefix",
      failure: "malformed_long_flag",
    });
    expect(findExtensionFlagTokenFailure("--safe", "-s")).toBeNull();
  });

  it("renders remediation for every stable failure classification", () => {
    expect(
      describeExtensionLongFlagFailure(
        "--json",
        "host_owned_flag_collision",
      ),
    ).toContain("context.global");
    expect(
      describeExtensionLongFlagFailure(
        "missing-prefix",
        "malformed_long_flag",
      ),
    ).toContain("double-dash");
  });
});
