import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exhaustive branch coverage for the generated package runtime-loaders
 * (pm-beads / pm-todos). These two files are byte-identical apart from the
 * embedded EXTENSION_NAME/PACKAGE_NAME, so we parametrize over both to drive
 * every candidate-resolution, ERR_MODULE_NOT_FOUND skip, and fallback branch
 * from real imports plus a controlled node:fs.existsSync.
 */

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const ORIGINAL_PACKAGE_ROOT = process.env[PM_PACKAGE_ROOT_ENV];
const ORIGINAL_ARGV1 = process.argv[1];

const tempRoots: string[] = [];

interface RuntimeLoaderModule {
  loadPackageRuntimeModule: () => Promise<Record<string, unknown>>;
}

const LOADERS: ReadonlyArray<{ pkg: string; ext: string }> = [
  { pkg: "pm-beads", ext: "beads" },
  { pkg: "pm-todos", ext: "todos" },
];

function cacheBustToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loaderAbsPath(pkg: string, ext: string): string {
  return path.join(process.cwd(), "packages", pkg, "extensions", ext, "runtime-loader.ts");
}

async function importLoader(pkg: string, ext: string): Promise<RuntimeLoaderModule> {
  const absolutePath = loaderAbsPath(pkg, ext);
  return (await import(`${pathToFileURL(absolutePath).href}?v=${cacheBustToken()}`)) as RuntimeLoaderModule;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function restoreArgv(): void {
  if (ORIGINAL_ARGV1 === undefined) {
    process.argv.splice(1, 1);
  } else {
    process.argv[1] = ORIGINAL_ARGV1;
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:url");
  if (ORIGINAL_PACKAGE_ROOT === undefined) {
    delete process.env[PM_PACKAGE_ROOT_ENV];
  } else {
    process.env[PM_PACKAGE_ROOT_ENV] = ORIGINAL_PACKAGE_ROOT;
  }
  restoreArgv();
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe.each(LOADERS)("$pkg runtime-loader", ({ pkg, ext }) => {
  it("resolves a packaged runtime via PM_CLI_PACKAGE_ROOT (.agents path)", async () => {
    const root = await createTempRoot(`pm-${ext}-loader-agents-`);
    const runtimeDir = path.join(root, ".agents", "pm", "extensions", ext);
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "runtime.ts"), "export const marker = 'agents-runtime';\n", "utf8");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    const loader = await importLoader(pkg, ext);
    const runtime = await loader.loadPackageRuntimeModule();
    expect(runtime.marker).toBe("agents-runtime");
  });

  it("resolves a packaged runtime discovered via process.argv[1]", async () => {
    const root = await createTempRoot(`pm-${ext}-loader-argv-`);
    const runtimeDir = path.join(root, "packages", pkg, "extensions", ext);
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "runtime.ts"), "export const marker = 'argv-runtime';\n", "utf8");
    const fakeBinDir = path.join(root, "bin");
    await mkdir(fakeBinDir, { recursive: true });
    delete process.env[PM_PACKAGE_ROOT_ENV];
    process.argv[1] = path.join(fakeBinDir, "pm.js");
    const loader = await importLoader(pkg, ext);
    const runtime = await loader.loadPackageRuntimeModule();
    expect(runtime.marker).toBe("argv-runtime");
  });

  it("preserves non-ERR_MODULE_NOT_FOUND runtime import errors", async () => {
    const root = await createTempRoot(`pm-${ext}-loader-throw-`);
    const runtimeDir = path.join(root, ".agents", "pm", "extensions", ext);
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "runtime.ts"), "throw new Error('explicit-runtime-boom');\n", "utf8");
    process.env[PM_PACKAGE_ROOT_ENV] = root;
    const loader = await importLoader(pkg, ext);
    await expect(loader.loadPackageRuntimeModule()).rejects.toThrow("explicit-runtime-boom");
  });

  it("falls back to the sibling runtime.ts when no candidate roots resolve", async () => {
    const emptyRoot = await createTempRoot(`pm-${ext}-loader-empty-`);
    const deepDir = path.join(emptyRoot, "a", "b", "c");
    await mkdir(deepDir, { recursive: true });
    delete process.env[PM_PACKAGE_ROOT_ENV];
    process.argv[1] = path.join(deepDir, "pm.js");
    const loader = await importLoader(pkg, ext);
    const runtime = await loader.loadPackageRuntimeModule();
    expect(typeof runtime).toBe("object");
    expect(Object.keys(runtime).length).toBeGreaterThan(0);
  });

  it("skips ERR_MODULE_NOT_FOUND candidates and throws when nothing resolves", async () => {
    const root = await createTempRoot(`pm-${ext}-loader-missing-`);
    const phantomLocal = path.join(process.cwd(), "packages", pkg, "extensions", ext, "runtime.ts");

    vi.doMock("node:fs", () => ({
      existsSync: (target: string) => path.resolve(String(target)) !== path.resolve(phantomLocal),
    }));

    process.env[PM_PACKAGE_ROOT_ENV] = root;
    const loader = await importLoader(pkg, ext);
    await expect(loader.loadPackageRuntimeModule()).rejects.toThrow(
      /Unable to resolve packaged .* extension runtime module/,
    );
    vi.doUnmock("node:fs");
  });

  it("swallows ERR_MODULE_NOT_FOUND from the sibling fallback then throws the summary", async () => {
    const realLocal = path.resolve(path.join(process.cwd(), "packages", pkg, "extensions", ext, "runtime.ts"));
    const phantomDir = await createTempRoot(`pm-${ext}-loader-phantom-`);
    const phantomLocal = path.join(phantomDir, "runtime.ts");

    vi.doMock("node:fs", () => ({
      existsSync: (target: string) => path.resolve(String(target)) === realLocal,
    }));
    vi.doMock("node:url", async (importOriginal) => {
      const actual = (await importOriginal()) as typeof import("node:url");
      return {
        ...actual,
        pathToFileURL: (input: string) =>
          path.resolve(String(input)) === realLocal
            ? actual.pathToFileURL(phantomLocal)
            : actual.pathToFileURL(input),
      };
    });

    delete process.env[PM_PACKAGE_ROOT_ENV];
    process.argv.splice(1, 1);
    const loader = await importLoader(pkg, ext);
    await expect(loader.loadPackageRuntimeModule()).rejects.toThrow(
      /Unable to resolve packaged .* extension runtime module/,
    );
    vi.doUnmock("node:fs");
    vi.doUnmock("node:url");
  });

  it("rethrows a non-ERR_MODULE_NOT_FOUND error from the sibling fallback", async () => {
    const realLocal = path.resolve(path.join(process.cwd(), "packages", pkg, "extensions", ext, "runtime.ts"));
    const phantomDir = await createTempRoot(`pm-${ext}-loader-rethrow-`);
    const phantomLocal = path.join(phantomDir, "runtime.ts");
    await writeFile(phantomLocal, "throw new Error('sibling-explicit-boom');\n", "utf8");

    vi.doMock("node:fs", () => ({
      existsSync: (target: string) => path.resolve(String(target)) === realLocal,
    }));
    vi.doMock("node:url", async (importOriginal) => {
      const actual = (await importOriginal()) as typeof import("node:url");
      return {
        ...actual,
        pathToFileURL: (input: string) =>
          path.resolve(String(input)) === realLocal
            ? actual.pathToFileURL(phantomLocal)
            : actual.pathToFileURL(input),
      };
    });

    delete process.env[PM_PACKAGE_ROOT_ENV];
    process.argv.splice(1, 1);
    const loader = await importLoader(pkg, ext);
    await expect(loader.loadPackageRuntimeModule()).rejects.toThrow("sibling-explicit-boom");
    vi.doUnmock("node:fs");
    vi.doUnmock("node:url");
  });

  it("treats an ERR_MODULE_NOT_FOUND error with a non-string message as missing", async () => {
    const realLocal = path.resolve(path.join(process.cwd(), "packages", pkg, "extensions", ext, "runtime.ts"));
    const phantomDir = await createTempRoot(`pm-${ext}-loader-nonstring-`);
    const phantomLocal = path.join(phantomDir, "runtime.ts");
    await writeFile(phantomLocal, "throw { code: 'ERR_MODULE_NOT_FOUND', message: 12345 };\n", "utf8");

    vi.doMock("node:fs", () => ({
      existsSync: (target: string) => path.resolve(String(target)) === realLocal,
    }));
    vi.doMock("node:url", async (importOriginal) => {
      const actual = (await importOriginal()) as typeof import("node:url");
      return {
        ...actual,
        pathToFileURL: (input: string) =>
          path.resolve(String(input)) === realLocal
            ? actual.pathToFileURL(phantomLocal)
            : actual.pathToFileURL(input),
      };
    });

    delete process.env[PM_PACKAGE_ROOT_ENV];
    process.argv.splice(1, 1);
    const loader = await importLoader(pkg, ext);
    await expect(loader.loadPackageRuntimeModule()).rejects.toMatchObject({
      code: "ERR_MODULE_NOT_FOUND",
      message: 12345,
    });
    vi.doUnmock("node:fs");
    vi.doUnmock("node:url");
  });
});
