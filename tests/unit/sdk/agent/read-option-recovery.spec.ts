import { describe, expect, it } from "vitest";
import { describeReadCompletenessControls, resolveReadCompletenessControls, resolveReadOptionRetryArgs } from "../../../../src/sdk/agent/command-recovery.js";
import { isReadOutputSessionReference } from "../../../../src/sdk/read-output-session.js";
import { PM_READ_OUTPUT_SURFACE_CONTRACTS } from "../../../../src/sdk/read-output-contracts.js";

type RetryCase = [command: string, argv: string[], unknown: string, expected: string[]];

/** Generate every equivalent completeness spelling from declared surface modes and depth domains. */
function completenessCases(): RetryCase[] {
  return PM_READ_OUTPUT_SURFACE_CONTRACTS.flatMap(({ command }): RetryCase[] => {
    const controls = resolveReadCompletenessControls(command);
    if (controls === undefined) return [];
    if (controls.depth_values.length > 0) {
      return controls.depth_values
        .filter((level) => !controls.declared_flags.includes(`--${level}`))
        .map((level) => [command, [command, `--${level}`], `--${level}`, [command, "--depth", level]]);
    }
    return [
      ...controls.modes.map((mode): RetryCase => [command, [command, "--depth", mode], "--depth", [command, `--${mode}`]]),
      [command, [command, "--depth=standard"], "--depth=standard", [command]],
    ];
  });
}

describe("read-option recovery", () => {
  it.each([
    ["context", ["context", "--full", "--json"], "--full", ["context", "--depth", "full", "--json"]],
    ["ctx", ["ctx", "--full"], "--full", ["ctx", "--depth", "full"]],
    ["list", ["list", "--depth", "full"], "--depth", ["list", "--full"]],
    ["search", ["search", "words with spaces", "--depth=full"], "--depth=full", ["search", "words with spaces", "--full"]],
    ["get", ["get", "pm-one", "--toon"], "--toon", ["get", "pm-one", "--output-format", "toon"]],
  ])("preserves intent on %s", (command, argv, unknown, expected) => {
    expect(resolveReadOptionRetryArgs(command, argv as string[], unknown as string)).toEqual(expected);
  });
  it.each([
    ["create", ["create", "Work", "--toon"], "--toon"],
    ["context", ["close", "pm-one", "--full"], "--full"],
    ["list", ["list", "--depth", "deep"], "--depth"],
    ["list", ["list", "--depth"], "--depth"],
    ["list", ["list", "--depth", "full", "--fields", "id"], "--depth"],
    ["context", ["context", "--full", "--depth=brief"], "--full"],
    ["context", ["context", "--full=true"], "--full=true"],
    ["context", ["context", "--full", "--full"], "--full"],
    ["context", ["context"], "--full"],
    ["get", ["get", "pm-one", "--toon", "--output-format=json"], "--toon"],
    ["get", ["--json", "get", "pm-one", "--toon"], "--toon"],
    ["list", ["list", "--toon", "--json=true"], "--toon"],
    ["search", ["search", "--", "--toon"], "--toon"],
    ["get", ["get", "pm-one", "--depth", "full"], "--depth"],
    ["get", ["get", "pm-one", "--full"], "--full"],
    ["get", ["get", "pm-one", "--toon=true"], "--toon=true"],
  ])("declines an ambiguous or conflicting rewrite on %s", (command, argv, unknown) => {
    expect(resolveReadOptionRetryArgs(command, argv as string[], unknown as string)).toBeUndefined();
  });
});

