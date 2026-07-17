import { describe, expect, it } from "vitest";

import {
  extractReferencedPmItemIdsFromCommand,
  firstPositionalToken,
  isPmExecutableToken,
  PM_ITEM_REFERENCE_FLAGS_WITH_VALUE,
  parseNpxCommand,
} from "../../../src/sdk/test/linked-command-detection.js";

describe("isPmExecutableToken", () => {
  it("detects bare and path-suffixed pm executables, including Windows forms", () => {
    expect(isPmExecutableToken("pm")).toBe(true);
    expect(isPmExecutableToken("pm.cmd")).toBe(true);
    expect(isPmExecutableToken("pm.exe")).toBe(true);
    expect(isPmExecutableToken("/usr/local/bin/pm")).toBe(true);
    expect(isPmExecutableToken("C:/tools/pm.cmd")).toBe(true);
    expect(isPmExecutableToken("node_modules/.bin/pm.exe")).toBe(true);
  });

  it("does not treat unrelated tokens as pm executables", () => {
    expect(isPmExecutableToken("npm")).toBe(false);
    expect(isPmExecutableToken("pmcli")).toBe(false);
    expect(isPmExecutableToken("pnpm")).toBe(false);
  });
});

describe("npx command-string parsing", () => {
  it("preserves pm invocations passed through call flags", () => {
    expect(parseNpxCommand(["-c", "pm", "get", "pm-dead"])).toEqual({
      command: "pm",
      args: ["get", "pm-dead"],
    });
    expect(parseNpxCommand(["--call=pm", "get", "pm-dead"])).toEqual({
      command: "pm",
      args: ["get", "pm-dead"],
    });
    expect(parseNpxCommand(["--call="])).toBeNull();
    expect(
      extractReferencedPmItemIdsFromCommand("npx --call 'pm get pm-dead'"),
    ).toEqual(["pm-dead"]);
  });
});

describe("item-reference positional parsing", () => {
  it("skips command and global option values before the item positional", () => {
    expect(
      extractReferencedPmItemIdsFromCommand(
        "pm get --format json --at 2026-07-15 pm-dead",
      ),
    ).toEqual(["pm-dead"]);
    expect(
      extractReferencedPmItemIdsFromCommand(
        "pm history --limit 10 --field status pm-beef",
      ),
    ).toEqual(["pm-beef"]);
    expect(
      extractReferencedPmItemIdsFromCommand(
        "pm --author release-bot get --format json pm-cafe",
      ),
    ).toEqual(["pm-cafe"]);
  });

  it("does not confuse pm-shaped option values with the item positional", () => {
    expect(
      extractReferencedPmItemIdsFromCommand(
        "pm update --parent pm-parent --assignee pm-owner pm-target",
      ),
    ).toEqual(["pm-target"]);
    expect(
      extractReferencedPmItemIdsFromCommand(
        "pm get --format=pm-format --json pm-target",
      ),
    ).toEqual(["pm-target"]);
  });

  it("preserves boolean flags, option terminators, and the helper default", () => {
    expect(
      extractReferencedPmItemIdsFromCommand("pm get --json pm-dead"),
    ).toEqual(["pm-dead"]);
    expect(extractReferencedPmItemIdsFromCommand("pm get -- pm-beef")).toEqual([
      "pm-beef",
    ]);
    expect(firstPositionalToken(["--json", "pm-cafe"])).toBe("pm-cafe");
    expect(
      firstPositionalToken(
        ["--format", "json", "pm-dead"],
        PM_ITEM_REFERENCE_FLAGS_WITH_VALUE.get,
      ),
    ).toBe("pm-dead");
  });
});

describe("id-prefix normalization", () => {
  it("trims trailing dash runs linearly and rejects empty prefixes", () => {
    expect(
      extractReferencedPmItemIdsFromCommand("pm get pm-dead", "PM--"),
    ).toEqual(["pm-dead"]);
    expect(
      extractReferencedPmItemIdsFromCommand("pm get pm-dead", "----"),
    ).toEqual([]);
    expect(
      extractReferencedPmItemIdsFromCommand("pm get x-live", `x${"-".repeat(64)}`),
    ).toEqual(["x-live"]);
    // Pre-fix, the /-+$/ trim backtracked quadratically on a long dash run
    // followed by a non-dash tail and never completed inside the suite
    // timeout (CodeQL alert 27).
    const hostilePrefix = `${"-".repeat(50_000)}x`;
    expect(
      extractReferencedPmItemIdsFromCommand("pm get pm-dead", hostilePrefix),
    ).toEqual([]);
  });
});
