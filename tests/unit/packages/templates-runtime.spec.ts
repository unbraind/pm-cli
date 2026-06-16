import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Branch coverage for the pm-templates package runtime wrappers
 * (packages/pm-templates/extensions/templates/runtime.ts): missing
 * PM_CLI_PACKAGE_ROOT, invalid SDK exports, and the success path through every
 * template wrapper (load-options, save, list, show).
 */

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const ORIGINAL_PACKAGE_ROOT = process.env[PM_PACKAGE_ROOT_ENV];

const RUNTIME_PATH = "packages/pm-templates/extensions/templates/runtime.ts";
type RuntimeModule = typeof import("../../../packages/pm-templates/extensions/templates/runtime.ts");

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

async function writeSdkIndexModule(root: string, source: string): Promise<void> {
  const sdkRoot = path.join(root, "dist", "sdk");
  await mkdir(sdkRoot, { recursive: true });
  await writeFile(path.join(sdkRoot, "index.js"), source, "utf8");
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

describe("templates package runtime", () => {
  it("covers runtime wrappers and deterministic loading failures", async () => {
    delete process.env[PM_PACKAGE_ROOT_ENV];
    await expect(importRuntime("templatesMissingEnv")).rejects.toThrow("requires PM_CLI_PACKAGE_ROOT");

    const invalidRoot = await createTempRoot("pm-templates-runtime-invalid-");
    process.env[PM_PACKAGE_ROOT_ENV] = invalidRoot;
    await writeSdkIndexModule(invalidRoot, "export const runTemplatesList = true;\n");
    await expect(importRuntime("templatesInvalidSdk")).rejects.toThrow("failed to load template runtime exports");

    const root = await createTempRoot("pm-templates-runtime-success-");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    await writeSdkIndexModule(
      root,
      `const key = "__PM_TEMPLATES_RUNTIME_CALLS";
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
    resetGlobalCallLog("__PM_TEMPLATES_RUNTIME_CALLS");

    const runtime = await importRuntime("templatesRuntime");

    const options = await runtime.loadCreateTemplateOptions("/tmp/pm", "demo-template");
    expect(options).toEqual({ type: "Task", status: "open", template: "demo-template" });

    const saved = await runtime.runTemplatesSave(
      "demo-template",
      { type: "Task", status: "open" },
      { path: "/tmp/pm" } as never,
    );
    expect(saved.name).toBe("demo-template");
    expect(saved.options).toEqual({ type: "Task", status: "open" });

    const listed = await runtime.runTemplatesList({ path: "/tmp/pm" } as never);
    expect(listed.templates).toEqual(["alpha-template"]);
    expect(listed.count).toBe(1);

    const shown = await runtime.runTemplatesShow("demo-template", { path: "/tmp/pm" } as never);
    expect(shown.name).toBe("demo-template");
    expect(shown.source).toBe("user");

    const calls = readGlobalCallLog<{ kind: string }>("__PM_TEMPLATES_RUNTIME_CALLS");
    expect(calls.map((entry) => entry.kind)).toEqual(["load-options", "save", "list", "show"]);
  });
});