describe("contract-derived completeness corrections (GH-1626)", () => {
  const cases = completenessCases();

  it("covers every read surface that declares completeness controls", () => {
    const surfaces = PM_READ_OUTPUT_SURFACE_CONTRACTS.map(({ command }) => command).filter((command) => resolveReadCompletenessControls(command) !== undefined);
    expect(new Set(cases.map(([command]) => command))).toEqual(new Set(surfaces));
    expect(surfaces).toEqual(expect.arrayContaining(["get", "list", "search", "context", "history", "activity", "deps", "health"]));
    expect(cases).toEqual(expect.arrayContaining([
      ["get", ["get", "--brief"], "--brief", ["get", "--depth", "brief"]],
      ["list", ["list", "--depth", "brief"], "--depth", ["list", "--brief"]],
      ["search", ["search", "--depth", "full"], "--depth", ["search", "--full"]],
      ["list", ["list", "--depth=standard"], "--depth=standard", ["list"]],
    ]));
  });

  it.each(cases)("rewrites %s %j only into flags that command declares", (command, argv, unknown, expected) => {
    const retry = resolveReadOptionRetryArgs(command, argv, unknown);
    expect(retry).toEqual(expected);
    const declared = resolveReadCompletenessControls(command)?.declared_flags ?? [];
    expect(retry?.filter((token) => token.startsWith("--")).every((flag) => declared.includes(flag))).toBe(true);
  });

  it.each([
    ["deps", ["--json", "item", "deps", "pm-one", "--depth", "full"], "--depth", ["--json", "item", "deps", "pm-one", "--full"]],
    ["health", ["ops", "health", "--depth=summary"], "--depth=summary", ["ops", "health", "--summary"]],
    ["get", ["get", "pm-one", "--deep", "--json"], "--deep", ["get", "pm-one", "--depth", "deep", "--json"]],
    ["search", ["search", "brief words", "--depth", "STANDARD", "--limit", "3"], "--depth", ["search", "brief words", "--limit", "3"]],
  ])("preserves operands and canonical noun-first paths on %s", (command, argv, unknown, expected) => {
    expect(resolveReadOptionRetryArgs(command, argv, unknown)).toEqual(expected);
  });

  it.each([
    ["search", ["search", "probe", "--depth", "brief"], "--depth"],
    ["list", ["list", "--depth", "summary"], "--depth"],
    ["get", ["get", "pm-one", "--compact"], "--compact"],
    ["get", ["get", "pm-one", "--brief", "--fields", "id"], "--brief"],
    ["get", ["get", "pm-one", "--brief", "--full"], "--brief"],
    ["context", ["context", "--brief=true"], "--brief=true"],
    ["context", ["context", "--brief", "--for", "orient"], "--brief"],
    ["list", ["list", "--depth", "brief", "--output-include", "full"], "--depth"],
    ["deps", ["get", "pm-one", "--depth", "full"], "--depth"],
    ["next", ["next", "--depth", "full"], "--depth"],
  ])("declines missing, conflicting or foreign completeness rewrites on %s", (command, argv, unknown) => {
    expect(resolveReadOptionRetryArgs(command, argv, unknown)).toBeUndefined();
  });

  it("describes each command's own completeness vocabulary", () => {
    expect(describeReadCompletenessControls(resolveReadCompletenessControls("get")!)).toBe("--depth brief|standard|deep|full, --full");
    expect(describeReadCompletenessControls(resolveReadCompletenessControls("search")!)).toBe("--compact, --full");
    expect(describeReadCompletenessControls(resolveReadCompletenessControls("ctx")!)).toBe("--depth brief|standard|deep|full");
    expect(resolveReadCompletenessControls("next")).toBeUndefined();
    expect(resolveReadCompletenessControls("create")).toBeUndefined();
  });
});

describe("session-reference narrowing", () => {
  it("recognizes the emitted reference while rejecting ordinary, malformed and unrelated rows", () => {
    expect(isReadOutputSessionReference({ id: "pm-one", context_ref: "session:orientation:pm-one" })).toBe(true);
    for (const value of [null, 1, {}, { id: 1 }, { id: "pm-one" }, { id: "pm-one", context_ref: 1 },
      { id: "pm-one", context_ref: "document:pm-one" }, { id: "pm-one", context_ref: "session:orientation:pm-other" }]) {
      expect(isReadOutputSessionReference(value)).toBe(false);
    }
  });
});
