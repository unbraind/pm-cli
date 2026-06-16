import { EventEmitter } from "node:events";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

const mkdtempMock = vi.fn(async () => "/tmp/pm-run-tests-spec");
const rmMock = vi.fn(async () => undefined);

function closeChild(code: number | null, signal: NodeJS.Signals | null = null): never {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("close", code, signal));
  return child as never;
}

function errorChild(error: unknown): never {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("error", error));
  return child as never;
}

function mockFsPromises() {
  vi.doMock("node:fs/promises", () => ({ mkdtemp: mkdtempMock, rm: rmMock }));
}

describe("run-tests", () => {
  it("rejects an unknown mode with exit code 2 and never spawns", async () => {
    const spawn = vi.fn(() => closeChild(0));
    vi.doMock("node:child_process", () => ({ spawn }));
    mockFsPromises();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = ["node", "scripts/run-tests.mjs", "invalid-mode"];
    await harness.importModule("scripts/run-tests.mjs");
    expect(process.exitCode).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('Invalid mode "invalid-mode"');
  });

  it("skips the build and forwards passthrough args after -- to vitest with coverage", async () => {
    const spawn = vi.fn(() => closeChild(0));
    vi.doMock("node:child_process", () => ({ spawn }));
    mockFsPromises();
    process.env.PM_RUN_TESTS_SKIP_BUILD = "1";
    process.argv = ["node", "scripts/run-tests.mjs", "coverage", "--", "tests/unit/check-secrets.spec.ts"];
    await harness.importModule("scripts/run-tests.mjs");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls.at(0)?.[0]).toBe(process.execPath);
    expect(spawn.mock.calls.at(0)?.[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(path.join("node_modules", "vitest", "vitest.mjs")),
        "run",
        "--coverage",
        "tests/unit/check-secrets.spec.ts",
      ]),
    );
    expect(process.exitCode).toBe(0);
  });

  it("forwards passthrough args without a leading -- separator", async () => {
    const spawn = vi.fn(() => closeChild(0));
    vi.doMock("node:child_process", () => ({ spawn }));
    mockFsPromises();
    process.env.PM_RUN_TESTS_SKIP_BUILD = "1";
    process.argv = ["node", "scripts/run-tests.mjs", "test", "tests/unit/example.spec.ts"];
    await harness.importModule("scripts/run-tests.mjs");
    const vitestArgs = spawn.mock.calls.at(0)?.[1] as string[];
    expect(vitestArgs).toContain("tests/unit/example.spec.ts");
    expect(vitestArgs).not.toContain("--coverage");
  });

  it("surfaces a spawn error, stringifying the failure and cleaning up the temp root", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const spawn = vi.fn(() => errorChild(new Error("spawn failed")));
    vi.doMock("node:child_process", () => ({ spawn }));
    mockFsPromises();
    delete process.env.PM_RUN_TESTS_SKIP_BUILD;
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await harness.importModule("scripts/run-tests.mjs");
    expect(process.exitCode).toBe(1);
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Failed to run sandboxed tests");
    expect(rmMock).toHaveBeenCalledWith("/tmp/pm-run-tests-spec", { recursive: true, force: true });
  });

  it("runs build then vitest when skip-build is unset (build success path)", async () => {
    delete process.env.PM_RUN_TESTS_SKIP_BUILD;
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => closeChild(0))
      .mockImplementationOnce(() => closeChild(0));
    vi.doMock("node:child_process", () => ({ spawn }));
    mockFsPromises();
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await harness.importModule("scripts/run-tests.mjs");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]?.[1]).toEqual(["build"]);
    expect(process.exitCode).toBe(0);
  });

  it("short-circuits when the build fails with a non-zero exit code", async () => {
    delete process.env.PM_RUN_TESTS_SKIP_BUILD;
    const spawn = vi.fn().mockImplementationOnce(() => closeChild(7));
    vi.doMock("node:child_process", () => ({ spawn }));
    mockFsPromises();
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await harness.importModule("scripts/run-tests.mjs");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(7);
  });

  it("treats a build terminated by signal as exit code 1", async () => {
    delete process.env.PM_RUN_TESTS_SKIP_BUILD;
    const spawn = vi.fn().mockImplementationOnce(() => closeChild(null, "SIGTERM"));
    vi.doMock("node:child_process", () => ({ spawn }));
    mockFsPromises();
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await harness.importModule("scripts/run-tests.mjs");
    expect(process.exitCode).toBe(1);
  });

  it("falls back to exit code 1 when the build close code is null without a signal", async () => {
    delete process.env.PM_RUN_TESTS_SKIP_BUILD;
    const spawn = vi.fn().mockImplementationOnce(() => closeChild(null, null));
    vi.doMock("node:child_process", () => ({ spawn }));
    mockFsPromises();
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await harness.importModule("scripts/run-tests.mjs");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("treats a vitest run terminated by signal as exit code 1", async () => {
    process.env.PM_RUN_TESTS_SKIP_BUILD = "1";
    const spawn = vi.fn().mockImplementationOnce(() => closeChild(null, "SIGINT"));
    vi.doMock("node:child_process", () => ({ spawn }));
    mockFsPromises();
    process.argv = ["node", "scripts/run-tests.mjs", "coverage"];
    await harness.importModule("scripts/run-tests.mjs");
    expect(process.exitCode).toBe(1);
  });

  it("defaults to test mode when no mode argument is provided", async () => {
    process.env.PM_RUN_TESTS_SKIP_BUILD = "1";
    const spawn = vi.fn().mockImplementationOnce(() => closeChild(0));
    vi.doMock("node:child_process", () => ({ spawn }));
    mockFsPromises();
    process.argv = ["node", "scripts/run-tests.mjs"];
    await harness.importModule("scripts/run-tests.mjs");
    expect(spawn.mock.calls[0]?.[1]).not.toContain("--coverage");
    expect(process.exitCode).toBe(0);
  });

  it("falls back to exit code 1 when the vitest close code is null without a signal", async () => {
    process.env.PM_RUN_TESTS_SKIP_BUILD = "1";
    const spawn = vi.fn().mockImplementationOnce(() => closeChild(null, null));
    vi.doMock("node:child_process", () => ({ spawn }));
    mockFsPromises();
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await harness.importModule("scripts/run-tests.mjs");
    expect(process.exitCode).toBe(1);
  });

  it("stringifies a non-Error thrown during the run", async () => {
    process.env.PM_RUN_TESTS_SKIP_BUILD = "1";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const spawn = vi.fn(() => errorChild("raw spawn failure"));
    vi.doMock("node:child_process", () => ({ spawn }));
    mockFsPromises();
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await harness.importModule("scripts/run-tests.mjs");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("raw spawn failure");
    expect(process.exitCode).toBe(1);
  });

  it("uses pnpm.cmd on win32 (platform branch)", async () => {
    delete process.env.PM_RUN_TESTS_SKIP_BUILD;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spawn = vi
        .fn()
        .mockImplementationOnce(() => closeChild(0))
        .mockImplementationOnce(() => closeChild(0));
      vi.doMock("node:child_process", () => ({ spawn }));
      mockFsPromises();
      process.argv = ["node", "scripts/run-tests.mjs", "test"];
      await harness.importModule("scripts/run-tests.mjs");
      expect(spawn.mock.calls[0]?.[0]).toBe("pnpm.cmd");
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });
});
