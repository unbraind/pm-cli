import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness(["../../../scripts/smoke-cleanup.mjs"]);

const SCRIPT = "scripts/smoke-npx-from-pack.mjs";
const SCRIPT_ABS = path.join(process.cwd(), "scripts/smoke-npx-from-pack.mjs");

interface ExecResponses {
  packOutput?: string;
  /** Map a logical pm sub-command to its stdout (JSON string or text). */
  pmResponse?: (commandName: string, pmArgs: string[]) => string;
  /** Throw on the first `npx ... pm --version` call, succeed on npm-exec fallback. */
  npxVersionFails?: boolean;
  /** Override direct (`npx <spec>`) responses. */
  directResponse?: (args: string[]) => string;
  aliasResponse?: (args: string[]) => string;
}

function defaultPm(commandName: string): string {
  if (commandName === "--version") return "2026.6.14\n";
  if (commandName === "init") return JSON.stringify({ ok: true });
  if (commandName === "install") {
    return JSON.stringify({ details: { installed_all: true, installed_count: 9 } });
  }
  if (commandName === "package") {
    return JSON.stringify({ details: { packages: [{ alias: "a" }, { alias: "b" }, { alias: "c" }, { alias: "d" }] } });
  }
  if (commandName === "create") return JSON.stringify({ item: { id: "pm-pack-smoke-item" } });
  if (commandName === "calendar") return JSON.stringify({ summary: { events: 1 } });
  if (commandName === "upgrade") return JSON.stringify({ summary: { requested_packages: true }, packages: [] });
  return "{}";
}

function buildExecFileSync(responses: ExecResponses) {
  let npxVersionFailedOnce = false;
  const pm = responses.pmResponse ?? ((c: string) => defaultPm(c));
  return vi.fn((command: string, args: string[]) => {
    if (command === "npm" && args[0] === "pack") {
      return responses.packOutput ?? "pm-cli-2026.6.14.tgz\n";
    }
    if (command === "npm" && args[0] === "exec") {
      // npm-exec fallback for runPackedPm.
      const idx = args.indexOf("pm");
      const pmArgs = idx >= 0 ? args.slice(idx + 1) : [];
      return pm(pmArgs[0], pmArgs);
    }
    if (command === "npx" && String(args[1] ?? "").startsWith("file:")) {
      if (responses.directResponse) return responses.directResponse(args);
      if (args.includes("--version")) return "2026.6.14\n";
      if (args.includes("--help")) return "Usage: pm\n";
    }
    if (command === "npx" && args.includes("--package") && args.includes("pm-cli")) {
      if (responses.aliasResponse) return responses.aliasResponse(args);
      if (args.includes("--version")) return "2026.6.14\n";
      if (args.includes("--help")) return "Usage: pm-cli\n";
    }
    if (command === "npx" && args.includes("--package") && args.includes("pm")) {
      const pmArgs = args.slice(args.indexOf("pm") + 1);
      const commandName = pmArgs[0];
      if (commandName === "--version" && responses.npxVersionFails && !npxVersionFailedOnce) {
        npxVersionFailedOnce = true;
        const error = new Error("npx direct package failed") as Error & { stderr?: string };
        error.stderr = "npx stderr";
        throw error;
      }
      return pm(commandName, pmArgs);
    }
    return "";
  });
}

function mockFs() {
  vi.doMock("node:fs", () => ({
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(() => "/tmp/pm-pack-smoke"),
  }));
}

