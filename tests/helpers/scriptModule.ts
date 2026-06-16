import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, vi } from "vitest";

/**
 * Shared harness for unit-testing repository scripts (scripts/**, plugins/**,
 * docs/examples/**) by importing the real module under deterministic mocks.
 *
 * Replaces the per-file boilerplate previously duplicated across the coverage
 * spec suite. Each script spec calls {@link createScriptHarness} once at module
 * scope to register an `afterEach` that restores process state, unmocks any
 * modules touched during the test, and removes temp directories.
 */

export interface ScriptHarness {
  /**
   * Import a repo module fresh (cache-busted) so its top-level code re-runs.
   * Use when the module has no relative `vi.doMock` targets that must match.
   */
  importModule<T>(relativePath: string, queryPrefix?: string): Promise<T>;
  /**
   * Import a repo module without a cache-bust query so relative `vi.doMock`
   * targets of transitive imports still match (Vite propagates the parent
   * query onto child specifiers). Freshness comes from `vi.resetModules()`
   * in the registered `afterEach`.
   */
  importModuleStable<T>(relativePath: string): Promise<T>;
  /** Create a tracked temp directory removed automatically after each test. */
  createTempRoot(prefix: string): Promise<string>;
  /** Spy on `process.exit` so it throws `EXIT:<code>` instead of exiting. */
  mockProcessExit(): ReturnType<typeof vi.spyOn>;
  /**
   * Poll `assertion` until it passes or the timeout elapses. Used by scripts
   * whose top-level module body kicks off async work (e.g. an IIFE writing to
   * stdout) that the test must await without a fixed sleep.
   */
  waitForCondition(assertion: () => void, timeoutMs?: number): Promise<void>;
}

let cacheBustCounter = 0;

function cacheBustToken(): string {
  cacheBustCounter += 1;
  return `n${cacheBustCounter}`;
}

/**
 * Register the shared script-test harness. Pass the relative module specifiers
 * that individual tests may `vi.doMock`, so they are reliably unmocked between
 * tests (order-independent, leak-free).
 */
export function createScriptHarness(unmockSpecifiers: readonly string[] = []): ScriptHarness {
  const originalArgv = [...process.argv];
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const tempRoots: string[] = [];

  const builtinUnmocks = [
    "node:child_process",
    "node:fs",
    "node:fs/promises",
    "node:readline",
  ];

  afterEach(async () => {
    process.argv = [...originalArgv];
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    process.exitCode = 0;
    globalThis.fetch = originalFetch;
    for (const specifier of [...builtinUnmocks, ...unmockSpecifiers]) {
      vi.doUnmock(specifier);
    }
    vi.restoreAllMocks();
    vi.resetModules();
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  return {
    async importModule<T>(relativePath: string, queryPrefix = "v"): Promise<T> {
      const absolutePath = path.join(process.cwd(), relativePath);
      return (await import(`${pathToFileURL(absolutePath).href}?${queryPrefix}=${cacheBustToken()}`)) as T;
    },
    async importModuleStable<T>(relativePath: string): Promise<T> {
      const absolutePath = path.join(process.cwd(), relativePath);
      return (await import(pathToFileURL(absolutePath).href)) as T;
    },
    async createTempRoot(prefix: string): Promise<string> {
      const root = await mkdtemp(path.join(os.tmpdir(), prefix));
      tempRoots.push(root);
      return root;
    },
    mockProcessExit() {
      return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`EXIT:${String(code ?? "")}`);
      }) as never);
    },
    async waitForCondition(assertion: () => void, timeoutMs = 3000): Promise<void> {
      const startedAt = Date.now();
      let lastError: unknown = null;
      while (Date.now() - startedAt < timeoutMs) {
        try {
          assertion();
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (lastError instanceof Error) {
        throw lastError;
      }
      throw new Error("Condition did not pass before timeout.");
    },
  };
}
