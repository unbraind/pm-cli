import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PM_PACKAGE_ROOT_ENV,
  cacheBustToken,
  importRepoModule,
  readGlobalCallLog,
  resetGlobalCallLog,
  setupPackageRuntimeSpec,
  writeSdkRuntimeModule,
} from "../../helpers/packageRuntime.js";

/**
 * Branch coverage for the pm-linked-test-adapters package runtime wrappers
 * (packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts):
 * missing PM_CLI_PACKAGE_ROOT, invalid SDK exports, the success path through
 * every test-runs wrapper, runId argument validation, and the in-flight load
 * sharing branch.
 */

const RUNTIME_PATH = "packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts";
type RuntimeModule = typeof import("../../../packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts");

const { createTempRoot } = setupPackageRuntimeSpec();

async function importRuntime(queryPrefix: string): Promise<RuntimeModule> {
  return importRepoModule<RuntimeModule>(RUNTIME_PATH, queryPrefix);
}

describe("linked-test-adapters package runtime", () => {
  it("ships local ESM metadata for copied extension installs", async () => {
    const sourceRoot = path.join(process.cwd(), "packages", "pm-linked-test-adapters", "extensions", "linked-test-adapters");
    const tempRoot = await createTempRoot("pm-linked-extension-esm-");
    const extensionRoot = path.join(tempRoot, "linked-test-adapters");
    await mkdir(extensionRoot, { recursive: true });
    await copyFile(path.join(sourceRoot, "package.json"), path.join(extensionRoot, "package.json"));
    await copyFile(path.join(sourceRoot, "index.ts"), path.join(extensionRoot, "index.ts"));
    await copyFile(path.join(sourceRoot, "runtime.ts"), path.join(extensionRoot, "runtime.ts"));

    const metadata = JSON.parse(await readFile(path.join(extensionRoot, "package.json"), "utf8")) as { type?: string };
    expect(metadata.type).toBe("module");

    const imported = (await import(`${pathToFileURL(path.join(extensionRoot, "index.ts")).href}?copied=${cacheBustToken()}`)) as {
      manifest?: { name?: string };
      activate?: unknown;
    };
    expect(imported.manifest?.name).toBe("builtin-linked-test-adapters");
    expect(typeof imported.activate).toBe("function");
  });

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
