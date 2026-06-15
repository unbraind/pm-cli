import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const TEMP_ROOTS: string[] = [];

function cacheBustToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function importRepoModule<T>(relativePath: string, queryPrefix: string): Promise<T> {
  const absolutePath = path.join(process.cwd(), relativePath);
  return (await import(`${pathToFileURL(absolutePath).href}?${queryPrefix}=${cacheBustToken()}`)) as T;
}

// Import without a cache-bust query so that relative `vi.doMock` targets of transitive
// imports (e.g. ./plugin-mcp-smoke-harness.mjs) still match — Vite propagates the parent
// query onto child specifiers, which would otherwise bypass the mock. afterEach() calls
// vi.resetModules(), so each test still re-executes the module's top-level code.
async function importRepoModuleStable<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(process.cwd(), relativePath);
  return (await import(pathToFileURL(absolutePath).href)) as T;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  TEMP_ROOTS.push(root);
  return root;
}

function mockProcessExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${String(code ?? "")}`);
  }) as never);
}

function restoreProcessState(): void {
  process.argv = [...ORIGINAL_ARGV];
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(async () => {
  restoreProcessState();
  process.exitCode = 0;
  globalThis.fetch = ORIGINAL_FETCH;
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:readline");
  vi.doUnmock("../../../scripts/plugin-mcp-smoke-harness.mjs");
  vi.doUnmock("../../../scripts/release/utils.mjs");
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of TEMP_ROOTS.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("lane-c scripts wave5: zero-coverage generators and build helpers", () => {
  it("covers gen-package-runtime-loaders write and check (in-sync + drift + exit) paths", async () => {
    // Drift path: readFile returns mismatched content, writeFile not used in --check.
    const writeFileDrift = vi.fn(async () => {});
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async () => "stale"),
      writeFile: writeFileDrift,
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = mockProcessExit();
    process.argv = ["node", "/nonmatching/runner", "--check"];
    const driftMod = await importRepoModule<{ main: () => Promise<void> }>(
      "scripts/gen-package-runtime-loaders.mjs",
      "genPkgDrift",
    );
    await expect(driftMod.main()).rejects.toThrow("EXIT:1");
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("Out of sync"))).toBe(true);
    expect(writeFileDrift).not.toHaveBeenCalled();
    exit.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    vi.resetModules();
    vi.doUnmock("node:fs/promises");

    // In-sync check path: readFile returns the exact generated content (write then compare).
    const generated = new Map<string, string>();
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async (target: string) => generated.get(String(target)) ?? ""),
      writeFile: vi.fn(async (target: string, content: string) => {
        generated.set(String(target), String(content));
      }),
    }));
    const writeLog = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "/nonmatching/runner"];
    const writeMod = await importRepoModule<{ main: () => Promise<void> }>(
      "scripts/gen-package-runtime-loaders.mjs",
      "genPkgWrite",
    );
    await writeMod.main();
    expect(writeLog.mock.calls.some((c) => String(c[0]).includes("Wrote"))).toBe(true);
    writeLog.mockRestore();
    vi.resetModules();
    vi.doUnmock("node:fs/promises");

    // Check in-sync: readFile returns generated content already populated.
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async (target: string) => generated.get(String(target)) ?? ""),
      writeFile: vi.fn(async () => {}),
    }));
    const syncLog = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "/nonmatching/runner", "--check"];
    const syncMod = await importRepoModule<{ main: () => Promise<void> }>(
      "scripts/gen-package-runtime-loaders.mjs",
      "genPkgSync",
    );
    await syncMod.main();
    expect(syncLog.mock.calls.some((c) => String(c[0]).includes("in sync"))).toBe(true);
    syncLog.mockRestore();
    vi.resetModules();
    vi.doUnmock("node:fs/promises");

    // Check path where readFile throws (missing target) -> caught -> "" -> drift exit.
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
      writeFile: vi.fn(async () => {}),
    }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exit2 = mockProcessExit();
    process.argv = ["node", "/nonmatching/runner", "--check"];
    const missMod = await importRepoModule<{ main: () => Promise<void> }>(
      "scripts/gen-package-runtime-loaders.mjs",
      "genPkgMissing",
    );
    await expect(missMod.main()).rejects.toThrow("EXIT:1");
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("Out of sync"))).toBe(true);
    exit2.mockRestore();
  });

  it("covers gen-plugin-mcp-wrappers write, in-sync, and drift exit paths", async () => {
    const generated = new Map<string, string>();
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async (target: string) => generated.get(String(target)) ?? ""),
      writeFile: vi.fn(async (target: string, content: string) => {
        generated.set(String(target), String(content));
      }),
    }));
    const writeLog = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "/nonmatching/runner"];
    const writeMod = await importRepoModule<{ main: () => Promise<void> }>(
      "scripts/gen-plugin-mcp-wrappers.mjs",
      "genPluginWrite",
    );
    await writeMod.main();
    expect(writeLog.mock.calls.some((c) => String(c[0]).includes("Wrote"))).toBe(true);
    writeLog.mockRestore();
    vi.resetModules();
    vi.doUnmock("node:fs/promises");

    // In-sync check.
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async (target: string) => generated.get(String(target)) ?? ""),
      writeFile: vi.fn(async () => {}),
    }));
    const syncLog = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "/nonmatching/runner", "--check"];
    const syncMod = await importRepoModule<{ main: () => Promise<void> }>(
      "scripts/gen-plugin-mcp-wrappers.mjs",
      "genPluginSync",
    );
    await syncMod.main();
    expect(syncLog.mock.calls.some((c) => String(c[0]).includes("in sync"))).toBe(true);
    syncLog.mockRestore();
    vi.resetModules();
    vi.doUnmock("node:fs/promises");

    // Drift exit path: readFile throws (caught -> "" mismatch) -> drift -> exit 1.
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async () => {
        throw new Error("missing");
      }),
      writeFile: vi.fn(async () => {}),
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = mockProcessExit();
    process.argv = ["node", "/nonmatching/runner", "--check"];
    const driftMod = await importRepoModule<{ main: () => Promise<void> }>(
      "scripts/gen-plugin-mcp-wrappers.mjs",
      "genPluginDrift",
    );
    await expect(driftMod.main()).rejects.toThrow("EXIT:1");
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("Out of sync"))).toBe(true);
    exit.mockRestore();
  });

  it("covers finalize-build chmod when outputs exist and skip when absent", async () => {
    const chmod = vi.fn(async () => {});
    const statSeen = vi.fn();
    vi.doMock("node:fs/promises", () => ({
      chmod,
      stat: vi.fn(async (target: string) => {
        statSeen(String(target));
        if (String(target).includes("server.js")) {
          const err = Object.assign(new Error("missing"), { code: "ENOENT" });
          throw err;
        }
        return {};
      }),
    }));
    const mod = await importRepoModule<{ main: (root?: string) => Promise<void> }>(
      "scripts/finalize-build.mjs",
      "finalizeBuild",
    );
    await mod.main("/repo");
    expect(chmod).toHaveBeenCalledTimes(1);
    expect(chmod.mock.calls[0]?.[0]).toContain(path.join("dist", "cli.js"));
  });

  it("covers finalize-build rethrow on non-ENOENT stat error", async () => {
    vi.doMock("node:fs/promises", () => ({
      chmod: vi.fn(async () => {}),
      stat: vi.fn(async () => {
        const err = Object.assign(new Error("perm"), { code: "EACCES" });
        throw err;
      }),
    }));
    const mod = await importRepoModule<{ main: (root?: string) => Promise<void> }>(
      "scripts/finalize-build.mjs",
      "finalizeBuildErr",
    );
    await expect(mod.main("/repo")).rejects.toThrow("perm");
  });

  it("covers prepare-build-cache: removes stale cache when output missing, no-op when present", async () => {
    const rmMock = vi.fn(async () => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("node:fs/promises", () => ({
      rm: rmMock,
      stat: vi.fn(async (target: string) => {
        const t = String(target);
        if (t.includes("cli.js")) {
          const err = Object.assign(new Error("missing"), { code: "ENOENT" });
          throw err;
        }
        return {}; // sdk/index.js present, tsbuildinfo present
      }),
    }));
    const mod = await importRepoModule<{ main: (root?: string) => Promise<void> }>(
      "scripts/prepare-build-cache.mjs",
      "prepCacheMissing",
    );
    await mod.main("/repo");
    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("Removed stale"))).toBe(true);
    warnSpy.mockRestore();
    vi.resetModules();
    vi.doUnmock("node:fs/promises");

    // All outputs present -> no rm.
    const rmMock2 = vi.fn(async () => {});
    vi.doMock("node:fs/promises", () => ({
      rm: rmMock2,
      stat: vi.fn(async () => ({})),
    }));
    const mod2 = await importRepoModule<{ main: (root?: string) => Promise<void> }>(
      "scripts/prepare-build-cache.mjs",
      "prepCachePresent",
    );
    await mod2.main("/repo");
    expect(rmMock2).not.toHaveBeenCalled();
  });

  it("covers prepare-build-cache rethrow on non-ENOENT stat error", async () => {
    vi.doMock("node:fs/promises", () => ({
      rm: vi.fn(async () => {}),
      stat: vi.fn(async () => {
        const err = Object.assign(new Error("io"), { code: "EIO" });
        throw err;
      }),
    }));
    const mod = await importRepoModule<{ main: (root?: string) => Promise<void> }>(
      "scripts/prepare-build-cache.mjs",
      "prepCacheErr",
    );
    await expect(mod.main("/repo")).rejects.toThrow("io");
  });
});

describe("lane-c scripts wave5: run-gates full (no skips) text output", () => {
  it("runs every gate including dogfood + sentry and prints the success line", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("compatibility-check.mjs")) {
        return { status: 0, stdout: '{"compatibility":"ok"}', stderr: "" };
      }
      if (joined.includes("sentry-telemetry-gate.mjs")) {
        return { status: 0, stdout: '{"ok":true,"mode":"best-effort"}', stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // No --json, no skip flags -> dogfood + sentry run, console.log success line.
    process.argv = ["node", "scripts/release/run-gates.mjs"];
    await importRepoModule("scripts/release/run-gates.mjs", "runGatesFull");
    expect(spawnSync.mock.calls.some((c) => [c[0], ...(c[1] as string[])].join(" ").includes("dogfood:package-first"))).toBe(
      true,
    );
    expect(
      spawnSync.mock.calls.some((c) => [c[0], ...(c[1] as string[])].join(" ").includes("sentry-telemetry-gate.mjs")),
    ).toBe(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Release gates passed."))).toBe(true);
    logSpy.mockRestore();
  });

  it("fails a captured gate and includes stdout + stderr detail in the message", async () => {
    // compatibility-check runs with capture:true, so its stdout/stderr survive into the detail.
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("compatibility-check.mjs")) {
        return { status: 9, stdout: "  compat out  ", stderr: "  compat err  " };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    process.argv = ["node", "scripts/release/run-gates.mjs"];
    await expect(importRepoModule("scripts/release/run-gates.mjs", "runGatesFailDetail")).rejects.toThrow("EXIT:9");
    const msg = String(errorSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(msg).toContain("Gate failed: compatibility-check");
    expect(msg).toContain("stdout:");
    expect(msg).toContain("compat out");
    expect(msg).toContain("stderr:");
    expect(msg).toContain("compat err");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("fails a gate with no stdout/stderr detail (empty suffix branch)", async () => {
    // Non-captured gate (build) failing -> stdout/stderr are "" -> empty suffix.
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("build")) {
        return { status: 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    process.argv = ["node", "scripts/release/run-gates.mjs"];
    await expect(importRepoModule("scripts/release/run-gates.mjs", "runGatesFailNoDetail")).rejects.toThrow("EXIT:1");
    const msg = String(errorSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(msg).toBe("Gate failed: build");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("fails a captured gate with only stdout (stderr-empty branch)", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("compatibility-check.mjs")) {
        return { status: 3, stdout: "only out", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    process.argv = ["node", "scripts/release/run-gates.mjs"];
    await expect(importRepoModule("scripts/release/run-gates.mjs", "runGatesFailStdoutOnly")).rejects.toThrow("EXIT:3");
    const msg = String(errorSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(msg).toContain("stdout:");
    expect(msg).toContain("only out");
    expect(msg).not.toContain("stderr:");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("fails when a captured gate emits invalid JSON", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("compatibility-check.mjs")) {
        return { status: 0, stdout: "not-json", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    process.argv = ["node", "scripts/release/run-gates.mjs"];
    await expect(importRepoModule("scripts/release/run-gates.mjs", "runGatesParseFail")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Failed to parse JSON for compatibility-check");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("lane-c scripts wave5: release/utils pure helpers", () => {
  type UtilsModule = typeof import("../../../scripts/release/utils.mjs");

  async function loadUtils(token: string): Promise<UtilsModule> {
    return importRepoModule<UtilsModule>("scripts/release/utils.mjs", token);
  }

  it("parseFlags handles positionals, valued flags, and bare boolean flags", async () => {
    const utils = await loadUtils("utilsParse");
    const { flags, positionals } = utils.parseFlags(["pos1", "--name", "value", "--bare", "--last"]);
    expect(positionals).toEqual(["pos1"]);
    expect(flags.get("name")).toBe("value");
    expect(flags.get("bare")).toBe(true);
    expect(flags.get("last")).toBe(true);
  });

  it("requireFlag returns the string value or fails when absent/boolean", async () => {
    const utils = await loadUtils("utilsRequire");
    expect(utils.requireFlag(new Map([["x", "42"]]), "x", "need x")).toBe("42");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    expect(() => utils.requireFlag(new Map(), "x", "need x")).toThrow("EXIT:1");
    expect(() => utils.requireFlag(new Map([["x", true]]), "x", "need x")).toThrow("EXIT:1");
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("need x"))).toBe(true);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("flagString and flagBool normalize present, boolean, truthy, falsy, and fallback values", async () => {
    const utils = await loadUtils("utilsFlags");
    expect(utils.flagString(new Map([["a", "v"]]), "a")).toBe("v");
    expect(utils.flagString(new Map([["a", true]]), "a", "fb")).toBe("fb");
    expect(utils.flagString(new Map(), "a")).toBeNull();
    expect(utils.flagBool(new Map(), "b", true)).toBe(true);
    expect(utils.flagBool(new Map([["b", true]]), "b")).toBe(true);
    expect(utils.flagBool(new Map([["b", "YES"]]), "b")).toBe(true);
    expect(utils.flagBool(new Map([["b", "off"]]), "b")).toBe(false);
    expect(utils.flagBool(new Map([["b", "maybe"]]), "b", true)).toBe(true);
  });

  it("utcDateKey and utcIsoDate format dates deterministically", async () => {
    const utils = await loadUtils("utilsDates");
    const date = new Date(Date.UTC(2026, 0, 5));
    expect(utils.utcDateKey(date)).toBe("2026.1.5");
    expect(utils.utcIsoDate(date)).toBe("2026-01-05");
  });

  it("commandFor appends .cmd on win32 and leaves binaries unchanged otherwise", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    let utils = await loadUtils("utilsCmdLinux");
    expect(utils.commandFor("pnpm")).toBe("pnpm");
    vi.resetModules();
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    utils = await loadUtils("utilsCmdWin");
    expect(utils.commandFor("pnpm")).toBe("pnpm.cmd");
    expect(utils.commandFor("npm.cmd")).toBe("npm.cmd");
    if (original) Object.defineProperty(process, "platform", original);
  });

  it("runCommand captures output, defaults status, and fails with stderr detail", async () => {
    const spawnSync = vi.fn(() => ({ status: 0, stdout: "out", stderr: "err" }));
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const utils = await loadUtils("utilsRunOk");
    const ok = utils.runCommand("echo", ["hi"], { capture: true, env: { X: "1" } });
    expect(ok).toEqual({ status: 0, stdout: "out", stderr: "err" });
    // Non-capture path leaves stdout/stderr empty strings.
    const okNoCapture = utils.runCommand("echo", ["hi"]);
    expect(okNoCapture).toEqual({ status: 0, stdout: "", stderr: "" });
    vi.resetModules();
    vi.doUnmock("node:child_process");

    // Failure with captured stderr -> fail() with detail.
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: null, stdout: "", stderr: "  bad thing  " })),
    }));
    const utilsFail = await loadUtils("utilsRunFail");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    expect(() => utilsFail.runCommand("boom", ["x"], { capture: true })).toThrow("EXIT:1");
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("Command failed"))).toBe(true);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("bad thing"))).toBe(true);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    vi.resetModules();
    vi.doUnmock("node:child_process");

    // allowFailure path: non-zero status without capture, no fail().
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 3, stdout: "", stderr: "" })),
    }));
    const utilsAllow = await loadUtils("utilsRunAllow");
    const allowed = utilsAllow.runCommand("x", [], { allowFailure: true });
    expect(allowed.status).toBe(3);
    vi.resetModules();
    vi.doUnmock("node:child_process");

    // Failure with capture but empty stderr -> `result.stderr || ""` empty + no detail (line 42/43).
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 2, stdout: undefined, stderr: undefined })),
    }));
    const utilsEmpty = await loadUtils("utilsRunEmptyStderr");
    const errorSpy2 = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy2 = mockProcessExit();
    expect(() => utilsEmpty.runCommand("boom", ["x"], { capture: true })).toThrow("EXIT:2");
    const failMsg = String(errorSpy2.mock.calls.at(-1)?.[0] ?? "");
    expect(failMsg).toContain("Command failed");
    expect(failMsg).not.toContain("\n"); // no stderr detail appended
    exitSpy2.mockRestore();
    errorSpy2.mockRestore();
    vi.resetModules();
    vi.doUnmock("node:child_process");

    // Capture success but undefined stdout/stderr -> `?? ""` defaults (lines 49/50).
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 0, stdout: undefined, stderr: undefined })),
    }));
    const utilsUndef = await loadUtils("utilsRunUndefStdio");
    expect(utilsUndef.runCommand("x", [], { capture: true })).toEqual({ status: 0, stdout: "", stderr: "" });
    vi.resetModules();
    vi.doUnmock("node:child_process");

    // Failure WITHOUT capture -> stderr ternary `: ""` branch (line 42 false side).
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 4, stdout: "", stderr: "" })),
    }));
    const utilsNoCapFail = await loadUtils("utilsRunNoCapFail");
    const errorSpy3 = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy3 = mockProcessExit();
    expect(() => utilsNoCapFail.runCommand("boom", ["y"])).toThrow("EXIT:4");
    expect(errorSpy3.mock.calls.some((c) => String(c[0]).includes("Command failed"))).toBe(true);
    exitSpy3.mockRestore();
    errorSpy3.mockRestore();
  });

  it("runCommandJson parses stdout and fails on invalid JSON", async () => {
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 0, stdout: '{"a":1}', stderr: "" })),
    }));
    let utils = await loadUtils("utilsJsonOk");
    expect(utils.runCommandJson("x", [])).toEqual({ a: 1 });
    vi.resetModules();
    vi.doUnmock("node:child_process");

    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 0, stdout: "not json", stderr: "" })),
    }));
    utils = await loadUtils("utilsJsonFail");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    expect(() => utils.runCommandJson("x", [])).toThrow("EXIT:1");
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("Failed to parse JSON output"))).toBe(true);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("lane-c scripts wave5: smoke-claude-plugin failure branches", () => {
  const requiredTools = [
    "pm_run", "pm_context", "pm_search", "pm_list", "pm_get",
    "pm_create", "pm_copy", "pm_update", "pm_append", "pm_claim", "pm_release", "pm_close",
    "pm_comments", "pm_files", "pm_docs", "pm_notes", "pm_learnings",
    "pm_deps", "pm_test",
    "pm_validate", "pm_health", "pm_contracts", "pm_schema", "pm_config", "pm_plan",
  ];

  interface SmokeOverrides {
    marketplace?: unknown;
    pluginJson?: unknown;
    initResult?: unknown;
    tools?: string[];
    getResult?: unknown;
    execSync?: () => string;
  }

  function setupSmoke(overrides: SmokeOverrides = {}) {
    const request = vi.fn(async (method: string) => {
      if (method === "initialize") {
        return overrides.initResult ?? { instructions: "Use pm_context before mutation tools." };
      }
      if (method === "tools/list") {
        return { tools: (overrides.tools ?? requiredTools).map((name) => ({ name })) };
      }
      return {};
    });
    const callTool = vi.fn(async (toolName: string) => {
      if (toolName === "pm_create") return { item: { id: "pm-claude-smoke-f" } };
      if (toolName === "pm_get") {
        return (
          overrides.getResult ?? {
            item: { status: "in_progress" },
            linked: { files: [{ path: "README.md" }], tests: [{ command: "node --version" }] },
          }
        );
      }
      return { ok: true };
    });
    const dispose = vi.fn(async () => undefined);
    vi.doMock("../../../scripts/plugin-mcp-smoke-harness.mjs", () => ({
      startPluginMcpSmoke: vi.fn(async () => ({ tmpRoot: "/tmp/pm-claude-w5", request, callTool, dispose })),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn((target: string) => {
        if (String(target).endsWith(path.join(".claude-plugin", "marketplace.json"))) {
          return JSON.stringify(overrides.marketplace ?? { name: "pm", plugins: [{ name: "pm-claude" }] });
        }
        if (String(target).endsWith(path.join("plugins", "pm-claude", ".claude-plugin", "plugin.json"))) {
          return JSON.stringify(overrides.pluginJson ?? { name: "pm-claude" });
        }
        return "{}";
      }),
    }));
    vi.doMock("node:child_process", () => ({ execSync: overrides.execSync ?? vi.fn(() => "") }));
    return { dispose };
  }

  it.each([
    {
      name: "marketplace name not pm",
      overrides: { marketplace: { name: "wrong", plugins: [{ name: "pm-claude" }] } } as SmokeOverrides,
      expected: /Root marketplace.json name must be "pm"/,
    },
    {
      name: "marketplace plugin name mismatch",
      overrides: { marketplace: { name: "pm", plugins: [{ name: "other" }] } } as SmokeOverrides,
      expected: /plugins\[0\].name must be "pm-claude"/,
    },
    {
      name: "plugin.json name wrong",
      overrides: { pluginJson: { name: "nope" } } as SmokeOverrides,
      expected: /plugin.json name must be "pm-claude"/,
    },
  ])("throws when $name (before harness starts)", async ({ overrides, expected }) => {
    setupSmoke(overrides);
    await expect(importRepoModule("scripts/smoke-claude-plugin.mjs", `smokeClaude_${String(expected)}`)).rejects.toThrow(
      expected,
    );
  });

  it.each([
    {
      name: "init missing instructions",
      overrides: { initResult: { instructions: "" } } as SmokeOverrides,
      expected: /missing instructions/,
    },
    {
      name: "instructions missing pm_context",
      overrides: { initResult: { instructions: "no guidance here" } } as SmokeOverrides,
      expected: /missing pm_context guidance/,
    },
    {
      name: "missing required tool",
      overrides: { tools: requiredTools.filter((t) => t !== "pm_health") } as SmokeOverrides,
      expected: /Missing required MCP tool: pm_health/,
    },
    {
      name: "tool count mismatch",
      overrides: { tools: [...requiredTools, "pm_extra"] } as SmokeOverrides,
      expected: /tools but the smoke expects/,
    },
    {
      name: "status not in_progress",
      overrides: {
        getResult: { item: { status: "open" }, linked: { files: [{}], tests: [{}] } },
      } as SmokeOverrides,
      expected: /Expected in_progress/,
    },
    {
      name: "no linked files",
      overrides: {
        getResult: { item: { status: "in_progress" }, linked: { files: [], tests: [{}] } },
      } as SmokeOverrides,
      expected: /at least 1 linked file/,
    },
    {
      name: "no linked tests",
      overrides: {
        getResult: { item: { status: "in_progress" }, linked: { files: [{}], tests: [] } },
      } as SmokeOverrides,
      expected: /at least 1 linked test/,
    },
  ])("throws and disposes when $name", async ({ overrides, expected }) => {
    const { dispose } = setupSmoke(overrides);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      importRepoModuleStable("scripts/smoke-claude-plugin.mjs"),
    ).rejects.toThrow(expected);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rethrows when the session-start hook exits non-zero", async () => {
    const { dispose } = setupSmoke({
      execSync: vi.fn(() => {
        throw Object.assign(new Error("hook boom"), { status: 2, stderr: "hook stderr" });
      }),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      importRepoModuleStable("scripts/smoke-claude-plugin.mjs"),
    ).rejects.toThrow(/session-start hook failed with exit 2/);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("tolerates a hook error whose status is 0 (silent-exit error object)", async () => {
    const { dispose } = setupSmoke({
      execSync: vi.fn(() => {
        throw Object.assign(new Error("interrupted"), { status: 0 });
      }),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await importRepoModuleStable("scripts/smoke-claude-plugin.mjs");
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Claude Code plugin smoke passed"))).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("lane-c scripts wave5: plugin-mcp-smoke-harness remaining line-handler branches", () => {
  it("ignores blank/idless/unknown-id lines, rejects error responses, and exposes getStderr", async () => {
    const readlineEmitter = new EventEmitter();
    const createInterface = vi.fn(() => readlineEmitter);
    const stdinWrite = vi.fn();
    const child = Object.assign(new EventEmitter(), {
      stdin: { write: stdinWrite, end: vi.fn() },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    vi.doMock("node:child_process", () => ({ spawn: vi.fn(() => child) }));
    vi.doMock("node:fs/promises", () => ({
      mkdtemp: vi.fn(async () => "/tmp/pm-mcp-harness-w5"),
      rm: vi.fn(async () => undefined),
    }));
    vi.doMock("node:readline", () => ({ default: { createInterface }, createInterface }));

    const mod = await importRepoModule<typeof import("../../../scripts/plugin-mcp-smoke-harness.mjs")>(
      "scripts/plugin-mcp-smoke-harness.mjs",
      "pluginMcpHarnessW5",
    );
    const harness = await mod.startPluginMcpSmoke({
      serverPath: "/tmp/mock.mjs",
      author: "lane-c-w5",
      tmpPrefix: "pm-harness-w5-",
      requestTimeoutMs: 200,
    });

    // Blank line -> line 61 early return.
    readlineEmitter.emit("line", "   ");
    // JSON without an id -> line 70 early return.
    readlineEmitter.emit("line", JSON.stringify({ jsonrpc: "2.0", result: { ok: true } }));
    // JSON that is not an object (number) -> line 70 typeof guard.
    readlineEmitter.emit("line", "42");
    // Valid shape but unknown id -> line 73 no-waiter return.
    readlineEmitter.emit("line", JSON.stringify({ jsonrpc: "2.0", id: 9999, result: {} }));

    // Error response for a real pending request -> waiter.reject (lines 75-76, 95-98).
    const errPromise = harness.request("initialize", {});
    const errId = JSON.parse(String(stdinWrite.mock.calls.at(-1)?.[0] ?? "{}")).id;
    readlineEmitter.emit(
      "line",
      JSON.stringify({ jsonrpc: "2.0", id: errId, error: { message: "boom from server" } }),
    );
    await expect(errPromise).rejects.toThrow("boom from server");

    // callTool isError without content text -> `?? "unknown"` fallback (line 106).
    const isErrPromise = harness.callTool("pm_update", {});
    const isErrId = JSON.parse(String(stdinWrite.mock.calls.at(-1)?.[0] ?? "{}")).id;
    readlineEmitter.emit(
      "line",
      JSON.stringify({ jsonrpc: "2.0", id: isErrId, result: { isError: true, content: [] } }),
    );
    await expect(isErrPromise).rejects.toThrow("pm_update returned isError: unknown");

    // getStderr exposes captured stderr (line 112).
    child.stderr.emit("data", Buffer.from("harness stderr chunk\n"));
    expect(harness.getStderr()).toContain("harness stderr chunk");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await harness.dispose();
    errorSpy.mockRestore();
  });
});

describe("lane-c scripts wave5: smoke-codex failure branches", () => {
  function mockHarness(request: unknown, callTool: unknown) {
    const dispose = vi.fn(async () => undefined);
    vi.doMock("../../../scripts/plugin-mcp-smoke-harness.mjs", () => ({
      startPluginMcpSmoke: vi.fn(async () => ({
        tmpRoot: "/tmp/pm-codex-smoke-w5",
        request,
        callTool,
        dispose,
      })),
    }));
    return dispose;
  }

  it("throws and disposes when a required MCP tool is missing", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "tools/list") return { tools: [{ name: "pm_run" }] }; // pm_context missing
      return { ok: true };
    });
    const callTool = vi.fn(async () => ({ ok: true }));
    const dispose = mockHarness(request, callTool);
    await expect(importRepoModule("scripts/smoke-codex-plugin-mcp.mjs", "smokeCodexMissingTool")).rejects.toThrow(
      /Missing MCP tool/,
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    vi.doUnmock("../../../scripts/plugin-mcp-smoke-harness.mjs");
  });

  it("throws when the smoke item does not persist the expected status/links", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "tools/list") {
        return {
          tools: [
            "pm_run",
            "pm_context",
            "pm_create",
            "pm_get",
            "pm_update",
            "pm_comments",
            "pm_files",
            "pm_docs",
            "pm_notes",
            "pm_learnings",
            "pm_deps",
            "pm_test",
          ].map((name) => ({ name })),
        };
      }
      return { ok: true };
    });
    const callTool = vi.fn(async (tool: string) => {
      if (tool === "pm_create") return { item: { id: "pm-smoke-bad" } };
      if (tool === "pm_get") {
        return { item: { status: "open" }, linked: { files: [], tests: [] } }; // mismatch
      }
      return { ok: true };
    });
    const dispose = mockHarness(request, callTool);
    await expect(importRepoModule("scripts/smoke-codex-plugin-mcp.mjs", "smokeCodexMismatch")).rejects.toThrow(
      /did not persist expected status\/links/,
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    vi.doUnmock("../../../scripts/plugin-mcp-smoke-harness.mjs");
  });
});

describe("lane-c scripts wave5: run-tests build + signal branches", () => {
  const mkdtempMock = vi.fn(async () => "/tmp/pm-run-tests-wave5");
  const rmMock = vi.fn(async () => undefined);

  function closeChild(code: number | null, signal: NodeJS.Signals | null = null) {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", code, signal));
    return child as never;
  }

  it("runs build then vitest when skip-build is unset (build success path)", async () => {
    delete process.env.PM_RUN_TESTS_SKIP_BUILD;
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => closeChild(0)) // build succeeds
      .mockImplementationOnce(() => closeChild(0)); // vitest succeeds
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:fs/promises", () => ({ mkdtemp: mkdtempMock, rm: rmMock }));
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await importRepoModule("scripts/run-tests.mjs", "runTestsBuildSuccess");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]?.[1]).toEqual(["build"]);
    expect(process.exitCode).toBe(0);
  });

  it("short-circuits when the build fails with a non-zero exit code", async () => {
    delete process.env.PM_RUN_TESTS_SKIP_BUILD;
    const spawn = vi.fn().mockImplementationOnce(() => closeChild(7)); // build fails
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:fs/promises", () => ({ mkdtemp: mkdtempMock, rm: rmMock }));
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await importRepoModule("scripts/run-tests.mjs", "runTestsBuildFail");
    expect(spawn).toHaveBeenCalledTimes(1); // vitest never spawned
    expect(process.exitCode).toBe(7);
  });

  it("treats a build terminated by signal as exit code 1", async () => {
    delete process.env.PM_RUN_TESTS_SKIP_BUILD;
    const spawn = vi.fn().mockImplementationOnce(() => closeChild(null, "SIGTERM"));
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:fs/promises", () => ({ mkdtemp: mkdtempMock, rm: rmMock }));
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await importRepoModule("scripts/run-tests.mjs", "runTestsBuildSignal");
    expect(process.exitCode).toBe(1);
  });

  it("treats a vitest run terminated by signal as exit code 1", async () => {
    process.env.PM_RUN_TESTS_SKIP_BUILD = "1";
    const spawn = vi.fn().mockImplementationOnce(() => closeChild(null, "SIGINT"));
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:fs/promises", () => ({ mkdtemp: mkdtempMock, rm: rmMock }));
    process.argv = ["node", "scripts/run-tests.mjs", "coverage"];
    await importRepoModule("scripts/run-tests.mjs", "runTestsVitestSignal");
    expect(process.exitCode).toBe(1);
  });

  it("defaults to test mode when no mode argument is provided", async () => {
    process.env.PM_RUN_TESTS_SKIP_BUILD = "1";
    const spawn = vi.fn().mockImplementationOnce(() => closeChild(0));
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:fs/promises", () => ({ mkdtemp: mkdtempMock, rm: rmMock }));
    process.argv = ["node", "scripts/run-tests.mjs"]; // no mode -> argv[2] ?? "test"
    await importRepoModule("scripts/run-tests.mjs", "runTestsDefaultMode");
    // test mode -> no --coverage flag
    expect(spawn.mock.calls[0]?.[1]).not.toContain("--coverage");
    expect(process.exitCode).toBe(0);
  });

  it("falls back to exit code 1 when the vitest close code is null without a signal", async () => {
    process.env.PM_RUN_TESTS_SKIP_BUILD = "1";
    const spawn = vi.fn().mockImplementationOnce(() => closeChild(null, null));
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:fs/promises", () => ({ mkdtemp: mkdtempMock, rm: rmMock }));
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await importRepoModule("scripts/run-tests.mjs", "runTestsNullCode");
    expect(process.exitCode).toBe(1);
  });

  it("falls back to exit code 1 when the build close code is null without a signal", async () => {
    delete process.env.PM_RUN_TESTS_SKIP_BUILD;
    // build returns null code (no signal) -> code ?? 1 = 1 -> short-circuit
    const spawn = vi.fn().mockImplementationOnce(() => closeChild(null, null));
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:fs/promises", () => ({ mkdtemp: mkdtempMock, rm: rmMock }));
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await importRepoModule("scripts/run-tests.mjs", "runTestsBuildNullCode");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("stringifies a non-Error thrown during the run", async () => {
    process.env.PM_RUN_TESTS_SKIP_BUILD = "1";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      // eslint-disable-next-line no-throw-literal
      queueMicrotask(() => child.emit("error", "raw spawn failure"));
      return child as never;
    });
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:fs/promises", () => ({ mkdtemp: mkdtempMock, rm: rmMock }));
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await importRepoModule("scripts/run-tests.mjs", "runTestsNonError");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("raw spawn failure");
    expect(process.exitCode).toBe(1);
    errorSpy.mockRestore();
  });

  it("uses pnpm.cmd on win32 (platform branch)", async () => {
    delete process.env.PM_RUN_TESTS_SKIP_BUILD;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => closeChild(0))
      .mockImplementationOnce(() => closeChild(0));
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:fs/promises", () => ({ mkdtemp: mkdtempMock, rm: rmMock }));
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await importRepoModule("scripts/run-tests.mjs", "runTestsWin32");
    expect(spawn.mock.calls[0]?.[0]).toBe("pnpm.cmd");
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  });
});

describe("lane-c scripts wave5: smoke-cleanup retry semantics", () => {
  it("returns immediately when removal succeeds and root no longer exists", async () => {
    const rmSync = vi.fn();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readdirSync: vi.fn(() => []),
      rmSync,
    }));
    const mod = await importRepoModule<{ cleanupTempRoot: (root: string) => void }>(
      "scripts/smoke-cleanup.mjs",
      "cleanupSuccess",
    );
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).not.toThrow();
    expect(rmSync).toHaveBeenCalledTimes(1);
  });

  it("breaks on non-retryable error and throws the captured error", async () => {
    const fatal = Object.assign(new Error("boom"), { code: "EINVAL" });
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(() => {
        throw fatal;
      }),
    }));
    const mod = await importRepoModule<{ cleanupTempRoot: (root: string) => void }>(
      "scripts/smoke-cleanup.mjs",
      "cleanupFatal",
    );
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).toThrow("boom");
  });

  it("returns cleanly when a non-retryable error breaks the loop but root is already gone", async () => {
    // rmSync throws non-retryable -> break; final existsSync(line 43) false -> no throw.
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(() => {
        throw Object.assign(new Error("gone"), { code: "EINVAL" });
      }),
    }));
    const mod = await importRepoModule<{ cleanupTempRoot: (root: string) => void }>(
      "scripts/smoke-cleanup.mjs",
      "cleanupBreakGone",
    );
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).not.toThrow();
  });

  it("treats a codeless error as non-retryable (readErrorCode false branch)", async () => {
    // Throwing a non-object error exercises the readErrorCode ternary false branch.
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(() => {
        // eslint-disable-next-line no-throw-literal
        throw "string failure";
      }),
    }));
    const mod = await importRepoModule<{ cleanupTempRoot: (root: string) => void }>(
      "scripts/smoke-cleanup.mjs",
      "cleanupCodeless",
    );
    // lastError is not an Error instance -> synthesized error message thrown.
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).toThrow(/Failed to remove temporary smoke directory/);
  });

  it("returns after the post-success existsSync check when rmSync leaves no error but root persists then clears", async () => {
    // rmSync succeeds (no throw) but existsSync is true right after rmSync (line 19 false),
    // then false at the line-29 guard -> early return covers line 30.
    let existsCall = 0;
    const existsSync = vi.fn(() => {
      existsCall += 1;
      // call 1 (after rmSync, line 19): true -> fall through; call 2 (line 29): false -> return.
      return existsCall === 1;
    });
    vi.doMock("node:fs", () => ({
      existsSync,
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(),
    }));
    const mod = await importRepoModule<{ cleanupTempRoot: (root: string) => void }>(
      "scripts/smoke-cleanup.mjs",
      "cleanupPostCheckReturn",
    );
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).not.toThrow();
  });

  it("retries on retryable error, sweeps entries, and eventually succeeds", async () => {
    // Avoid real blocking sleeps inside the retry loop.
    const atomicsWait = vi.spyOn(Atomics, "wait").mockReturnValue("ok" as never);
    let phase = 0;
    // existsSync: after the EBUSY throw, line-29 guard true (still exists) -> sweep + sleep;
    // next attempt rmSync succeeds and existsSync false -> return.
    const existsSync = vi.fn(() => phase < 2);
    const rmSync = vi.fn((target: string) => {
      if (String(target).endsWith("smoke") && phase === 0) {
        phase = 1;
        const err = Object.assign(new Error("busy"), { code: "EBUSY" });
        throw err;
      }
      phase = 2; // sweep/root removal succeeds on retry
    });
    vi.doMock("node:fs", () => ({
      existsSync,
      readdirSync: vi.fn(() => ["child"]),
      rmSync,
    }));
    const mod = await importRepoModule<{ cleanupTempRoot: (root: string) => void }>(
      "scripts/smoke-cleanup.mjs",
      "cleanupRetry",
    );
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).not.toThrow();
    expect(rmSync.mock.calls.length).toBeGreaterThan(1);
    atomicsWait.mockRestore();
  });

  it("throws a synthesized error when root persists without a captured error", async () => {
    const atomicsWait = vi.spyOn(Atomics, "wait").mockReturnValue("ok" as never);
    // rmSync succeeds (no throw) but existsSync always true -> loop exhausts -> synthesized throw.
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readdirSync: vi.fn(() => {
        throw new Error("readdir fail"); // exercises the best-effort catch (lines 37-39)
      }),
      rmSync: vi.fn(),
    }));
    const mod = await importRepoModule<{ cleanupTempRoot: (root: string) => void }>(
      "scripts/smoke-cleanup.mjs",
      "cleanupPersist",
    );
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).toThrow(/Failed to remove temporary smoke directory/);
    atomicsWait.mockRestore();
  });

  it("rethrows the captured retryable error when root persists after exhausting retries", async () => {
    const atomicsWait = vi.spyOn(Atomics, "wait").mockReturnValue("ok" as never);
    const busy = Object.assign(new Error("still busy"), { code: "EBUSY" });
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(() => {
        throw busy;
      }),
    }));
    const mod = await importRepoModule<{ cleanupTempRoot: (root: string) => void }>(
      "scripts/smoke-cleanup.mjs",
      "cleanupRethrow",
    );
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).toThrow("still busy");
    atomicsWait.mockRestore();
  });
});

describe("lane-c scripts wave5: generate-release-notes full pm summary", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "- Pending.",
    "",
    "## 2026.6.10",
    "- Older entry.",
  ].join("\n");

  it("reads package version, resolves previous tag, loads pm items, and writes stdout summary", async () => {
    const pmItems = {
      items: [
        {
          id: "pm-rel1",
          title: "Release pipeline hardening",
          type: "Chore",
          status: "closed",
          priority: 1,
          tags: ["release"],
          closed_at: "2026-06-12T00:00:00.000Z",
          updated_at: "2026-06-12T00:00:00.000Z",
        },
        {
          id: "pm-rel2",
          title: "Compatibility migration",
          type: "Bug",
          status: "closed",
          priority: 2,
          tags: [],
          updated_at: "2026-06-12T01:00:00.000Z",
          created_at: "2026-06-12T01:00:00.000Z",
        },
        {
          id: "pm-cancel",
          title: "release canceled item",
          type: "Task",
          status: "canceled",
          tags: ["release"],
          closed_at: "2026-06-12T02:00:00.000Z",
        },
        {
          id: "pm-other",
          title: "Unrelated closed work",
          type: "Task",
          status: "closed",
          closed_at: "2026-06-12T03:00:00.000Z",
        },
        {
          id: "pm-open",
          title: "Open release work",
          type: "Task",
          status: "open",
          tags: ["release"],
          updated_at: "2026-06-12T04:00:00.000Z",
        },
      ],
    };
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "tag") {
        return "v2026.6.14\nv2026.6.10\n\n";
      }
      if (command === "git" && args[0] === "log") {
        const tag = String(args[3] ?? "");
        return tag === "v2026.6.10" ? "2026-06-09T00:00:00.000Z" : "2026-06-14T00:00:00.000Z";
      }
      if (String(args[args.length - 1]) === "--json" || args.includes("list-all")) {
        return JSON.stringify(pmItems);
      }
      throw new Error(`unexpected execFileSync ${command} ${args.join(" ")}`);
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true), // dist/cli.js present -> loadPmItems path
      readFileSync: vi.fn((target: string) => {
        if (String(target).endsWith("CHANGELOG.md")) return changelog;
        if (String(target).endsWith("package.json")) return JSON.stringify({ version: "2026.6.14" });
        throw new Error(`unexpected readFileSync ${target}`);
      }),
      writeFileSync: vi.fn(),
    }));
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // No --version (reads package.json) and no --output (stdout branch).
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await importRepoModule("scripts/generate-release-notes.mjs", "genNotesFullSummary");
    const out = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("# @unbrained/pm-cli 2026.6.14");
    expect(out).toContain("Source range: v2026.6.10...v2026.6.14");
    expect(out).toContain("Closed pm items in release window:");
    expect(out).toContain("pm-rel1");
    expect(out).toContain("Compatibility migration");
    expect(out).not.toContain("pm-cancel");
    stdoutWrite.mockRestore();
  });

  it("reports no release-tagged items and tolerates git tag/log failures + invalid pm output", async () => {
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "tag") {
        throw new Error("no tags"); // resolvePreviousTag catch -> null
      }
      if (command === "git" && args[0] === "log") {
        throw new Error("no log"); // resolveTagDate catch -> null
      }
      // pm list-all returns non-array items -> [] fallback
      return JSON.stringify({ items: "broken" });
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn((target: string) => {
        if (String(target).endsWith("CHANGELOG.md")) return changelog;
        if (String(target).endsWith("package.json")) return JSON.stringify({ version: "2026.6.14" });
        throw new Error(`unexpected readFileSync ${target}`);
      }),
      writeFileSync: vi.fn(),
    }));
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await importRepoModule("scripts/generate-release-notes.mjs", "genNotesNoTags");
    const out = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("Source range: initial...v2026.6.14");
    expect(out).toContain("No closed pm tracker items were updated");
    stdoutWrite.mockRestore();
  });

  it("surfaces release items with no release-tagged matches and skips >20 overflow", async () => {
    const manyReleaseItems = Array.from({ length: 25 }, (_, i) => ({
      id: `pm-r${i}`,
      title: `release item ${i}`,
      type: "Chore",
      status: "closed",
      priority: 5,
      tags: ["release"],
      closed_at: "2026-06-12T00:00:00.000Z",
      updated_at: `2026-06-12T00:00:${String(i).padStart(2, "0")}.000Z`,
    }));
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "tag") return "";
      if (command === "git" && args[0] === "log") return "";
      return JSON.stringify({ items: manyReleaseItems });
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn((target: string) => {
        if (String(target).endsWith("CHANGELOG.md")) return changelog;
        if (String(target).endsWith("package.json")) return JSON.stringify({ version: "2026.6.14" });
        throw new Error(`unexpected readFileSync ${target}`);
      }),
      writeFileSync: vi.fn(),
    }));
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await importRepoModule("scripts/generate-release-notes.mjs", "genNotesOverflow");
    const out = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("more release-related tracker items omitted");
    stdoutWrite.mockRestore();
  });

  it("reports 'No release-tagged pm items' when closed items exist but none are release-related", async () => {
    const items = [
      {
        id: "pm-plain",
        title: "Generic closed work",
        type: "Task",
        status: "closed",
        closed_at: "2026-06-12T00:00:00.000Z",
        updated_at: "2026-06-12T00:00:00.000Z",
      },
    ];
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "tag") return "";
      if (command === "git" && args[0] === "log") return "";
      return JSON.stringify({ items });
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn((target: string) => {
        if (String(target).endsWith("CHANGELOG.md")) return changelog;
        if (String(target).endsWith("package.json")) return JSON.stringify({ version: "2026.6.14" });
        throw new Error(`unexpected readFileSync ${target}`);
      }),
      writeFileSync: vi.fn(),
    }));
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await importRepoModule("scripts/generate-release-notes.mjs", "genNotesNoReleaseTagged");
    const out = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("No release-tagged pm items found");
    stdoutWrite.mockRestore();
  });

  it.each([
    { label: "Error", thrown: () => new Error("pm crashed"), expected: "pm crashed" },
    {
      label: "non-Error",
      thrown: () => {
        // eslint-disable-next-line no-throw-literal
        throw "raw pm failure";
      },
      expected: "raw pm failure",
    },
  ])("loadPmItems catch path surfaces a warning when the pm CLI throws a $label", async ({ thrown, expected }) => {
    const execFileSync = vi.fn((command: string) => {
      if (command === "git") return "";
      const t = thrown();
      throw t;
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn((target: string) => {
        if (String(target).endsWith("CHANGELOG.md")) return changelog;
        if (String(target).endsWith("package.json")) return JSON.stringify({ version: "2026.6.14" });
        throw new Error(`unexpected readFileSync ${target}`);
      }),
      writeFileSync: vi.fn(),
    }));
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await importRepoModule("scripts/generate-release-notes.mjs", `genNotesPmThrow${expected}`);
    const out = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain(`pm tracker summary skipped: ${expected}`);
    stdoutWrite.mockRestore();
  });

  it("fails when no changelog section matches the version or Unreleased", async () => {
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn(() => "") }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn((target: string) => {
        if (String(target).endsWith("CHANGELOG.md")) return "# Changelog\n\nNothing here.\n";
        if (String(target).endsWith("package.json")) return JSON.stringify({ version: "2026.6.14" });
        throw new Error(`unexpected readFileSync ${target}`);
      }),
      writeFileSync: vi.fn(),
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await expect(importRepoModule("scripts/generate-release-notes.mjs", "genNotesNoSection")).rejects.toThrow(
      "EXIT:1",
    );
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Could not find CHANGELOG.md section");
    exitSpy.mockRestore();
  });

  it("fails when package.json has no valid version and flag values are missing", async () => {
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn(() => "") }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn((target: string) => {
        if (String(target).endsWith("package.json")) return JSON.stringify({ version: "   " });
        return "";
      }),
      writeFileSync: vi.fn(),
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await expect(importRepoModule("scripts/generate-release-notes.mjs", "genNotesBadVersion")).rejects.toThrow(
      "EXIT:1",
    );
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("package.json is missing a valid version");
    exitSpy.mockRestore();
  });

  it("rejects flags missing their required values", async () => {
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn(() => "") }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ""),
      writeFileSync: vi.fn(),
    }));
    for (const flag of ["--version", "--from", "--output"]) {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({ execFileSync: vi.fn(() => "") }));
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        writeFileSync: vi.fn(),
      }));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = mockProcessExit();
      process.argv = ["node", "scripts/generate-release-notes.mjs", flag];
      await expect(
        importRepoModule("scripts/generate-release-notes.mjs", `genNotesMissingValue${flag}`),
      ).rejects.toThrow("EXIT:1");
      expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain(`${flag} requires a value`);
      exitSpy.mockRestore();
    }
  });

  it("applies defaults for non-string item fields and last-section changelog extraction", async () => {
    // Changelog where the version section is the LAST one -> extract end === -1 branch (line 109).
    const lastSectionChangelog = ["# Changelog", "", "## [2026.6.14]", "- Final section entry."].join("\n");
    const items = [
      // Release-related closed item with non-string id/type/title and missing priority/updated_at.
      {
        id: 123,
        title: 999, // non-string title -> "Untitled" + filter title "" branch
        type: 7, // non-string type -> "Unknown" in output
        status: "closed",
        tags: ["release"], // matches via tag
        closed_at: "2026-06-12T00:00:00.000Z",
      },
      // closed item missing type entirely -> byType "Unknown"; equal-priority sort tie -> updated_at compare.
      {
        id: "pm-x",
        title: "Compatibility tweak",
        status: "closed",
        closed_at: "2026-06-12T00:00:01.000Z",
      },
      // closed item using updated_at fallback (no closed_at) -> line 145 second operand.
      {
        id: "pm-upd",
        title: "release via updated_at",
        status: "closed",
        priority: 1,
        tags: ["release"],
        updated_at: "2026-06-12T00:00:02.000Z",
      },
      // closed item using created_at fallback (no closed_at/updated_at) -> line 145 third operand.
      {
        id: "pm-cre",
        title: "release via created_at",
        status: "closed",
        priority: 1,
        tags: ["release"],
        created_at: "2026-06-12T00:00:03.000Z",
      },
      // numeric closed_at -> timestampSource non-string -> NaN -> excluded (line 146 false).
      {
        id: "pm-numts",
        title: "release numeric ts",
        status: "closed",
        closed_at: 123456,
      },
      // NON-closed item with non-string status -> filter line 147 false branch.
      {
        id: "pm-numstatus",
        title: "release weird status",
        status: 5,
        closed_at: "2026-06-12T00:00:04.000Z",
      },
    ];
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "tag") return "";
      if (command === "git" && args[0] === "log") return "";
      return JSON.stringify({ items });
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn((target: string) => {
        if (String(target).endsWith("CHANGELOG.md")) return lastSectionChangelog;
        if (String(target).endsWith("package.json")) return JSON.stringify({ version: "2026.6.14" });
        throw new Error(`unexpected readFileSync ${target}`);
      }),
      writeFileSync: vi.fn(),
    }));
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await importRepoModule("scripts/generate-release-notes.mjs", "genNotesDefaults");
    const out = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("Final section entry");
    expect(out).toContain("[Unknown/closed] Untitled"); // non-string type+title defaulted
    expect(out).toContain("By type:");
    stdoutWrite.mockRestore();
  });

  it("ignores a bare -- separator argument", async () => {
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn(() => "") }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn((target: string) => {
        if (String(target).endsWith("CHANGELOG.md")) return changelog;
        if (String(target).endsWith("package.json")) return JSON.stringify({ version: "2026.6.14" });
        throw new Error(`unexpected readFileSync ${target}`);
      }),
      writeFileSync: vi.fn(),
    }));
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs", "--"];
    await importRepoModule("scripts/generate-release-notes.mjs", "genNotesBareSep");
    expect(stdoutWrite.mock.calls.map((c) => String(c[0])).join("")).toContain("# @unbrained/pm-cli 2026.6.14");
    stdoutWrite.mockRestore();
  });
});

describe("lane-c scripts wave5: contracts-snapshot nested-array stable sort", () => {
  it("stably sorts nested arrays/objects on update (covers array map recursion)", async () => {
    process.argv = ["node", "scripts/contracts-snapshot.mjs", "--update"];
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdtempSync: vi.fn(() => "/tmp/pm-cli-contracts-global-w5"),
      rmSync: vi.fn(),
    }));
    const writeFile = vi.fn(async () => undefined);
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ""),
      writeFile,
    }));
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({
        status: 0,
        // Array of objects with unsorted keys -> exercises stableValue array branch (line 58).
        stdout: JSON.stringify({ list: [{ b: 2, a: 1 }, "leaf"], top: 1 }),
        stderr: "",
        error: undefined,
      })),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    await expect(importRepoModule("scripts/contracts-snapshot.mjs", "contractsArraySort")).rejects.toThrow("EXIT:0");
    exitSpy.mockRestore();
    const written = String(writeFile.mock.calls.at(-1)?.[1] ?? "");
    // Keys sorted: a before b within nested object; top after list at root.
    expect(written.indexOf('"a"')).toBeLessThan(written.indexOf('"b"'));
    expect(written.indexOf('"list"')).toBeLessThan(written.indexOf('"top"'));
    expect(written).toContain('"leaf"');
  });

  it("uses fallback defaults when spawn fails with undefined stdio and null status", async () => {
    process.argv = ["node", "scripts/contracts-snapshot.mjs", "--check"];
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdtempSync: vi.fn(() => "/tmp/pm-cli-contracts-global-w5b"),
      rmSync: vi.fn(),
    }));
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => undefined),
    }));
    vi.doMock("node:child_process", () => ({
      // status null + undefined stdout/stderr -> exercises `result.stderr ?? ""`,
      // `result.stdout ?? ""`, and `result.status ?? "unknown"` fallbacks.
      spawnSync: vi.fn(() => ({ status: null, stdout: undefined, stderr: undefined, error: undefined })),
    }));
    const writeStub = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    let failure: unknown = null;
    try {
      await importRepoModule("scripts/contracts-snapshot.mjs", "contractsSpawnFallback");
    } catch (error) {
      failure = error;
    }
    expect(String(failure ?? "")).toContain("failed with exit code unknown");
    writeStub.mockRestore();
    exitSpy.mockRestore();
  });

  it("stringifies non-Error JSON parse failures", async () => {
    process.argv = ["node", "scripts/contracts-snapshot.mjs", "--check"];
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdtempSync: vi.fn(() => "/tmp/pm-cli-contracts-global-w5c"),
      rmSync: vi.fn(),
    }));
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => undefined),
    }));
    // Provide invalid JSON so JSON.parse throws; the catch stringifies the error.
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 0, stdout: "not-json{", stderr: "", error: undefined })),
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    let failure: unknown = null;
    try {
      await importRepoModule("scripts/contracts-snapshot.mjs", "contractsParseFail");
    } catch (error) {
      failure = error;
    }
    expect(String(failure ?? "")).toContain("invalid JSON");
    exitSpy.mockRestore();
  });
});

describe("lane-c scripts wave5: check-secrets fail() on read error", () => {
  it("fails with a message when a tracked file read errors with a non-ENOENT code", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "broken.txt\0"),
    }));
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }),
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    process.argv = ["node", path.join(process.cwd(), "scripts/check-secrets.mjs")];
    await expect(importRepoModule("scripts/check-secrets.mjs", "checkSecretsReadFail")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(0)?.[0] ?? "")).toContain("Failed to read broken.txt");
    expect(String(errorSpy.mock.calls.at(0)?.[0] ?? "")).toContain("permission denied");
    exitSpy.mockRestore();
  });

  it("skips empty files and stringifies non-Error read failures", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "empty.txt\0broken.txt\0"),
    }));
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn((target: string) => {
        if (target === "empty.txt") {
          return Buffer.from(""); // length 0 -> continue (covers empty-file branch)
        }
        // eslint-disable-next-line no-throw-literal
        throw Object.assign({ code: "EACCES" }, { toString: () => "raw failure" });
      }),
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    process.argv = ["node", path.join(process.cwd(), "scripts/check-secrets.mjs")];
    await expect(importRepoModule("scripts/check-secrets.mjs", "checkSecretsNonError")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(0)?.[0] ?? "")).toContain("Failed to read broken.txt");
    exitSpy.mockRestore();
  });
});

describe("lane-c scripts wave5: check-secrets-lib remaining branches", () => {
  it("computes one-based line numbers across multiple newlines (binary-search else branch)", async () => {
    const mod = await importRepoModule<{
      scanContent: (file: string, content: string) => Array<{ rule: string; line: number }>;
    }>("scripts/check-secrets-lib.mjs", "scanLib");
    const token = `ghp_${"A1b2C3d4".repeat(5)}`;
    const content = ["l1", "l2", "l3", "l4", `tok ${token}`].join("\n");
    const findings = mod.scanContent("a.txt", content);
    const tokenFinding = findings.find((f) => f.rule === "github-token");
    expect(tokenFinding?.line).toBe(5);
    // Also a match on the very first line to exercise the low-bound path.
    const first = mod.scanContent("b.txt", `${token}\nrest`);
    expect(first.find((f) => f.rule === "github-token")?.line).toBe(1);
  });
});
