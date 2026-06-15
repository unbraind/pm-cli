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

describe("packages/pm-guide-shell runtime", () => {
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
      `const key = "__PM_GUIDE_CALLS";
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
    resetGlobalCallLog("__PM_GUIDE_CALLS");
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

    const calls = readGlobalCallLog<{ kind: string }>("__PM_GUIDE_CALLS");
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
});
