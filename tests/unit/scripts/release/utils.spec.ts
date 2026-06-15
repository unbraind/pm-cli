import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../../helpers/scriptModule";

type UtilsModule = typeof import("../../../../scripts/release/utils.mjs");

const harness = createScriptHarness();

async function loadUtils(token: string): Promise<UtilsModule> {
  return harness.importModule<UtilsModule>("scripts/release/utils.mjs", token);
}

describe("scripts/release/utils: pure flag helpers", () => {
  it("parseFlags handles positionals, valued flags, and bare boolean flags", async () => {
    const utils = await loadUtils("utilsParse");
    const { flags, positionals } = utils.parseFlags(["pos1", "--name", "value", "--bare", "--last"]);
    expect(positionals).toEqual(["pos1"]);
    expect(flags.get("name")).toBe("value");
    expect(flags.get("bare")).toBe(true);
    expect(flags.get("last")).toBe(true);
  });

  it("parseFlags collects multiple positionals and a flag whose value follows another flag", async () => {
    const utils = await loadUtils("utilsParseMix");
    const parsed = utils.parseFlags(["--json", "--telemetry-mode", "required", "positional", "--skip-dogfood"]);
    expect(parsed.positionals).toEqual(["positional"]);
    expect(parsed.flags.get("json")).toBe(true);
    expect(parsed.flags.get("telemetry-mode")).toBe("required");
    expect(parsed.flags.get("skip-dogfood")).toBe(true);
  });

  it("requireFlag returns the string value or fails when absent/boolean", async () => {
    const utils = await loadUtils("utilsRequire");
    expect(utils.requireFlag(new Map([["x", "42"]]), "x", "need x")).toBe("42");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = harness.mockProcessExit();
    expect(() => utils.requireFlag(new Map<string, string | boolean>(), "x", "need x")).toThrow("EXIT:1");
    expect(() => utils.requireFlag(new Map<string, string | boolean>([["x", true]]), "x", "need x")).toThrow("EXIT:1");
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("need x"))).toBe(true);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("flagString and flagBool normalize present, boolean, truthy, falsy, and fallback values", async () => {
    const utils = await loadUtils("utilsFlags");
    expect(utils.flagString(new Map([["a", "v"]]), "a")).toBe("v");
    expect(utils.flagString(new Map<string, string | boolean>([["a", true]]), "a", "fb")).toBe("fb");
    expect(utils.flagString(new Map(), "a")).toBeNull();
    expect(utils.flagBool(new Map(), "b", true)).toBe(true);
    expect(utils.flagBool(new Map<string, string | boolean>([["b", true]]), "b")).toBe(true);
    expect(utils.flagBool(new Map([["b", "YES"]]), "b")).toBe(true);
    expect(utils.flagBool(new Map([["b", "off"]]), "b")).toBe(false);
    expect(utils.flagBool(new Map([["b", "maybe"]]), "b", true)).toBe(true);
  });

  it("utcDateKey and utcIsoDate format dates deterministically", async () => {
    const utils = await loadUtils("utilsDates");
    expect(utils.utcDateKey(new Date(Date.UTC(2026, 0, 5)))).toBe("2026.1.5");
    expect(utils.utcIsoDate(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-01-05");
    expect(utils.utcDateKey(new Date(Date.UTC(2026, 5, 14, 12, 0, 0)))).toBe("2026.6.14");
    expect(utils.utcIsoDate(new Date(Date.UTC(2026, 5, 4, 12, 0, 0)))).toBe("2026-06-04");
  });

  it("utcDateKey and utcIsoDate default to the current date when called without an argument", async () => {
    const utils = await loadUtils("utilsDatesDefault");
    expect(utils.utcDateKey()).toMatch(/^\d{4}\.\d{1,2}\.\d{1,2}$/u);
    expect(utils.utcIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });
});

describe("scripts/release/utils: commandFor", () => {
  it("appends .cmd on win32 and leaves binaries unchanged otherwise", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    let utils = await loadUtils("utilsCmdLinux");
    expect(utils.commandFor("pnpm")).toBe("pnpm");
    vi.resetModules();
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    utils = await loadUtils("utilsCmdWin");
    expect(utils.commandFor("pnpm")).toBe("pnpm.cmd");
    expect(utils.commandFor("npm.cmd")).toBe("npm.cmd");
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  });
});

describe("scripts/release/utils: runCommand", () => {
  it("captures output, defaults status, and fails with stderr detail", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("json-ok")) {
        return { status: 0, stdout: '{"ok":true}', stderr: "" };
      }
      if (joined.includes("allowed-failure")) {
        return { status: 5, stdout: "", stderr: "allowed failure" };
      }
      return { status: 0, stdout: "ok", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const utils = await loadUtils("utilsRunOk");

    const success = utils.runCommand("pm", ["json-ok"], { capture: true, cwd: "/tmp/pm", shell: true });
    expect(success).toEqual({ status: 0, stdout: '{"ok":true}', stderr: "" });
    expect(spawnSync).toHaveBeenCalledWith(
      "pm",
      ["json-ok"],
      expect.objectContaining({
        cwd: "/tmp/pm",
        shell: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    const allowedFailure = utils.runCommand("pm", ["allowed-failure"], { allowFailure: true, capture: true });
    expect(allowedFailure.status).toBe(5);
    expect(allowedFailure.stderr).toContain("allowed failure");
  });

  it("leaves stdout/stderr empty on non-capture runs", async () => {
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 0, stdout: "out", stderr: "err" })) }));
    const utils = await loadUtils("utilsRunNoCapture");
    expect(utils.runCommand("echo", ["hi"])).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it("fails with captured stderr detail when status is null", async () => {
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: null, stdout: "", stderr: "  bad thing  " })),
    }));
    const utils = await loadUtils("utilsRunFail");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = harness.mockProcessExit();
    expect(() => utils.runCommand("boom", ["x"], { capture: true })).toThrow("EXIT:1");
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("Command failed"))).toBe(true);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("bad thing"))).toBe(true);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("does not fail on a non-zero status when allowFailure is set without capture", async () => {
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 3, stdout: "", stderr: "" })) }));
    const utils = await loadUtils("utilsRunAllow");
    expect(utils.runCommand("x", [], { allowFailure: true }).status).toBe(3);
  });

  it("fails with no stderr detail when captured stderr is empty (hard-failure)", async () => {
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 2, stdout: undefined, stderr: undefined })),
    }));
    const utils = await loadUtils("utilsRunEmptyStderr");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = harness.mockProcessExit();
    expect(() => utils.runCommand("boom", ["x"], { capture: true })).toThrow("EXIT:2");
    const failMsg = String(errorSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(failMsg).toContain("Command failed");
    expect(failMsg).not.toContain("\n");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("defaults captured stdout/stderr to empty strings when undefined", async () => {
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 0, stdout: undefined, stderr: undefined })),
    }));
    const utils = await loadUtils("utilsRunUndefStdio");
    expect(utils.runCommand("x", [], { capture: true })).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it("fails without capture by taking the empty-detail branch", async () => {
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 4, stdout: "", stderr: "" })) }));
    const utils = await loadUtils("utilsRunNoCapFail");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = harness.mockProcessExit();
    expect(() => utils.runCommand("boom", ["y"])).toThrow("EXIT:4");
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("Command failed"))).toBe(true);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("scripts/release/utils: runCommandJson", () => {
  it("parses captured stdout JSON", async () => {
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 0, stdout: '{"a":1}', stderr: "" })) }));
    const utils = await loadUtils("utilsJsonOk");
    expect(utils.runCommandJson("x", [])).toEqual({ a: 1 });
  });

  it("fails on invalid JSON output", async () => {
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 0, stdout: "not-json", stderr: "" })) }));
    const utils = await loadUtils("utilsJsonFail");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = harness.mockProcessExit();
    expect(() => utils.runCommandJson("x", [])).toThrow("EXIT:1");
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("Failed to parse JSON output"))).toBe(true);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
