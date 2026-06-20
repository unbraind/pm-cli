import { describe, expect, it } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

/**
 * Locks the Windows-safety contract of the shared script-test harness: imports
 * must route through Vite-transformable `../../scripts/${name}.mjs` specifiers
 * so the `#!/usr/bin/env node` shebang is stripped on every platform, and any
 * path Vite's `dynamic-import-vars` transform cannot match must fail fast on
 * Linux rather than silently regress on Windows.
 */
describe("scriptModule harness imports", () => {
  const harness = createScriptHarness();

  it("imports a top-level scripts/ module", async () => {
    const mod = await harness.importModule<{ main: unknown }>("scripts/finalize-build.mjs");
    expect(typeof mod.main).toBe("function");
  });

  it("imports a nested scripts/release/ module via its dedicated branch", async () => {
    const mod = await harness.importModuleStable<Record<string, unknown>>("scripts/release/utils.mjs");
    expect(mod).toBeTypeOf("object");
  });

  it("normalizes Windows-style separators and a leading slash to the same module", async () => {
    const viaPosix = await harness.importModule<{ main: unknown }>("scripts/finalize-build.mjs");
    const viaWindows = await harness.importModule<{ main: unknown }>("\\scripts\\finalize-build.mjs");
    expect(viaWindows.main).toBe(viaPosix.main);
  });

  it("fails fast on an unsupported nested script path instead of regressing on Windows", async () => {
    await expect(harness.importModule("scripts/plugins/foo.mjs")).rejects.toThrow(/unsupported nested script path/);
  });

  it("fails fast on an unsupported nested release script path", async () => {
    await expect(harness.importModule("scripts/release/nested/foo.mjs")).rejects.toThrow(
      /unsupported nested script path/,
    );
  });
});
