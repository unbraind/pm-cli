import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, vi } from "vitest";

/**
 * Repo root resolved from this helper's own module URL rather than
 * `process.cwd()`, so script imports stay correct even if a test mutates the
 * working directory.
 */
const HELPER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/**
 * Convert a repo-root-relative module path (e.g. `scripts/finalize-build.mjs`)
 * into a specifier relative to this helper module, using POSIX separators.
 *
 * Vitest reliably transforms modules referenced by relative specifiers (it
 * strips the leading `#!` shebang that repo scripts carry). Absolute `file://`
 * URLs with a drive letter are NOT intercepted by Vitest's transform on
 * Windows, so the raw shebang reaches the module compiler and throws
 * `SyntaxError: Invalid or unexpected token`. Routing every script import
 * through a relative specifier keeps the Windows nightly green; see the same
 * Windows-safety rationale in {@link ../helpers/sourceModule.ts}.
 */
function toRelativeScriptSpecifier(relativePath: string): string {
  const absolutePath = path.resolve(HELPER_DIRECTORY, "..", "..", relativePath);
  const specifier = path.relative(HELPER_DIRECTORY, absolutePath).split(path.sep).join("/");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

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
      return (await import(`${toRelativeScriptSpecifier(relativePath)}?${queryPrefix}=${cacheBustToken()}`)) as T;
    },
    async importModuleStable<T>(relativePath: string): Promise<T> {
      return (await import(toRelativeScriptSpecifier(relativePath))) as T;
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
