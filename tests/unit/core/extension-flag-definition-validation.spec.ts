import { describe, expect, it } from "vitest";
import {
  describeExtensionLongFlagFailure,
  findExtensionFlagTokenFailure,
  validateExtensionLongFlagToken,
} from "../../../src/core/extensions/flag-definition-validation.js";

import { GLOBAL_FLAG_CONTRACTS, SUBCOMMAND_GLOBAL_FLAG_CONTRACTS } from "../../../src/sdk/cli-contracts/flag-contracts.js";

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

  it("publishes exactly the reservation scope enforced for every global spelling", () => {
    for (const contract of GLOBAL_FLAG_CONTRACTS) {
      const inherited = SUBCOMMAND_GLOBAL_FLAG_CONTRACTS.some((entry) => entry.flag === contract.flag);
      expect(contract).toMatchObject({ reservation_scope: inherited ? "inherited" : "root_only" });
      for (const spelling of [contract.flag, ...(contract.aliases ?? [])]) {
        expect(validateExtensionLongFlagToken(spelling)).toBe(inherited ? "host_owned_flag_collision" : null);
      }
    }
    expect(GLOBAL_FLAG_CONTRACTS.find((entry) => entry.flag === "--explain")).toMatchObject({ reservation_scope: "root_only" });
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