describe("smoke-npx-from-pack", () => {
  it("runs the packed smoke (npx fallback to npm exec) and warns on cleanup failure", async () => {
    const cleanupTempRoot = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot }));
    mockFs();
    vi.doMock("node:child_process", () => ({ execFileSync: buildExecFileSync({ npxVersionFails: true }) }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await harness.importModule(SCRIPT);
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("npx packed package smoke passed");
    expect(cleanupTempRoot).toHaveBeenCalledWith("/tmp/pm-pack-smoke");
    expect(String(warnSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("[pm-pack-smoke] cleanup warning");
  });

  it("runs cleanly when cleanup succeeds (no warning, readCommandError non-Error tolerated)", async () => {
    const cleanupTempRoot = vi.fn(() => undefined);
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot }));
    mockFs();
    vi.doMock("node:child_process", () => ({ execFileSync: buildExecFileSync({}) }));

    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await harness.importModule(SCRIPT);
    expect(cleanupTempRoot).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("throws when npm pack produces no tarball name", async () => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot: vi.fn() }));
    mockFs();
    vi.doMock("node:child_process", () => ({ execFileSync: buildExecFileSync({ packOutput: "   \n" }) }));
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow("npm pack did not produce a tarball name");
  });

  it("throws when the npx fallback also produces empty version output", async () => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot: vi.fn() }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({
        npxVersionFails: true,
        // npm exec fallback returns empty for --version -> empty output throw.
        pmResponse: (commandName) => (commandName === "--version" ? "" : defaultPm(commandName)),
      }),
    }));
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow("npx fallback produced empty output");
  });

  it("returns empty fallback output for a non --version command without throwing", async () => {
    // npm-exec fallback returns empty AND args has no --version -> early `return output`.
    const cleanupTempRoot = vi.fn();
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot }));
    mockFs();
    let initFellBack = false;
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn((command: string, args: string[]) => {
        if (command === "npm" && args[0] === "pack") return "pm-cli-2026.6.14.tgz\n";
        if (command === "npm" && args[0] === "exec") {
          const idx = args.indexOf("pm");
          const pmArgs = idx >= 0 ? args.slice(idx + 1) : [];
          if (pmArgs[0] === "init") {
            initFellBack = true;
            return ""; // empty, not --version -> early return output
          }
          return defaultPm(pmArgs[0]);
        }
        if (command === "npx" && String(args[1] ?? "").startsWith("file:")) {
          if (args.includes("--version")) return "2026.6.14\n";
          if (args.includes("--help")) return "Usage: pm\n";
        }
        if (command === "npx" && args.includes("--package") && args.includes("pm-cli")) {
          if (args.includes("--version")) return "2026.6.14\n";
          if (args.includes("--help")) return "Usage: pm-cli\n";
        }
        if (command === "npx" && args.includes("--package") && args.includes("pm")) {
          const pmArgs = args.slice(args.indexOf("pm") + 1);
          if (pmArgs[0] === "init") {
            // Force the npx call to fail so the fallback (empty) path is taken.
            throw new Error("npx init failed");
          }
          return defaultPm(pmArgs[0]);
        }
        return "";
      }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await harness.importModule(SCRIPT);
    expect(initFellBack).toBe(true);
  });

  it.each([
    {
      name: "empty version output",
      direct: undefined,
      pm: (c: string) => (c === "--version" ? "" : defaultPm(c)),
      expected: /returned empty version output/,
    },
    {
      name: "direct version mismatch",
      direct: (args: string[]) => (args.includes("--version") ? "9.9.9\n" : "Usage: pm\n"),
      pm: undefined,
      expected: /Bare npx package smoke returned/,
    },
    {
      name: "direct help empty",
      direct: (args: string[]) => (args.includes("--version") ? "2026.6.14\n" : ""),
      pm: undefined,
      expected: /Bare npx package smoke returned empty help/,
    },
    {
      name: "alias version mismatch",
      alias: (args: string[]) => (args.includes("--version") ? "0.0.0\n" : "Usage: pm-cli\n"),
      pm: undefined,
      expected: /pm-cli bin alias smoke returned/,
    },
    {
      name: "alias help empty",
      alias: (args: string[]) => (args.includes("--version") ? "2026.6.14\n" : ""),
      pm: undefined,
      expected: /pm-cli bin alias smoke returned empty help/,
    },
    {
      name: "install-all unexpected payload",
      pm: (c: string) => (c === "install" ? JSON.stringify({ details: { installed_all: false } }) : defaultPm(c)),
      expected: /Packed install-all smoke returned unexpected payload/,
    },
    {
      name: "catalog unexpected payload",
      pm: (c: string) =>
        c === "package" ? JSON.stringify({ details: { packages: [{ alias: "a" }] } }) : defaultPm(c),
      expected: /Packed package catalog smoke returned unexpected payload/,
    },
    {
      name: "calendar unexpected payload",
      pm: (c: string) => (c === "calendar" ? JSON.stringify({ summary: { events: 0 } }) : defaultPm(c)),
      expected: /Packed calendar smoke returned unexpected payload/,
    },
    {
      name: "upgrade unexpected payload",
      pm: (c: string) => (c === "upgrade" ? JSON.stringify({ summary: { requested_packages: false } }) : defaultPm(c)),
      expected: /Packed package upgrade smoke returned unexpected payload/,
    },
  ])("throws on $name", async ({ direct, alias, pm, expected }) => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot: vi.fn() }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({
        directResponse: direct,
        aliasResponse: alias as ((args: string[]) => string) | undefined,
        pmResponse: pm,
      }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(expected);
  });

  it("resolves .cmd wrappers on win32", async () => {
    const cleanupTempRoot = vi.fn();
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot }));
    mockFs();
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "npm.cmd" && args[0] === "pack") return "pm-cli-2026.6.14.tgz\n";
      if (command === "npx.cmd" && String(args[1] ?? "").startsWith("file:")) {
        if (args.includes("--version")) return "2026.6.14\n";
        if (args.includes("--help")) return "Usage: pm\n";
      }
      if (command === "npx.cmd" && args.includes("--package") && args.includes("pm-cli")) {
        if (args.includes("--version")) return "2026.6.14\n";
        if (args.includes("--help")) return "Usage: pm-cli\n";
      }
      if (command === "npx.cmd" && args.includes("--package") && args.includes("pm")) {
        const pmArgs = args.slice(args.indexOf("pm") + 1);
        return defaultPm(pmArgs[0]);
      }
      return "";
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    try {
      await harness.importModule(SCRIPT);
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
    expect(execFileSync.mock.calls.some((call) => call[0] === "npm.cmd")).toBe(true);
    expect(execFileSync.mock.calls.some((call) => call[0] === "npx.cmd")).toBe(true);
  });

  it("readCommandError renders non-Error throwables and Errors carrying stdout/blank stderr", async () => {
    // npx --version throws a NON-Error; npm-exec fallback returns empty -> empty-output throw
    // whose message includes readCommandError(npxError) where npxError is a string.
    const cleanupTempRoot = vi.fn();
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn((command: string, args: string[]) => {
        if (command === "npm" && args[0] === "pack") return "pm-cli-2026.6.14.tgz\n";
        if (command === "npm" && args[0] === "exec") return ""; // fallback empty
        if (command === "npx" && args.includes("--package") && args.includes("pm")) {
          // string (non-Error) throwable -> readCommandError returns String(error)
          throw "raw-npx-failure-string";
        }
        return "";
      }),
    }));
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow("raw-npx-failure-string");
  });

  it("readCommandError formats an Error with stdout present and a blank stderr value", async () => {
    const cleanupTempRoot = vi.fn();
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn((command: string, args: string[]) => {
        if (command === "npm" && args[0] === "pack") return "pm-cli-2026.6.14.tgz\n";
        if (command === "npm" && args[0] === "exec") return ""; // fallback empty
        if (command === "npx" && args.includes("--package") && args.includes("pm")) {
          const error = new Error("npx boom") as Error & { stderr?: string; stdout?: string };
          error.stderr = "npx stderr line"; // `"stderr" in error` truthy value branch
          error.stdout = "npx stdout detail"; // `"stdout" in error` true, value truthy
          throw error;
        }
        return "";
      }),
    }));
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(/npx fallback produced empty output[\s\S]*npx stdout detail/);
  });

  it("readCommandError tolerates Errors whose stderr/stdout keys are present but nullish", async () => {
    const cleanupTempRoot = vi.fn();
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn((command: string, args: string[]) => {
        if (command === "npm" && args[0] === "pack") return "pm-cli-2026.6.14.tgz\n";
        if (command === "npm" && args[0] === "exec") return ""; // fallback empty
        if (command === "npx" && args.includes("--package") && args.includes("pm")) {
          const error = new Error("npx boom blank") as Error & { stderr?: string; stdout?: string };
          error.stderr = undefined; // key present, nullish -> stderr `?? ""`
          error.stdout = undefined; // key present, nullish -> stdout `?? ""`
          throw error;
        }
        return "";
      }),
    }));
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(/npx fallback produced empty output[\s\S]*npx boom blank/);
  });

  it("throws when the direct bare-npx version is empty (empty-output fallback message)", async () => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot: vi.fn() }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({
        directResponse: (args) => (args.includes("--version") ? "" : "Usage: pm\n"),
      }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(/Bare npx package smoke returned empty output instead of/);
  });

  it("throws when the pm-cli alias version is empty (empty-output fallback message)", async () => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot: vi.fn() }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({
        aliasResponse: (args) => (args.includes("--version") ? "" : "Usage: pm-cli\n"),
      }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(/pm-cli bin alias smoke returned empty output instead of/);
  });

  it("throws when the calendar payload omits summary.events entirely", async () => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot: vi.fn() }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({
        pmResponse: (commandName) => (commandName === "calendar" ? JSON.stringify({}) : defaultPm(commandName)),
      }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(/Packed calendar smoke returned unexpected payload/);
  });

  it("does not auto-run when argv[1] is not the script path", async () => {
    const cleanupTempRoot = vi.fn();
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot }));
    mockFs();
    const execFileSync = buildExecFileSync({});
    vi.doMock("node:child_process", () => ({ execFileSync }));
    process.argv = ["node", "/some/other/file.mjs"];
    await harness.importModule(SCRIPT);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
