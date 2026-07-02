import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach } from "vitest";

/** Environment variable the package runtimes read to locate the installed pm CLI root. */
export const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

/** Returns a unique token used to bust the ESM module cache between imports. */
export function cacheBustToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Resets the globalThis call log the stub SDK runtime modules append to. */
export function resetGlobalCallLog(key: string): void {
  (globalThis as Record<string, unknown>)[key] = [];
}

/** Reads the globalThis call log the stub SDK runtime modules append to. */
export function readGlobalCallLog<T>(key: string): T[] {
  const value = (globalThis as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Writes a stub `dist/sdk/runtime.js` module under the given package root. */
export async function writeSdkRuntimeModule(root: string, source: string): Promise<void> {
  const sdkRoot = path.join(root, "dist", "sdk");
  await mkdir(sdkRoot, { recursive: true });
  await writeFile(path.join(sdkRoot, "runtime.js"), source, "utf8");
}

/** Imports a repo-relative module with a cache-busting query so each call gets a fresh instance. */
export async function importRepoModule<T>(relativePath: string, queryPrefix: string): Promise<T> {
  const absolutePath = path.join(process.cwd(), relativePath);
  return (await import(`${pathToFileURL(absolutePath).href}?${queryPrefix}=${cacheBustToken()}`)) as T;
}

/** Temp-root factory returned by {@link setupPackageRuntimeSpec}. */
export interface PackageRuntimeSpecContext {
  /** Creates a temp directory (removed in afterEach) to serve as PM_CLI_PACKAGE_ROOT. */
  createTempRoot(prefix: string): Promise<string>;
}

/**
 * Installs the shared package-runtime spec scaffolding: captures the original
 * PM_CLI_PACKAGE_ROOT value and registers an afterEach that restores it and
 * removes every temp root created via the returned factory.
 *
 * Call once at the top level of a package-runtime spec module.
 */
export function setupPackageRuntimeSpec(): PackageRuntimeSpecContext {
  const originalPackageRoot = process.env[PM_PACKAGE_ROOT_ENV];
  const tempRoots: string[] = [];

  afterEach(async () => {
    if (originalPackageRoot === undefined) {
      delete process.env[PM_PACKAGE_ROOT_ENV];
    } else {
      process.env[PM_PACKAGE_ROOT_ENV] = originalPackageRoot;
    }

    // Attempt every removal even if one fails, then surface the first failure.
    const removals = await Promise.allSettled(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
    const failed = removals.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (failed) {
      throw failed.reason;
    }
  });

  return {
    async createTempRoot(prefix: string): Promise<string> {
      const root = await mkdtemp(path.join(os.tmpdir(), prefix));
      tempRoots.push(root);
      return root;
    },
  };
}
