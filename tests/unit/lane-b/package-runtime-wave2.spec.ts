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

async function writeSdkIndexModule(root: string, source: string): Promise<void> {
  const sdkRoot = path.join(root, "dist", "sdk");
  await mkdir(sdkRoot, { recursive: true });
  await writeFile(path.join(sdkRoot, "index.js"), source, "utf8");
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

describe("lane-b package runtime wrappers", () => {
  it("covers calendar runtime loading, rendering, and deterministic failures", async () => {
    delete process.env[PM_PACKAGE_ROOT_ENV];
    const missingEnvRuntime = await importRepoModule<
      typeof import("../../../packages/pm-calendar/extensions/calendar/runtime.ts")
    >("packages/pm-calendar/extensions/calendar/runtime.ts", "calendarMissingEnv");
    await expect(missingEnvRuntime.runCalendarPackage({}, {})).rejects.toThrow("requires PM_CLI_PACKAGE_ROOT");

    const invalidRoot = await createTempRoot("pm-calendar-runtime-invalid-");
    process.env[PM_PACKAGE_ROOT_ENV] = invalidRoot;
    await writeSdkRuntimeModule(invalidRoot, "export const runCalendar = true;\n");
    const invalidRuntime = await importRepoModule<
      typeof import("../../../packages/pm-calendar/extensions/calendar/runtime.ts")
    >("packages/pm-calendar/extensions/calendar/runtime.ts", "calendarInvalidSdk");
    await expect(invalidRuntime.runCalendarPackage({}, {})).rejects.toThrow("failed to load calendar SDK runtime exports");

    const root = await createTempRoot("pm-calendar-runtime-success-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkRuntimeModule(
      root,
      `const key = "__PM_WAVE2_CALENDAR_CALLS";
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

    resetGlobalCallLog("__PM_WAVE2_CALENDAR_CALLS");
    const runtime = await importRepoModule<typeof import("../../../packages/pm-calendar/extensions/calendar/runtime.ts")>(
      "packages/pm-calendar/extensions/calendar/runtime.ts",
      "calendarRuntime",
    );

    const unloadedRender = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { result: { output_default: "markdown", events: [], days: [] } },
      options: {},
      global: {},
    } as any);
    expect(unloadedRender).toBeNull();

    const runResult = await runtime.runCalendarPackage({ marker: "agenda" } as any, { path: "/tmp/pm" } as any);
    expect((runResult as Record<string, unknown>).marker).toBe("agenda");
    const secondRunResult = await runtime.runCalendarPackage({ marker: "agenda-2" } as any, { path: "/tmp/pm" } as any);
    expect((secondRunResult as Record<string, unknown>).marker).toBe("agenda-2");

    const invalidPayloadRender = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { result: { output_default: "markdown", events: "nope", days: [] } },
      options: {},
      global: {},
    } as any);
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
    } as any);
    expect(markdownRender).toBe("markdown:md\n");

    const markdownRenderFromPayloadOptions = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: {
        command_options: { marker: "payload-options" },
        global: { path: "/tmp/pm" },
        result: { output_default: "markdown", events: [], days: [], marker: "payload-options" },
      },
      options: {},
    } as any);
    expect(markdownRenderFromPayloadOptions).toBe("markdown:payload-options\n");

    const jsonRenderFromPayloadGlobal = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: {
        global: { prefer_json: true },
        result: { output_default: "markdown", events: [], days: [], marker: "payload-global" },
      },
      options: {},
    } as any);
    expect(jsonRenderFromPayloadGlobal).toContain('"marker": "payload-global"');

    const markdownRenderWithInvalidPayloadGlobal = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: {
        global: "invalid-global",
        result: { output_default: "markdown", events: [], days: [], marker: "global-fallback" },
      },
      options: {},
    } as any);
    expect(markdownRenderWithInvalidPayloadGlobal).toBe("markdown:global-fallback\n");

    const jsonRenderByOption = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { result: { output_default: "markdown", events: [], days: [], marker: "json-option" } },
      options: { format: "json" },
      global: {},
    } as any);
    expect(jsonRenderByOption).toBe(`${JSON.stringify({ output_default: "markdown", events: [], days: [], marker: "json-option" }, null, 2)}\n`);

    const jsonRenderByPayloadFormat = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: {
        format: "json",
        result: { output_default: "markdown", events: [], days: [], marker: "json-payload" },
      },
      options: { format: "toon" },
      global: {},
    } as any);
    expect(jsonRenderByPayloadFormat).toContain('"marker": "json-payload"');

    const toonRender = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { result: { output_default: "markdown", events: [], days: [], marker: "toon" } },
      options: { format: "toon" },
      global: {},
    } as any);
    expect(toonRender).toBe("toon:toon\n");

    const toonRenderWithTrailingNewline = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { result: { output_default: "markdown", events: [], days: [], marker: "already-newline" } },
      options: { format: "toon" },
      global: {},
    } as any);
    expect(toonRenderWithTrailingNewline).toBe("toon:already-newline\n");

    const invalidFormatRender = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { result: { output_default: "markdown", events: [], days: [] } },
      options: { format: "invalid" },
      global: {},
    } as any);
    expect(invalidFormatRender).toBeNull();

    const directPayloadRender = runtime.renderCalendarPackageOutput({
      command: "calendar",
      payload: { output_default: "markdown", events: [], days: [], marker: "direct-payload" },
      options: {},
      global: {},
    } as any);
    expect(directPayloadRender).toBe("markdown:direct-payload\n");

    const calls = readGlobalCallLog<{ kind: string; options: Record<string, unknown> }>("__PM_WAVE2_CALENDAR_CALLS");
    expect(calls.some((entry) => entry.kind === "run" && entry.options.marker === "agenda")).toBe(true);
  });

  it("covers governance-audit runtime normalization and loading failures", async () => {
    delete process.env[PM_PACKAGE_ROOT_ENV];
    const missingEnvRuntime = await importRepoModule<
      typeof import("../../../packages/pm-governance-audit/extensions/governance-audit/runtime.ts")
    >("packages/pm-governance-audit/extensions/governance-audit/runtime.ts", "governanceMissingEnv");
    await expect(missingEnvRuntime.runDedupeAuditPackage({}, {})).rejects.toThrow("requires PM_CLI_PACKAGE_ROOT");

    const invalidRoot = await createTempRoot("pm-governance-runtime-invalid-");
    process.env[PM_PACKAGE_ROOT_ENV] = invalidRoot;
    await writeSdkRuntimeModule(
      invalidRoot,
      `export async function runDedupeAudit() { return null; }
export async function runCommentsAudit() { return null; }
`,
    );
    const invalidRuntime = await importRepoModule<
      typeof import("../../../packages/pm-governance-audit/extensions/governance-audit/runtime.ts")
    >("packages/pm-governance-audit/extensions/governance-audit/runtime.ts", "governanceInvalidSdk");
    await expect(invalidRuntime.runDedupeAuditPackage({}, {} as any)).rejects.toThrow(
      "failed to load governance SDK runtime exports",
    );

    const root = await createTempRoot("pm-governance-runtime-success-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkRuntimeModule(
      root,
      `const key = "__PM_WAVE2_GOVERNANCE_CALLS";
const calls = Array.isArray(globalThis[key]) ? globalThis[key] : [];
globalThis[key] = calls;
export function readStringOption(options, key, aliases = []) {
  const candidates = [key, ...aliases];
  for (const candidate of candidates) {
    const value = options?.[candidate];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
export function readBooleanOption(options, key, aliases = []) {
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
export async function runDedupeAudit(options, global) {
  calls.push({ kind: "dedupe", options, global });
  return { kind: "dedupe", options, global };
}
export async function runCommentsAudit(options, global) {
  calls.push({ kind: "comments", options, global });
  return { kind: "comments", options, global };
}
export async function runNormalize(options, global) {
  calls.push({ kind: "normalize", options, global });
  return { kind: "normalize", options, global };
}
`,
    );
    resetGlobalCallLog("__PM_WAVE2_GOVERNANCE_CALLS");
    const runtime = await importRepoModule<typeof import("../../../packages/pm-governance-audit/extensions/governance-audit/runtime.ts")>(
      "packages/pm-governance-audit/extensions/governance-audit/runtime.ts",
      "governanceRuntime",
    );

    const dedupe = (await runtime.runDedupeAuditPackage(
      {
        mode: "strict",
        deadline_before: "2026-01-01",
        deadlineAfter: "2026-02-01",
        assignee_filter: "mine",
        threshold: "3",
      },
      { json: true } as any,
    )) as Record<string, unknown>;
    expect((dedupe.options as Record<string, unknown>).mode).toBe("strict");
    expect((dedupe.options as Record<string, unknown>).deadlineBefore).toBe("2026-01-01");
    expect((dedupe.options as Record<string, unknown>).deadlineAfter).toBe("2026-02-01");
    expect((dedupe.options as Record<string, unknown>).assigneeFilter).toBe("mine");

    const comments = (await runtime.runCommentsAuditPackage(
      {
        full_history: "yes",
        assignee_filter: "owner-a",
        limit_items: "7",
      },
      { json: true } as any,
    )) as Record<string, unknown>;
    expect((comments.options as Record<string, unknown>).fullHistory).toBe(true);
    expect((comments.options as Record<string, unknown>).assigneeFilter).toBe("owner-a");
    expect((comments.options as Record<string, unknown>).limitItems).toBe("7");

    const normalize = (await runtime.runNormalizePackage(
      {
        filter_status: "open",
        include_body: true,
        compact: true,
        dry_run: true,
        apply: false,
        allow_audit_update: true,
        force: true,
      },
      { json: true } as any,
    )) as Record<string, unknown>;
    const normalizeOptions = normalize.options as Record<string, unknown>;
    expect(normalizeOptions.status).toBe("open");
    expect((normalizeOptions.list as Record<string, unknown>).includeBody).toBe(true);
    expect((normalizeOptions.list as Record<string, unknown>).compact).toBe(true);
    expect(normalizeOptions.dryRun).toBe(true);
    expect(normalizeOptions.apply).toBeUndefined();
    expect(normalizeOptions.allowAuditUpdate).toBe(true);
    expect(normalizeOptions.force).toBe(true);

    // Bare options exercise every readStringOption-undefined and
    // `readBooleanOption(...) === true ? true : undefined` false arm across the
    // three normalizers.
    const bareDedupe = (await runtime.runDedupeAuditPackage({}, {} as any)) as Record<string, unknown>;
    const bareDedupeOptions = bareDedupe.options as Record<string, unknown>;
    expect(bareDedupeOptions.mode).toBeUndefined();
    expect(bareDedupeOptions.deadlineBefore).toBeUndefined();
    expect(bareDedupeOptions.threshold).toBeUndefined();

    const bareComments = (await runtime.runCommentsAuditPackage({}, {} as any)) as Record<string, unknown>;
    const bareCommentsOptions = bareComments.options as Record<string, unknown>;
    expect(bareCommentsOptions.fullHistory).toBeUndefined();
    expect(bareCommentsOptions.limitItems).toBeUndefined();

    // apply:true exercises the `=== true ? true : undefined` TRUE arm for apply.
    const applyNormalize = (await runtime.runNormalizePackage({ apply: true }, {} as any)) as Record<string, unknown>;
    expect((applyNormalize.options as Record<string, unknown>).apply).toBe(true);

    const bareNormalize = (await runtime.runNormalizePackage({}, {} as any)) as Record<string, unknown>;
    const bareNormalizeOptions = bareNormalize.options as Record<string, unknown>;
    expect(bareNormalizeOptions.dryRun).toBeUndefined();
    expect(bareNormalizeOptions.apply).toBeUndefined();
    expect(bareNormalizeOptions.force).toBeUndefined();
    expect(bareNormalizeOptions.allowAuditUpdate).toBeUndefined();
    expect((bareNormalizeOptions.list as Record<string, unknown>).includeBody).toBeUndefined();
    expect((bareNormalizeOptions.list as Record<string, unknown>).compact).toBeUndefined();

    const calls = readGlobalCallLog<{ kind: string }>("__PM_WAVE2_GOVERNANCE_CALLS");
    expect(calls.map((entry) => entry.kind)).toEqual([
      "dedupe",
      "comments",
      "normalize",
      "dedupe",
      "comments",
      "normalize",
      "normalize",
    ]);
  });

  it("shares a single in-flight governance runtime load across concurrent callers", async () => {
    const root = await createTempRoot("pm-governance-runtime-concurrent-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkRuntimeModule(
      root,
      `export function readStringOption(options, key, aliases = []) {
  const candidates = [key, ...aliases];
  for (const candidate of candidates) {
    const value = options?.[candidate];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
export function readBooleanOption() { return undefined; }
export async function runDedupeAudit(options, global) { return { kind: "dedupe", options, global }; }
export async function runCommentsAudit(options, global) { return { kind: "comments", options, global }; }
export async function runNormalize(options, global) { return { kind: "normalize", options, global }; }
`,
    );
    const runtime = await importRepoModule<typeof import("../../../packages/pm-governance-audit/extensions/governance-audit/runtime.ts")>(
      "packages/pm-governance-audit/extensions/governance-audit/runtime.ts",
      "governanceConcurrent",
    );
    // Two un-awaited calls race through ensureGovernanceModule before the first
    // load settles, so the second observes the in-flight promise branch.
    const [first, second] = await Promise.all([
      runtime.runDedupeAuditPackage({ mode: "strict" }, {} as any),
      runtime.runCommentsAuditPackage({ status: "open" }, {} as any),
    ]);
    expect((first as Record<string, unknown>).kind).toBe("dedupe");
    expect((second as Record<string, unknown>).kind).toBe("comments");
  });

  it("covers guide-shell runtime wrappers, renderers, and deterministic failures", async () => {
    delete process.env[PM_PACKAGE_ROOT_ENV];
    const missingEnvRuntime = await importRepoModule<
      typeof import("../../../packages/pm-guide-shell/extensions/guide-shell/runtime.ts")
    >("packages/pm-guide-shell/extensions/guide-shell/runtime.ts", "guideMissingEnv");
    await expect(missingEnvRuntime.runGuidePackage([], {}, {})).rejects.toThrow("requires PM_CLI_PACKAGE_ROOT");

    const invalidRoot = await createTempRoot("pm-guide-runtime-invalid-");
    process.env[PM_PACKAGE_ROOT_ENV] = invalidRoot;
    await writeSdkRuntimeModule(invalidRoot, "export const runGuide = true;\n");
    const invalidRuntime = await importRepoModule<
      typeof import("../../../packages/pm-guide-shell/extensions/guide-shell/runtime.ts")
    >("packages/pm-guide-shell/extensions/guide-shell/runtime.ts", "guideInvalidSdk");
    await expect(invalidRuntime.runGuidePackage([], {}, {})).rejects.toThrow("failed to load guide/completion SDK runtime exports");

    const root = await createTempRoot("pm-guide-runtime-success-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkRuntimeModule(
      root,
      `const key = "__PM_WAVE2_GUIDE_CALLS";
const calls = Array.isArray(globalThis[key]) ? globalThis[key] : [];
globalThis[key] = calls;
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
export async function runGuide(options, global) {
  calls.push({ kind: "guide", options, global });
  return { kind: "guide", topic: options?.topic ?? "none" };
}
export function resolveGuideOutputFormat(options, global) {
  if (options?.format === "markdown") return "markdown";
  if (options?.format === "json") return "json";
  if (options?.format === "invalid") return "invalid";
  if (global?.format === "json") return "json";
  return "toon";
}
export function renderGuideMarkdown(result) {
  return "# guide " + String(result?.topic ?? "none");
}
export function runCompletion(shell, itemTypes = [], tags = [], eagerTagExpansion = false, runtime) {
  calls.push({ kind: "completion", shell, itemTypes, tags, eagerTagExpansion, runtime });
  return {
    shell,
    script: "complete -F _pm pm",
    setup_hint: "source <(pm completion)",
    runtime,
  };
}
export async function pathExists(targetPath) {
  return !targetPath.includes("missing-settings.json");
}
export function getSettingsPath(pmRoot) {
  if (pmRoot.includes("missing")) {
    return pmRoot + "/missing-settings.json";
  }
  return pmRoot + "/settings.json";
}
export function resolvePmRoot(cwd, overridePath) {
  return typeof overridePath === "string" && overridePath.length > 0 ? overridePath : cwd + "/pm";
}
export async function readSettings(pmRoot) {
  return {
    item_format: pmRoot.includes("json-markdown") ? "json_markdown" : "toon",
    schema: {
      statuses: ["open", "blocked"],
    },
  };
}
export function resolveItemTypeRegistry() {
  return {
    types: ["Task", "Issue", "Task"],
    definitions: [
      { name: "Task", folder: "tasks" },
      { name: "Issue", folder: "issues" },
    ],
    type_to_folder: { Task: "tasks", Issue: "issues" },
  };
}
export function resolveRuntimeStatusRegistry() {
  return { definitions: [{ id: "open" }, { id: "blocked" }, { id: "open" }] };
}
export function resolveRuntimeFieldRegistry() {
  const command_to_fields = new Map();
  // Duplicate + distinct flags so dedupe collapses one pair AND the comparator
  // runs over >=2 distinct flags (exercises the .sort callback).
  command_to_fields.set("list", [{ cli_flag: "status" }, { cli_flag: "status" }, { cli_flag: "assignee" }]);
  command_to_fields.set("create", [{ cli_flag: "item_type" }]);
  return { command_to_fields };
}
export async function listAllFrontMatter() {
  return [
    { metadata: { tags: ["alpha", "beta", "alpha"] } },
    { metadata: { tags: ["gamma", "beta"] } },
    // Non-string and blank entries exercise the tag-type/length guard arms.
    { metadata: { tags: [42, "  ", "delta"] } },
    { metadata: {} },
  ];
}
export function getActiveExtensionRegistrations() {
  return {};
}
export function readStringOption(options, key, aliases = []) {
  return readString(options, key, aliases);
}
export function readBooleanOption(options, key, aliases = []) {
  return readBoolean(options, key, aliases);
}
export function readCsvListOption(options, key, aliases = []) {
  const raw = readString(options, key, aliases);
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
`,
    );
    resetGlobalCallLog("__PM_WAVE2_GUIDE_CALLS");
    const runtime = await importRepoModule<typeof import("../../../packages/pm-guide-shell/extensions/guide-shell/runtime.ts")>(
      "packages/pm-guide-shell/extensions/guide-shell/runtime.ts",
      "guideRuntime",
    );

    const renderBeforeLoad = runtime.renderGuideShellPackageOutput({
      command: "guide",
      payload: { result: { topic: "before-load" } },
    } as any);
    expect(renderBeforeLoad).toBeNull();

    const guideResult = await runtime.runGuidePackage(["workflows"], {}, { path: "/tmp/pm" } as any);
    expect((guideResult as Record<string, unknown>).topic).toBe("workflows");

    const completion = await runtime.runCompletionPackage(
      ["zsh"],
      {
        item_types: "Task,Issue",
        tags: "alpha,beta",
        eager_tags: true,
      },
      { path: "/tmp/pm" } as any,
    );
    expect((completion as Record<string, unknown>).shell).toBe("zsh");

    const tagsWhenMissingSettings = await runtime.runCompletionTagsPackage({ path: "/tmp/missing" } as any);
    expect(tagsWhenMissingSettings).toEqual({ tags: [], count: 0 });

    const tags = await runtime.runCompletionTagsPackage({ path: "/tmp/pm" } as any);
    expect(tags).toEqual({ tags: ["alpha", "beta", "delta", "gamma"], count: 4 });

    const statuses = await runtime.runCompletionStatusesPackage({ path: "/tmp/pm" } as any);
    expect(statuses).toEqual({ statuses: ["blocked", "open", "open"], count: 3 });

    const types = await runtime.runCompletionTypesPackage({ path: "/tmp/pm" } as any);
    expect(types).toEqual({ types: ["Issue", "Task"], count: 2 });

    const guideMarkdown = runtime.renderGuideShellPackageOutput({
      command: "guide",
      options: { format: "markdown" },
      global: {},
      payload: { result: { topic: "workflows" } },
    } as any);
    expect(guideMarkdown).toBe("# guide workflows\n");

    const guideJson = runtime.renderGuideShellPackageOutput({
      command: "guide",
      options: { format: "json" },
      global: {},
      payload: { result: { topic: "json-guide" } },
    } as any);
    expect(guideJson).toContain('"topic": "json-guide"');

    const guideInvalidFormat = runtime.renderGuideShellPackageOutput({
      command: "guide",
      options: { format: "invalid" },
      global: {},
      payload: { result: { topic: "ignored" } },
    } as any);
    expect(guideInvalidFormat).toBeNull();

    const completionJson = runtime.renderGuideShellPackageOutput({
      command: "completion",
      payload: { format: "json", result: { script: "echo hi" } },
    } as any);
    expect(completionJson).toContain('"script": "echo hi"');

    const completionScript = runtime.renderGuideShellPackageOutput({
      command: "completion",
      payload: { result: { script: "echo hi" } },
    } as any);
    expect(completionScript).toBe("echo hi\n");

    const completionNoScript = runtime.renderGuideShellPackageOutput({
      command: "completion",
      payload: { result: { no_script: true } },
    } as any);
    expect(completionNoScript).toBeNull();

    const renderedTags = runtime.renderGuideShellPackageOutput({
      command: "completion-tags",
      payload: { result: { tags: ["alpha", 1, "beta"] } },
    } as any);
    expect(renderedTags).toBe("alpha beta\n");
    const renderedTagsJson = runtime.renderGuideShellPackageOutput({
      command: "completion-tags",
      payload: { format: "json", result: { tags: ["alpha"] } },
    } as any);
    expect(renderedTagsJson).toContain('"tags": [');

    const renderedStatuses = runtime.renderGuideShellPackageOutput({
      command: "completion-statuses",
      payload: { result: { statuses: ["open", "blocked"] } },
    } as any);
    expect(renderedStatuses).toBe("open blocked\n");
    const renderedStatusesJson = runtime.renderGuideShellPackageOutput({
      command: "completion-statuses",
      payload: { format: "json", result: { statuses: ["open"] } },
    } as any);
    expect(renderedStatusesJson).toContain('"statuses": [');

    const renderedTypes = runtime.renderGuideShellPackageOutput({
      command: "completion-types",
      payload: { result: { types: ["Task", "Issue"] } },
    } as any);
    expect(renderedTypes).toBe("Task Issue\n");
    const renderedTypesJson = runtime.renderGuideShellPackageOutput({
      command: "completion-types",
      payload: { format: "json", result: { types: ["Task"] } },
    } as any);
    expect(renderedTypesJson).toContain('"types": [');

    const unknownCommandRender = runtime.renderGuideShellPackageOutput({
      command: "unknown",
      payload: { result: {} },
    } as any);
    expect(unknownCommandRender).toBeNull();

    const calls = readGlobalCallLog<{ kind: string }>("__PM_WAVE2_GUIDE_CALLS");
    expect(calls.some((entry) => entry.kind === "guide")).toBe(true);
    expect(calls.some((entry) => entry.kind === "completion")).toBe(true);
  });

  it("covers guide-shell registry fallbacks, empty flags, missing settings, and render edge cases", async () => {
    // A second SDK stub that returns DEFINITIONS-only registries (no `types`,
    // no `type_to_folder`), no statuses, no command flags, and a json_markdown
    // item format, driving every collect*/empty-array fallback branch.
    const root = await createTempRoot("pm-guide-runtime-fallbacks-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkRuntimeModule(
      root,
      `function readString(options, key, aliases = []) {
  const candidates = [key, ...aliases];
  for (const candidate of candidates) {
    const value = options?.[candidate];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
function readBoolean(options, key, aliases = []) {
  const candidates = [key, ...aliases];
  for (const candidate of candidates) {
    const value = options?.[candidate];
    if (value === true || value === false) return value;
  }
  return undefined;
}
export async function runGuide(options) { return { kind: "guide", topic: options?.topic ?? "none", list: options?.list, format: options?.format, depth: options?.depth }; }
export function resolveGuideOutputFormat() { return "toon"; }
export function renderGuideMarkdown(result) { return "# guide " + String(result?.topic ?? "none"); }
export function runCompletion(shell, itemTypes, tags, eager, runtime) { return { shell, itemTypes, tags, eager, runtime }; }
export async function pathExists(targetPath) { return !targetPath.includes("missing-settings.json"); }
export function getSettingsPath(pmRoot) { return pmRoot.includes("missing") ? pmRoot + "/missing-settings.json" : pmRoot + "/settings.json"; }
export function resolvePmRoot(cwd, overridePath) { return typeof overridePath === "string" && overridePath.length > 0 ? overridePath : cwd + "/pm"; }
export async function readSettings(pmRoot) { return { item_format: "json_markdown", schema: {} }; }
export function resolveItemTypeRegistry() {
  // Definitions only, including a null entry and a folder-less entry, with no
  // top-level types[] and no type_to_folder map.
  return {
    definitions: [null, { name: "Task", folder: "tasks" }, { name: "NoFolder" }],
  };
}
export function resolveRuntimeStatusRegistry() { return { definitions: [] }; }
export function resolveRuntimeFieldRegistry() {
  const command_to_fields = new Map();
  // No matching runtime commands -> command_to_fields.get(command) returns
  // undefined for each, exercising the ?? [] fallback and empty flags branch.
  return { command_to_fields };
}
export async function listAllFrontMatter() {
  return [{ metadata: { tags: "not-an-array" } }, { metadata: {} }];
}
export function getActiveExtensionRegistrations() { return {}; }
export function readStringOption(options, key, aliases = []) { return readString(options, key, aliases); }
export function readBooleanOption(options, key, aliases = []) { return readBoolean(options, key, aliases); }
export function readCsvListOption() { return []; }
`,
    );
    const runtime = await importRepoModule<typeof import("../../../packages/pm-guide-shell/extensions/guide-shell/runtime.ts")>(
      "packages/pm-guide-shell/extensions/guide-shell/runtime.ts",
      "guideFallbacks",
    );

    // Guide topic resolved from positional args (readStringOption topic absent),
    // with no --list flag (false arm of `=== true ? true : undefined`).
    const guide = (await runtime.runGuidePackage(["workflows"], {}, { path: "/tmp/pm" } as any)) as Record<string, unknown>;
    expect(guide.topic).toBe("workflows");
    expect(guide.list).toBeUndefined();

    // Guide with neither topic option nor positional arg -> topic undefined.
    const guideNoTopic = (await runtime.runGuidePackage([], {}, { path: "/tmp/pm" } as any)) as Record<string, unknown>;
    expect(guideNoTopic.topic).toBe("none");

    // --list true exercises the TRUE arm of the list ternary.
    const guideList = (await runtime.runGuidePackage([], { list: true }, { path: "/tmp/pm" } as any)) as Record<string, unknown>;
    expect(guideList.list).toBe(true);

    // Completion shell from positional arg + definitions-only type registry +
    // empty status/flag registries (config object collapses to {}).
    const completion = (await runtime.runCompletionPackage(["fish"], {}, { path: "/tmp/pm" } as any)) as Record<string, unknown>;
    expect(completion.shell).toBe("fish");
    // item_types resolves from definitions; statuses/command_flags collapse to undefined.
    expect((completion.runtime as Record<string, unknown>).item_types).toEqual(["NoFolder", "Task"]);
    expect((completion.runtime as Record<string, unknown>).statuses).toBeUndefined();
    expect((completion.runtime as Record<string, unknown>).command_flags).toBeUndefined();

    // Completion shell default (no option, no arg) -> "bash".
    const completionDefault = (await runtime.runCompletionPackage([], {}, { path: "/tmp/pm" } as any)) as Record<string, unknown>;
    expect(completionDefault.shell).toBe("bash");

    // buildCompletionRuntimeConfig early-return when settings file is absent.
    const completionMissing = (await runtime.runCompletionPackage(["zsh"], {}, { path: "/tmp/missing" } as any)) as Record<string, unknown>;
    expect(completionMissing.runtime).toEqual({});

    // Types from definitions only (null + folder-less entries tolerated).
    const types = await runtime.runCompletionTypesPackage({ path: "/tmp/pm" } as any);
    expect(types).toEqual({ types: ["NoFolder", "Task"], count: 2 });

    // Statuses come straight from readSettings (no settings-file gate here).
    const statuses = await runtime.runCompletionStatusesPackage({ path: "/tmp/pm" } as any);
    expect(statuses).toEqual({ statuses: [], count: 0 });

    // Tags: json_markdown item_format branch + non-array tags tolerated, plus
    // the collectTypeToFolder definitions-derived path (folder-less entry skipped).
    const tags = await runtime.runCompletionTagsPackage({ path: "/tmp/pm" } as any);
    expect(tags).toEqual({ tags: [], count: 0 });

    // Render edge cases against the loaded runtime:
    // guide render with neither options nor global supplied.
    const guideRenderBare = runtime.renderGuideShellPackageOutput({
      command: "guide",
      payload: { result: { topic: "bare" } },
    } as any);
    // resolveGuideOutputFormat stub returns "toon" -> not markdown/json -> null.
    expect(guideRenderBare).toBeNull();

    // outputFormat is "toon" but payload.format === "json" -> the second operand
    // of the `outputFormat === "json" || readPayloadFormat === "json"` guard.
    const guideRenderPayloadJson = runtime.renderGuideShellPackageOutput({
      command: "guide",
      options: {},
      global: {},
      payload: { format: "json", result: { topic: "payload-json" } },
    } as any);
    expect(guideRenderPayloadJson).toContain('"topic": "payload-json"');

    // readPayloadResult: payload without a `result` key returns the payload itself.
    const completionScriptNoNewline = runtime.renderGuideShellPackageOutput({
      command: "completion",
      payload: { script: "complete -F _pm pm" },
    } as any);
    expect(completionScriptNoNewline).toBe("complete -F _pm pm\n");

    // Script already ending in newline is returned unchanged.
    const completionScriptNewline = runtime.renderGuideShellPackageOutput({
      command: "completion",
      payload: { result: { script: "done\n" } },
    } as any);
    expect(completionScriptNewline).toBe("done\n");

    // Non-array tags/statuses/types collapse to empty join.
    const tagsNonArray = runtime.renderGuideShellPackageOutput({
      command: "completion-tags",
      payload: { result: { tags: "nope" } },
    } as any);
    expect(tagsNonArray).toBe("\n");
    const statusesNonArray = runtime.renderGuideShellPackageOutput({
      command: "completion-statuses",
      payload: { result: { statuses: 5 } },
    } as any);
    expect(statusesNonArray).toBe("\n");
    const typesNonArray = runtime.renderGuideShellPackageOutput({
      command: "completion-types",
      payload: { result: null },
    } as any);
    expect(typesNonArray).toBe("\n");

    // Non-object payload exercises the readPayloadFormat object-guard false arm
    // (and readPayloadResult returns the payload itself).
    const stringPayloadRender = runtime.renderGuideShellPackageOutput({
      command: "completion-tags",
      payload: "raw-string-payload",
    } as any);
    expect(stringPayloadRender).toBe("\n");
  });

  it("covers guide-shell empty type registry fallbacks (no types, no definitions)", async () => {
    // A registry exposing NEITHER `types` nor `definitions` arrays forces the
    // collectTypeNames `: []` arm, the collectTypeToFolder `(... ?? [])` arm, and
    // the `itemTypes.length > 0 ? itemTypes : undefined` empty arm.
    const root = await createTempRoot("pm-guide-runtime-empty-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkRuntimeModule(
      root,
      `export async function runGuide(options) { return { topic: options?.topic ?? "none" }; }
export function resolveGuideOutputFormat() { return "toon"; }
export function renderGuideMarkdown() { return "# guide"; }
export function runCompletion(shell, itemTypes, tags, eager, runtime) { return { shell, runtime }; }
export async function pathExists() { return true; }
export function getSettingsPath(pmRoot) { return pmRoot + "/settings.json"; }
export function resolvePmRoot(cwd, overridePath) { return overridePath ?? cwd + "/pm"; }
export async function readSettings() { return { schema: {} }; }
export function resolveItemTypeRegistry() { return {}; }
export function resolveRuntimeStatusRegistry() { return { definitions: [] }; }
export function resolveRuntimeFieldRegistry() { return { command_to_fields: new Map() }; }
export async function listAllFrontMatter() { return []; }
export function getActiveExtensionRegistrations() { return {}; }
export function readStringOption() { return undefined; }
export function readBooleanOption() { return undefined; }
export function readCsvListOption() { return []; }
`,
    );
    const runtime = await importRepoModule<typeof import("../../../packages/pm-guide-shell/extensions/guide-shell/runtime.ts")>(
      "packages/pm-guide-shell/extensions/guide-shell/runtime.ts",
      "guideEmptyRegistry",
    );

    const completion = (await runtime.runCompletionPackage(["bash"], {}, { path: "/tmp/pm" } as any)) as Record<string, unknown>;
    // No item_types/statuses/command_flags resolve -> runtime config is empty.
    expect(completion.runtime).toEqual({});

    const types = await runtime.runCompletionTypesPackage({ path: "/tmp/pm" } as any);
    expect(types).toEqual({ types: [], count: 0 });

    const tags = await runtime.runCompletionTagsPackage({ path: "/tmp/pm" } as any);
    expect(tags).toEqual({ tags: [], count: 0 });
  });

  it("shares a single in-flight guide-shell runtime load across concurrent callers", async () => {
    const root = await createTempRoot("pm-guide-runtime-concurrent-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkRuntimeModule(
      root,
      `export async function runGuide(options) { return { topic: options?.topic ?? "none" }; }
export function resolveGuideOutputFormat() { return "toon"; }
export function renderGuideMarkdown() { return "# guide"; }
export function runCompletion(shell, itemTypes, tags, eager, runtime) { return { shell, runtime }; }
export async function pathExists() { return false; }
export function getSettingsPath(pmRoot) { return pmRoot + "/settings.json"; }
export function resolvePmRoot(cwd, overridePath) { return overridePath ?? cwd + "/pm"; }
export async function readSettings() { return { schema: {} }; }
export function resolveItemTypeRegistry() { return {}; }
export function resolveRuntimeStatusRegistry() { return { definitions: [] }; }
export function resolveRuntimeFieldRegistry() { return { command_to_fields: new Map() }; }
export async function listAllFrontMatter() { return []; }
export function getActiveExtensionRegistrations() { return {}; }
export function readStringOption(options, key) { return typeof options?.[key] === "string" ? options[key] : undefined; }
export function readBooleanOption() { return undefined; }
export function readCsvListOption() { return []; }
`,
    );
    const runtime = await importRepoModule<typeof import("../../../packages/pm-guide-shell/extensions/guide-shell/runtime.ts")>(
      "packages/pm-guide-shell/extensions/guide-shell/runtime.ts",
      "guideConcurrent",
    );
    // Two un-awaited calls race through ensureRuntimeBundle before the first
    // load settles, so the second observes the in-flight promise branch.
    const [guide, completion] = await Promise.all([
      runtime.runGuidePackage(["topic"], { topic: "concurrent" }, { path: "/tmp/pm" } as any),
      runtime.runCompletionPackage(["bash"], {}, { path: "/tmp/pm" } as any),
    ]);
    expect((guide as Record<string, unknown>).topic).toBe("concurrent");
    expect((completion as Record<string, unknown>).shell).toBe("bash");
  });

  it("covers linked-test-adapters runtime wrappers and argument validation", async () => {
    delete process.env[PM_PACKAGE_ROOT_ENV];
    const missingEnvRuntime = await importRepoModule<
      typeof import("../../../packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts")
    >("packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts", "linkedMissingEnv");
    await expect(missingEnvRuntime.runTestRunsListPackage({}, {})).rejects.toThrow("requires PM_CLI_PACKAGE_ROOT");

    const invalidRoot = await createTempRoot("pm-linked-runtime-invalid-");
    process.env[PM_PACKAGE_ROOT_ENV] = invalidRoot;
    await writeSdkRuntimeModule(
      invalidRoot,
      `export const EXIT_CODE = { USAGE: 2 };
export class PmCliError extends Error {}
export async function runTestRunsList() { return null; }
`,
    );
    const invalidRuntime = await importRepoModule<
      typeof import("../../../packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts")
    >("packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts", "linkedInvalidSdk");
    await expect(invalidRuntime.runTestRunsListPackage({}, {} as any)).rejects.toThrow(
      "failed to load test-runs SDK runtime exports",
    );

    const root = await createTempRoot("pm-linked-runtime-success-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkRuntimeModule(
      root,
      `const key = "__PM_WAVE2_LINKED_CALLS";
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
    resetGlobalCallLog("__PM_WAVE2_LINKED_CALLS");
    const runtime = await importRepoModule<typeof import("../../../packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts")>(
      "packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime.ts",
      "linkedRuntime",
    );

    const listed = (await runtime.runTestRunsListPackage(
      { status: "passed", limit: "4" },
      { path: "/tmp/pm" } as any,
    )) as Record<string, unknown>;
    expect((listed.options as Record<string, unknown>).status).toBe("passed");
    expect((listed.options as Record<string, unknown>).limit).toBe("4");

    const status = (await runtime.runTestRunsStatusPackage(["run-1"], { path: "/tmp/pm" } as any)) as Record<string, unknown>;
    expect(status.runId).toBe("run-1");

    const logs = (await runtime.runTestRunsLogsPackage(
      ["run-2"],
      { stream: "stderr", tail: "10" },
      { path: "/tmp/pm" } as any,
    )) as Record<string, unknown>;
    expect((logs.options as Record<string, unknown>).stream).toBe("stderr");
    expect((logs.options as Record<string, unknown>).tail).toBe("10");

    const stopped = (await runtime.runTestRunsStopPackage(
      ["run-3"],
      { force: "true" },
      { path: "/tmp/pm" } as any,
    )) as Record<string, unknown>;
    expect((stopped.options as Record<string, unknown>).force).toBe(true);

    const resumed = (await runtime.runTestRunsResumePackage(
      ["run-4"],
      { author: "lane-b" },
      { path: "/tmp/pm", noExtensions: true } as any,
    )) as Record<string, unknown>;
    expect((resumed.options as Record<string, unknown>).author).toBe("lane-b");
    expect((resumed.options as Record<string, unknown>).noExtensions).toBe(true);

    await expect(runtime.runTestRunsStatusPackage([], { path: "/tmp/pm" } as any)).rejects.toMatchObject({
      message: "test-runs status requires a runId argument.",
      exitCode: 2,
    });
    await expect(runtime.runTestRunsLogsPackage([], {}, { path: "/tmp/pm" } as any)).rejects.toMatchObject({
      message: "test-runs logs requires a runId argument.",
      exitCode: 2,
    });
    await expect(runtime.runTestRunsStopPackage([], {}, { path: "/tmp/pm" } as any)).rejects.toMatchObject({
      message: "test-runs stop requires a runId argument.",
      exitCode: 2,
    });
    await expect(runtime.runTestRunsResumePackage([], {}, { path: "/tmp/pm" } as any)).rejects.toMatchObject({
      message: "test-runs resume requires a runId argument.",
      exitCode: 2,
    });

    const calls = readGlobalCallLog<{ kind: string }>("__PM_WAVE2_LINKED_CALLS");
    expect(calls.map((entry) => entry.kind)).toEqual(["list", "status", "logs", "stop", "resume"]);
  });

  it("covers templates runtime wrappers and deterministic loading failures", async () => {
    delete process.env[PM_PACKAGE_ROOT_ENV];
    await expect(
      importRepoModule<typeof import("../../../packages/pm-templates/extensions/templates/runtime.ts")>(
        "packages/pm-templates/extensions/templates/runtime.ts",
        "templatesMissingEnv",
      ),
    ).rejects.toThrow("requires PM_CLI_PACKAGE_ROOT");

    const invalidRoot = await createTempRoot("pm-templates-runtime-invalid-");
    process.env[PM_PACKAGE_ROOT_ENV] = invalidRoot;
    await writeSdkIndexModule(invalidRoot, "export const runTemplatesList = true;\n");
    await expect(
      importRepoModule<typeof import("../../../packages/pm-templates/extensions/templates/runtime.ts")>(
        "packages/pm-templates/extensions/templates/runtime.ts",
        "templatesInvalidSdk",
      ),
    ).rejects.toThrow("failed to load template runtime exports");

    const root = await createTempRoot("pm-templates-runtime-success-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkIndexModule(
      root,
      `const key = "__PM_WAVE2_TEMPLATES_CALLS";
const calls = Array.isArray(globalThis[key]) ? globalThis[key] : [];
globalThis[key] = calls;
export async function loadCreateTemplateOptions(pmRoot, rawTemplateName) {
  calls.push({ kind: "load-options", pmRoot, rawTemplateName });
  return { type: "Task", status: "open", template: rawTemplateName };
}
export async function runTemplatesList(global) {
  calls.push({ kind: "list", global });
  return {
    templates: ["alpha-template"],
    count: 1,
    builtin_templates: ["alpha-template"],
    user_templates: [],
  };
}
export async function runTemplatesSave(rawTemplateName, options, global) {
  calls.push({ kind: "save", rawTemplateName, options, global });
  return {
    name: rawTemplateName,
    created_at: "2026-06-14T00:00:00.000Z",
    updated_at: "2026-06-14T00:00:00.000Z",
    path: ".agents/pm/templates/" + rawTemplateName + ".json",
    options,
  };
}
export async function runTemplatesShow(rawTemplateName, global) {
  calls.push({ kind: "show", rawTemplateName, global });
  return {
    name: rawTemplateName,
    source: "user",
    created_at: "2026-06-14T00:00:00.000Z",
    updated_at: "2026-06-14T00:00:00.000Z",
    path: ".agents/pm/templates/" + rawTemplateName + ".json",
    options: { type: "Task" },
  };
}
`,
    );
    resetGlobalCallLog("__PM_WAVE2_TEMPLATES_CALLS");

    const runtime = await importRepoModule<typeof import("../../../packages/pm-templates/extensions/templates/runtime.ts")>(
      "packages/pm-templates/extensions/templates/runtime.ts",
      "templatesRuntime",
    );

    const options = await runtime.loadCreateTemplateOptions("/tmp/pm", "demo-template");
    expect(options).toEqual({ type: "Task", status: "open", template: "demo-template" });

    const saved = await runtime.runTemplatesSave(
      "demo-template",
      { type: "Task", status: "open" },
      { path: "/tmp/pm" } as any,
    );
    expect(saved.name).toBe("demo-template");
    expect(saved.options).toEqual({ type: "Task", status: "open" });

    const listed = await runtime.runTemplatesList({ path: "/tmp/pm" } as any);
    expect(listed.templates).toEqual(["alpha-template"]);
    expect(listed.count).toBe(1);

    const shown = await runtime.runTemplatesShow("demo-template", { path: "/tmp/pm" } as any);
    expect(shown.name).toBe("demo-template");
    expect(shown.source).toBe("user");

    const calls = readGlobalCallLog<{ kind: string }>("__PM_WAVE2_TEMPLATES_CALLS");
    expect(calls.map((entry) => entry.kind)).toEqual(["load-options", "save", "list", "show"]);
  });
});
