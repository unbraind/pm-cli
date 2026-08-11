/**
 * @module tests/unit/sdk/claim-public-surface
 */
import { describe, expect, it } from "vitest";
import {
  PmCliError,
  isAlreadyClaimedError,
} from "../../../src/sdk/index.js";
import { isAlreadyClaimedError as isCoreAlreadyClaimedError } from "../../../src/sdk/core.js";

describe("claim lifecycle public surface", () => {
  it("exposes the stable lost-race predicate from both supported SDK entrypoints", () => {
    const lostRace = new PmCliError("claimed", 3, {
      code: "already_claimed_by",
    });
    const unrelated = new PmCliError("other", 3, { code: "other" });

    expect(isAlreadyClaimedError(lostRace)).toBe(true);
    expect(isCoreAlreadyClaimedError(lostRace)).toBe(true);
    expect(isAlreadyClaimedError(unrelated)).toBe(false);
    expect(isAlreadyClaimedError(new Error("already_claimed_by"))).toBe(false);
    expect(
      isAlreadyClaimedError(
        Object.assign(new Error("cross-bundle"), {
          name: "PmCliError",
          context: { code: "already_claimed_by" },
        }),
      ),
    ).toBe(true);
  });
});
