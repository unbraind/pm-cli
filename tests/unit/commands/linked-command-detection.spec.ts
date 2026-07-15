import { describe, expect, it } from "vitest";

import {
  extractReferencedPmItemIdsFromCommand,
  isPmExecutableToken,
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
