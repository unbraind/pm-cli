import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Branch coverage for the pm-linked-test-adapters package runtime wrappers
 * (packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts):
 * missing PM_CLI_PACKAGE_ROOT, invalid SDK exports, the success path through
 * every test-runs wrapper, runId argument validation, and the in-flight load
 * sharing branch.
 */

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const ORIGINAL_PACKAGE_ROOT = process.env[PM_PACKAGE_ROOT_ENV];

const RUNTIME_PATH = "packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts";
type RuntimeModule = typeof import("../../../packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts");

const tempRoots: string[] = [];

function cacheBustToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function resetGlobalCallLog(key: string): void {
  (globalThis as Record<string, unknown>)[key] = [];
}

function readGlobalCallLog<T>(key: string): T[] {
  const value = (globalThis as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeSdkRuntimeModule(root: string, source: string): Promise<void> {
  const sdkRoot = path.join(root, "dist", "sdk");
  await mkdir(sdkRoot, { recursive: true });
  await writeFile(path.join(sdkRoot, "runtime.js"), source, "utf8");
}

async function importRuntime(queryPrefix: string): Promise<RuntimeModule> {
  const absolutePath = path.join(process.cwd(), RUNTIME_PATH);
  return (await import(`${pathToFileURL(absolutePath).href}?${queryPrefix}=${cacheBustToken()}`)) as RuntimeModule;
}

afterEach(async () => {
  if (ORIGINAL_PACKAGE_ROOT === undefined) {
    delete process.env[PM_PACKAGE_ROOT_ENV];
  } else {
    process.env[PM_PACKAGE_ROOT_ENV] = ORIGINAL_PACKAGE_ROOT;
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("linked-test-adapters package runtime", () => {
  it("covers runtime wrappers and argument validation", async () => {
    delete process.env[PM_PACKAGE_ROOT_ENV];
    const missingEnvRuntime = await importRuntime("linkedMissingEnv");
    await expect(missingEnvRuntime.runTestRunsListPackage({}, {} as never)).rejects.toThrow(
      "requires PM_CLI_PACKAGE_ROOT",
    );

    const invalidRoot = await createTempRoot("pm-linked-runtime-invalid-");
    process.env[PM_PACKAGE_ROOT_ENV] = invalidRoot;
    await writeSdkRuntimeModule(
      invalidRoot,
      `export const EXIT_CODE = { USAGE: 2 };
export class PmCliError extends Error {}
export async function runTestRunsList() { return null; }
`,
    );
    const invalidRuntime = await importRuntime("linkedInvalidSdk");
    await expect(invalidRuntime.runTestRunsListPackage({}, {} as never)).rejects.toThrow(
      "failed to load test-runs SDK runtime exports",
    );

    const root = await createTempRoot("pm-linked-runtime-success-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkRuntimeModule(
      root,
      `const key = "__PM_LINKED_RUNTIME_CALLS";
const calls = Array.isArray(globalThis[key]) ? globalThis[key] : [];
globalThis[key] = calls;
export const EXIT_CODE = { USAGE: 2 };
export class PmCliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "PmCliError";
    this.exitCode = exitCode;
  }
}
function readString(options, key, aliases = []) {
  const candidates = [key, ...aliases];
  for (const candidate of candidates) {
    const value = options?.[candidate];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
function readBoolean(options, key, aliases = []) {
  const candidates = [key, ...aliases];
  for (const candidate of candidates) {
    const value = options?.[candidate];
    if (value === true || value === false) return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
    }
  }
  return undefined;
}
export function readStringOption(options, key, aliases = []) {
  return readString(options, key, aliases);
}
export function readBooleanOption(options, key, aliases = []) {
  return readBoolean(options, key, aliases);
}
export async function runTestRunsList(options, global) {
  calls.push({ kind: "list", options, global });
  return { kind: "list", options, global };
}
export async function runTestRunsStatus(runId, global) {
  calls.push({ kind: "status", runId, global });
  return { kind: "status", runId, global };
}
export async function runTestRunsLogs(runId, options, global) {
  calls.push({ kind: "logs", runId, options, global });
  return { kind: "logs", runId, options, global };
}
export async function runTestRunsStop(runId, options, global) {
  calls.push({ kind: "stop", runId, options, global });
  return { kind: "stop", runId, options, global };
}
export async function runTestRunsResume(runId, options, global) {
  calls.push({ kind: "resume", runId, options, global });
  return { kind: "resume", runId, options, global };
}
`,
    );
    resetGlobalCallLog("__PM_LINKED_RUNTIME_CALLS");
    const runtime = await importRuntime("linkedRuntime");

    const listed = (await runtime.runTestRunsListPackage(
      { status: "passed", limit: "4" },
      { path: "/tmp/pm" } as never,
    )) as Record<string, unknown>;
    expect((listed.options as Record<string, unknown>).status).toBe("passed");
    expect((listed.options as Record<string, unknown>).limit).toBe("4");

    const status = (await runtime.runTestRunsStatusPackage(["run-1"], { path: "/tmp/pm" } as never)) as Record<string, unknown>;
    expect(status.runId).toBe("run-1");

    const logs = (await runtime.runTestRunsLogsPackage(
      ["run-2"],
      { stream: "stderr", tail: "10" },
      { path: "/tmp/pm" } as never,
    )) as Record<string, unknown>;
    expect((logs.options as Record<string, unknown>).stream).toBe("stderr");
    expect((logs.options as Record<string, unknown>).tail).toBe("10");

    const stopped = (await runtime.runTestRunsStopPackage(
      ["run-3"],
      { force: "true" },
      { path: "/tmp/pm" } as never,
    )) as Record<string, unknown>;
    expect((stopped.options as Record<string, unknown>).force).toBe(true);

    const resumed = (await runtime.runTestRunsResumePackage(
      ["run-4"],
      { author: "coverage" },
      { path: "/tmp/pm", noExtensions: true } as never,
    )) as Record<string, unknown>;
    expect((resumed.options as Record<string, unknown>).author).toBe("coverage");
    expect((resumed.options as Record<string, unknown>).noExtensions).toBe(true);

    await expect(runtime.runTestRunsStatusPackage([], { path: "/tmp/pm" } as never)).rejects.toMatchObject({
      message: "test-runs status requires a runId argument.",
      exitCode: 2,
    });
    await expect(runtime.runTestRunsLogsPackage([], {}, { path: "/tmp/pm" } as never)).rejects.toMatchObject({
      message: "test-runs logs requires a runId argument.",
      exitCode: 2,
    });
    await expect(runtime.runTestRunsStopPackage([], {}, { path: "/tmp/pm" } as never)).rejects.toMatchObject({
      message: "test-runs stop requires a runId argument.",
      exitCode: 2,
    });
    await expect(runtime.runTestRunsResumePackage([], {}, { path: "/tmp/pm" } as never)).rejects.toMatchObject({
      message: "test-runs resume requires a runId argument.",
      exitCode: 2,
    });

    const calls = readGlobalCallLog<{ kind: string }>("__PM_LINKED_RUNTIME_CALLS");
    expect(calls.map((entry) => entry.kind)).toEqual(["list", "status", "logs", "stop", "resume"]);
  });

  it("shares a single in-flight runtime load across concurrent callers", async () => {
    const root = await createTempRoot("pm-linked-runtime-concurrent-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkRuntimeModule(
      root,
      `export const EXIT_CODE = { USAGE: 2 };
export class PmCliError extends Error {}
export function readStringOption(options, key) { return typeof options?.[key] === "string" ? options[key] : undefined; }
export function readBooleanOption() { return undefined; }
export async function runTestRunsList(options, global) { return { kind: "list", options, global }; }
export async function runTestRunsStatus(runId, global) { return { kind: "status", runId, global }; }
export async function runTestRunsLogs(runId, options, global) { return { kind: "logs", runId, options, global }; }
export async function runTestRunsStop(runId, options, global) { return { kind: "stop", runId, options, global }; }
export async function runTestRunsResume(runId, options, global) { return { kind: "resume", runId, options, global }; }
`,
    );
    const runtime = await importRuntime("linkedConcurrent");
    // Two un-awaited calls race through ensureRuntimeBundle before the first
    // load settles, so the second observes the in-flight promise branch.
    const [listed, status] = await Promise.all([
      runtime.runTestRunsListPackage({ status: "passed" }, { path: "/tmp/pm" } as never),
      runtime.runTestRunsStatusPackage(["run-1"], { path: "/tmp/pm" } as never),
    ]);
    expect((listed as Record<string, unknown>).kind).toBe("list");
    expect((status as Record<string, unknown>).runId).toBe("run-1");
  });
});
