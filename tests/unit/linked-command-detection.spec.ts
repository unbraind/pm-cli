import { describe, expect, it } from "vitest";

import { isPmExecutableToken } from "../../src/cli/commands/test/linked-command-detection.js";

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
