import { describe, expect, it } from "vitest";
import { resolveReadOptionRetryArgs } from "../../../../src/sdk/agent/command-recovery.js";
import { isReadOutputSessionReference } from "../../../../src/sdk/read-output-session.js";

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
    ["search", ["search", "--", "--toon"], "--toon"],
    ["get", ["get", "pm-one", "--depth", "full"], "--depth"],
    ["get", ["get", "pm-one", "--full"], "--full"],
    ["get", ["get", "pm-one", "--toon=true"], "--toon=true"],
  ])("declines an ambiguous or conflicting rewrite on %s", (command, argv, unknown) => {
    expect(resolveReadOptionRetryArgs(command, argv as string[], unknown as string)).toBeUndefined();
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
