import { describe, expect, it } from "vitest";

import {
  applyLegacyNoneCollectionNormalizers,
  assertNoLegacyNoneToken,
  assertNoLegacyNoneTokens,
  isLegacyNoneToken,
} from "../../../src/cli/commands/legacy-none-tokens.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";

describe("isLegacyNoneToken", () => {
  it("returns false for undefined", () => {
    expect(isLegacyNoneToken(undefined)).toBe(false);
  });

  it("matches none/null case-insensitively with surrounding whitespace", () => {
    expect(isLegacyNoneToken("none")).toBe(true);
    expect(isLegacyNoneToken("  NULL ")).toBe(true);
    expect(isLegacyNoneToken("None")).toBe(true);
  });

  it("returns false for other values", () => {
    expect(isLegacyNoneToken("")).toBe(false);
    expect(isLegacyNoneToken("deadline")).toBe(false);
  });
});

describe("assertNoLegacyNoneToken", () => {
  it("does nothing for non-legacy values", () => {
    expect(() => assertNoLegacyNoneToken("ok", "--deadline")).not.toThrow();
    expect(() => assertNoLegacyNoneToken(undefined, "--deadline")).not.toThrow();
  });

  it("throws without hint when no replacement hint is given", () => {
    try {
      assertNoLegacyNoneToken("none", "--deadline");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PmCliError);
      expect((error as PmCliError).message).toBe('--deadline no longer accepts "none" or "null".');
    }
  });

  it("throws with replacement hint appended", () => {
    try {
      assertNoLegacyNoneToken("null", "--deadline", "Use --unset deadline.");
      throw new Error("expected throw");
    } catch (error) {
      expect((error as PmCliError).message).toBe('--deadline no longer accepts "none" or "null". Use --unset deadline.');
    }
  });
});

describe("assertNoLegacyNoneTokens", () => {
  it("does nothing for empty or undefined collections", () => {
    expect(() => assertNoLegacyNoneTokens(undefined, "--dep")).not.toThrow();
    expect(() => assertNoLegacyNoneTokens([], "--dep")).not.toThrow();
  });

  it("does nothing when no legacy token is present", () => {
    expect(() => assertNoLegacyNoneTokens(["a", "b"], "--dep")).not.toThrow();
  });

  it("throws when a legacy token is present (no hint)", () => {
    try {
      assertNoLegacyNoneTokens(["a", "none"], "--dep");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PmCliError);
      expect((error as PmCliError).message).toBe('--dep no longer accepts "none" or "null".');
    }
  });

  it("throws with replacement hint appended", () => {
    try {
      assertNoLegacyNoneTokens(["null"], "--dep", "Use --clear-deps.");
      throw new Error("expected throw");
    } catch (error) {
      expect((error as PmCliError).message).toBe('--dep no longer accepts "none" or "null". Use --clear-deps.');
    }
  });
});

describe("applyLegacyNoneCollectionNormalizers", () => {
  it("rejects malformed collection entries with a usage error", () => {
    expect(() =>
      applyLegacyNoneCollectionNormalizers(
        { dep: ["none", 1] },
        [{ optionKey: "dep", clearFlagKey: "clearDeps", valueFlag: "--dep", clearFlag: "--clear-deps" }],
      ),
    ).toThrow(expect.objectContaining({ exitCode: EXIT_CODE.USAGE, message: "--dep entries must be strings." }));
  });
});
