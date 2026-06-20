import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, vi } from "vitest";

/**
 * Reduce a repo-root-relative script path (e.g. `scripts/release/utils.mjs`) to
 * its `scripts/`-relative name without extension (`release/utils`). Splits on
 * both separators so a caller passing a Windows-style path is normalized
 * regardless of the host platform.
 */
function toScriptName(relativePath: string): string {
  const posixPath = relativePath.split(/[\\/]/).join("/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  return posixPath.replace(/^scripts\//, "").replace(/\.mjs$/, "");
}

/**
 * Import a repository script through a Vite-transformable specifier.
 *
 * The literal `../../scripts/…` prefix and `.mjs` suffix are required for
 * cross-platform correctness. Vite's `dynamic-import-vars` transform only
 * rewrites a dynamic `import()` when its static parts include a directory
 * prefix AND a file extension, and the variable part may only span a single
 * path segment. A fully dynamic specifier (the previous absolute `file://` URL)
 * is left untransformed, so on Windows the `.mjs` script is loaded raw and its
 * leading `#!/usr/bin/env node` shebang reaches the module compiler, throwing
 * `SyntaxError: Invalid or unexpected token`. Branching on the one nested
 * directory (`scripts/release/**`) keeps each variable a single segment so Vite
 * globs and transforms the module — stripping the shebang — on every platform,
 * the same Windows-safety rationale documented in {@link ./sourceModule.ts}.
 *
 * Freshness (re-running the module's top-level code) comes from the
 * `vi.resetModules()` call in the harness `afterEach`, so no cache-bust query
 * is needed; that also keeps relative `vi.doMock` targets of transitive imports
 * matching, since Vite no longer has a parent query to propagate.
 */
async function importTransformedScript<T>(relativePath: string): Promise<T> {
  const name = toScriptName(relativePath);
  const releasePrefix = "release/";
  if (name.startsWith(releasePrefix)) {
    const leaf = name.slice(releasePrefix.length);
    assertSingleSegment(leaf, relativePath);
    return (await import(`../../scripts/release/${leaf}.mjs`)) as T;
  }
  assertSingleSegment(name, relativePath);
  return (await import(`../../scripts/${name}.mjs`)) as T;
}

/**
 * Fail fast when a script name spans more than one path segment. Vite's
 * `dynamic-import-vars` transform only matches a single-segment variable, so a
 * nested path outside the two supported directories (`scripts/` and
 * `scripts/release/`) would be left untransformed and silently regress on
 * Windows. Throwing here turns that into an explicit Linux-time error so a
 * future contributor knows to add a dedicated branch.
 */
function assertSingleSegment(segment: string, relativePath: string): void {
  if (segment.includes("/")) {
    throw new Error(
      `importTransformedScript: unsupported nested script path "${relativePath}". ` +
        "Vite dynamic-import-vars requires a single-segment variable; add a dedicated branch for this directory.",
    );
  }
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
   * Import a repo script so its top-level code re-runs. Freshness comes from
   * the `vi.resetModules()` call in the registered `afterEach`, so the optional
   * `queryPrefix` (retained for call-site compatibility) no longer affects
   * module identity.
   */
  importModule<T>(relativePath: string, queryPrefix?: string): Promise<T>;
  /**
   * Alias of {@link ScriptHarness.importModule}. Both routes go through a
   * Vite-transformable specifier with no cache-bust query, so relative
   * `vi.doMock` targets of transitive imports keep matching (Vite has no parent
   * query to propagate) and freshness still comes from `vi.resetModules()`.
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
    async importModule<T>(relativePath: string): Promise<T> {
      return importTransformedScript<T>(relativePath);
    },
    async importModuleStable<T>(relativePath: string): Promise<T> {
      return importTransformedScript<T>(relativePath);
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
