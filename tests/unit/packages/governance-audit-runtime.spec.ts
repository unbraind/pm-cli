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

describe("packages/pm-governance-audit runtime", () => {
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
      `const key = "__PM_GOVERNANCE_CALLS";
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
    resetGlobalCallLog("__PM_GOVERNANCE_CALLS");
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

    const calls = readGlobalCallLog<{ kind: string }>("__PM_GOVERNANCE_CALLS");
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
});
