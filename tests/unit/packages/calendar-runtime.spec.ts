import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const ORIGINAL_PACKAGE_ROOT = process.env[PM_PACKAGE_ROOT_ENV];

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

async function importRepoModule<T>(relativePath: string, queryPrefix: string): Promise<T> {
  const absolutePath = path.join(process.cwd(), relativePath);
  return (await import(`${pathToFileURL(absolutePath).href}?${queryPrefix}=${cacheBustToken()}`)) as T;
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

const CALENDAR_RUNTIME_PATH = "packages/pm-calendar/extensions/calendar/runtime.ts";
type CalendarRuntimeModule = typeof import("../../../packages/pm-calendar/extensions/calendar/runtime.ts");

describe("packages/pm-calendar runtime", () => {
  it("covers calendar runtime loading, rendering, and deterministic failures", async () => {
    delete process.env[PM_PACKAGE_ROOT_ENV];
    const missingEnvRuntime = await importRepoModule<CalendarRuntimeModule>(
      CALENDAR_RUNTIME_PATH,
      "calendarMissingEnv",
    );
    await expect(missingEnvRuntime.runCalendarPackage({}, {})).rejects.toThrow("requires PM_CLI_PACKAGE_ROOT");

    const invalidRoot = await createTempRoot("pm-calendar-runtime-invalid-");
    process.env[PM_PACKAGE_ROOT_ENV] = invalidRoot;
    await writeSdkRuntimeModule(invalidRoot, "export const runCalendar = true;\n");
    const invalidRuntime = await importRepoModule<CalendarRuntimeModule>(CALENDAR_RUNTIME_PATH, "calendarInvalidSdk");
    await expect(invalidRuntime.runCalendarPackage({}, {})).rejects.toThrow("failed to load calendar SDK runtime exports");

    const root = await createTempRoot("pm-calendar-runtime-success-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkRuntimeModule(
      root,
      `const key = "__PM_CALENDAR_CALLS";
const calls = Array.isArray(globalThis[key]) ? globalThis[key] : [];
globalThis[key] = calls;
export async function runCalendar(options, global) {
  calls.push({ kind: "run", options, global });
  return {
    output_default: "markdown",
    events: [],
    days: [],
    marker: options?.marker ?? "default",
  };
}
export function renderCalendarMarkdown(result) {
  return "markdown:" + String(result?.marker ?? "default");
}
export function renderCalendarToon(result) {
  const marker = String(result?.marker ?? "default");
  if (marker === "already-newline") {
    return "toon:already-newline\\n";
  }
  return "toon:" + marker;
}
export function resolveCalendarOutputFormat(options, global) {
  if (options?.format === "json") return "json";
  if (options?.format === "toon") return "toon";
  if (options?.format === "invalid") return "invalid";
  if (global?.prefer_json === true) return "json";
  return "markdown";
}
`,
    );

    resetGlobalCallLog("__PM_CALENDAR_CALLS");
    const runtime = await importRepoModule<CalendarRuntimeModule>(CALENDAR_RUNTIME_PATH, "calendarRuntime");

    const unloadedRender = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { result: { output_default: "markdown", events: [], days: [] } },
      options: {},
      global: {},
    } as never);
    expect(unloadedRender).toBeNull();

    const runResult = await runtime.runCalendarPackage({ marker: "agenda" } as never, { path: "/tmp/pm" } as never);
    expect((runResult as Record<string, unknown>).marker).toBe("agenda");
    const secondRunResult = await runtime.runCalendarPackage({ marker: "agenda-2" } as never, { path: "/tmp/pm" } as never);
    expect((secondRunResult as Record<string, unknown>).marker).toBe("agenda-2");

    const invalidPayloadRender = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { result: { output_default: "markdown", events: "nope", days: [] } },
      options: {},
      global: {},
    } as never);
    expect(invalidPayloadRender).toBeNull();

    const markdownRender = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: {
        command_options: { marker: "md" },
        global: { path: "/tmp/pm" },
        result: { output_default: "markdown", events: [], days: [], marker: "md" },
      },
      options: {},
      global: {},
    } as never);
    expect(markdownRender).toBe("markdown:md\n");

    const markdownRenderFromPayloadOptions = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: {
        command_options: { marker: "payload-options" },
        global: { path: "/tmp/pm" },
        result: { output_default: "markdown", events: [], days: [], marker: "payload-options" },
      },
      options: {},
    } as never);
    expect(markdownRenderFromPayloadOptions).toBe("markdown:payload-options\n");

    const jsonRenderFromPayloadGlobal = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: {
        global: { prefer_json: true },
        result: { output_default: "markdown", events: [], days: [], marker: "payload-global" },
      },
      options: {},
    } as never);
    expect(jsonRenderFromPayloadGlobal).toContain('"marker": "payload-global"');

    const markdownRenderWithInvalidPayloadGlobal = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: {
        global: "invalid-global",
        result: { output_default: "markdown", events: [], days: [], marker: "global-fallback" },
      },
      options: {},
    } as never);
    expect(markdownRenderWithInvalidPayloadGlobal).toBe("markdown:global-fallback\n");

    const jsonRenderByOption = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { result: { output_default: "markdown", events: [], days: [], marker: "json-option" } },
      options: { format: "json" },
      global: {},
    } as never);
    expect(jsonRenderByOption).toBe(
      `${JSON.stringify({ output_default: "markdown", events: [], days: [], marker: "json-option" }, null, 2)}\n`,
    );

    const jsonRenderByPayloadFormat = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: {
        format: "json",
        result: { output_default: "markdown", events: [], days: [], marker: "json-payload" },
      },
      options: { format: "toon" },
      global: {},
    } as never);
    expect(jsonRenderByPayloadFormat).toContain('"marker": "json-payload"');

    const toonRender = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { result: { output_default: "markdown", events: [], days: [], marker: "toon" } },
      options: { format: "toon" },
      global: {},
    } as never);
    expect(toonRender).toBe("toon:toon\n");

    const toonRenderWithTrailingNewline = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { result: { output_default: "markdown", events: [], days: [], marker: "already-newline" } },
      options: { format: "toon" },
      global: {},
    } as never);
    expect(toonRenderWithTrailingNewline).toBe("toon:already-newline\n");

    const invalidFormatRender = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { result: { output_default: "markdown", events: [], days: [] } },
      options: { format: "invalid" },
      global: {},
    } as never);
    expect(invalidFormatRender).toBeNull();

    const directPayloadRender = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { output_default: "markdown", events: [], days: [], marker: "direct-payload" },
      options: {},
      global: {},
    } as never);
    expect(directPayloadRender).toBe("markdown:direct-payload\n");

    const calls = readGlobalCallLog<{ kind: string; options: Record<string, unknown> }>("__PM_CALENDAR_CALLS");
    expect(calls.some((entry) => entry.kind === "run" && entry.options.marker === "agenda")).toBe(true);

    // Drive the defensive non-object guard arms of the internal payload readers
    // through the test-only seam (unreachable via renderCalendarPackageOutput,
    // whose only caller validates payload via isCalendarResult first).
    expect(runtime._testOnly.readPayloadFormat("raw-string")).toBe("toon");
    expect(runtime._testOnly.readPayloadFormat(null)).toBe("toon");
    expect(runtime._testOnly.readPayloadFormat({ format: "json" })).toBe("json");
    expect(runtime._testOnly.readPayloadCommandOptions("raw-string")).toEqual({});
    expect(runtime._testOnly.readPayloadCommandOptions(null)).toEqual({});
    expect(runtime._testOnly.readPayloadGlobalOptions("raw-string")).toEqual({});
    expect(runtime._testOnly.readPayloadGlobalOptions(null)).toEqual({});
  });

  it("shares a single in-flight calendar runtime load across concurrent callers", async () => {
    const root = await createTempRoot("pm-calendar-runtime-concurrent-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkRuntimeModule(
      root,
      `export async function runCalendar(options) {
  return { output_default: "markdown", events: [], days: [], marker: options?.marker ?? "default" };
}
export function renderCalendarMarkdown(result) { return "markdown:" + String(result?.marker ?? "default"); }
export function renderCalendarToon(result) { return "toon:" + String(result?.marker ?? "default"); }
export function resolveCalendarOutputFormat() { return "markdown"; }
`,
    );
    const runtime = await importRepoModule<CalendarRuntimeModule>(CALENDAR_RUNTIME_PATH, "calendarConcurrent");
    // Two un-awaited calls race through ensureCalendarCoreModule before the first
    // load settles, so the second observes the in-flight promise branch.
    const [first, second] = await Promise.all([
      runtime.runCalendarPackage({ marker: "race-1" } as never, { path: "/tmp/pm" } as never),
      runtime.runCalendarPackage({ marker: "race-2" } as never, { path: "/tmp/pm" } as never),
    ]);
    expect((first as Record<string, unknown>).marker).toBe("race-1");
    expect((second as Record<string, unknown>).marker).toBe("race-2");
  });
});
