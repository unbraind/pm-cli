import { describe, expect, it } from "vitest";
import {
  extractLongFlag,
  extractLongFlags,
  isPureSnakeCaseAlias,
} from "../../src/core/shared/option-alias-visibility.js";

describe("extractLongFlags", () => {
  it("returns a single long flag", () => {
    expect(extractLongFlags("--create-mode <value>")).toEqual(["--create-mode"]);
  });

  it("returns every long flag declared in the spec", () => {
    expect(extractLongFlags("--estimate, --estimated-minutes <value>")).toEqual([
      "--estimate",
      "--estimated-minutes",
    ]);
  });

  it("ignores short flags and value placeholders", () => {
    expect(extractLongFlags("-t, --title <value>")).toEqual(["--title"]);
    expect(extractLongFlags("-t <value>")).toEqual([]);
  });
});

describe("extractLongFlag", () => {
  it("returns the first long flag from a plain spec", () => {
    expect(extractLongFlag("--create-mode <value>")).toBe("--create-mode");
  });

  it("returns the first long flag when several are listed", () => {
    expect(extractLongFlag("--estimate, --estimated-minutes <value>")).toBe("--estimate");
    expect(extractLongFlag("-t, --title <value>")).toBe("--title");
  });

  it("returns the underscore long flag for snake aliases", () => {
    expect(extractLongFlag("--create_mode <value>")).toBe("--create_mode");
  });

  it("returns null when no long flag is present", () => {
    expect(extractLongFlag("-t <value>")).toBeNull();
    expect(extractLongFlag("")).toBeNull();
  });
});

describe("isPureSnakeCaseAlias", () => {
  it("hides a pure single-hyphen snake duplicate", () => {
    expect(isPureSnakeCaseAlias("--create-mode <value>", "--create_mode <value>")).toBe(true);
    expect(isPureSnakeCaseAlias("--why-now <value>", "--why_now <value>")).toBe(true);
  });

  it("hides a snake duplicate of a secondary long flag in a multi-flag spec", () => {
    // create/update register "--estimate, --estimated-minutes <value>" plus the
    // snake alias "--estimated_minutes".
    expect(
      isPureSnakeCaseAlias("--estimate, --estimated-minutes <value>", "--estimated_minutes <value>"),
    ).toBe(true);
  });

  it("hides multi-segment snake duplicates", () => {
    expect(isPureSnakeCaseAlias("--allow-audit-update", "--allow_audit_update")).toBe(true);
    expect(
      isPureSnakeCaseAlias("--definition-of-ready <value>", "--definition_of_ready <value>"),
    ).toBe(true);
  });

  it("hides namespaced partial-snake duplicates (only the last segment converted)", () => {
    // update-many uses --filter-assignee_filter for --filter-assignee-filter.
    expect(
      isPureSnakeCaseAlias("--filter-assignee-filter <value>", "--filter-assignee_filter <value>"),
    ).toBe(true);
  });

  it("keeps semantically distinct aliases visible", () => {
    expect(isPureSnakeCaseAlias("--acceptance-criteria <value>", "--ac <value>")).toBe(false);
    expect(isPureSnakeCaseAlias("--order <value>", "--rank <value>")).toBe(false);
    expect(isPureSnakeCaseAlias("--strict-exit", "--fail-on-warn")).toBe(false);
    expect(isPureSnakeCaseAlias("--project", "--local")).toBe(false);
    expect(isPureSnakeCaseAlias("--step-title <value>", "--step <value>")).toBe(false);
    expect(isPureSnakeCaseAlias("--decision-text <value>", "--decision <value>")).toBe(false);
  });

  it("does not hide flags without an interior hyphen in the canonical", () => {
    expect(isPureSnakeCaseAlias("--type <value>", "--type_alias <value>")).toBe(false);
  });

  it("does not treat an identical flag as an alias", () => {
    expect(isPureSnakeCaseAlias("--create-mode <value>", "--create-mode <value>")).toBe(false);
  });

  it("returns false when either flag has no long form", () => {
    expect(isPureSnakeCaseAlias("-t <value>", "--title <value>")).toBe(false);
    expect(isPureSnakeCaseAlias("--title <value>", "-t <value>")).toBe(false);
  });

  it("requires the alias to actually introduce an underscore", () => {
    // A kebab alias of a kebab canonical is not a snake duplicate.
    expect(isPureSnakeCaseAlias("--blocked-by <value>", "--blocked-by-alt <value>")).toBe(false);
  });
});
