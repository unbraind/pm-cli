/** @module tests/unit/core/item/sqlite-runtime
 * Checks the optional native loader's exact warning boundary and restoration.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { _testOnly } from "../../../../src/core/store/item-metadata-query-index.js";

describe("optional SQLite runtime diagnostics", () => {
  it("filters only the native experimental announcement during synchronous loading and restores warning delivery", () => {
    const warning = "SQLite is an experimental feature and might change at any time";
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const constructor = _testOnly.loadDatabaseSync((specifier) => {
        expect(specifier).toBe("node:sqlite");
        process.emitWarning(warning, "ExperimentalWarning");
        process.emitWarning("application warning", "ExperimentalWarning");
        process.emitWarning(warning, "ApplicationWarning", "APP001");
        process.emitWarning(new Error(warning));
        return createRequire(import.meta.url)(specifier) as { DatabaseSync: typeof DatabaseSync };
      });
      expect(constructor).toBeTypeOf("function");
      expect(process.emitWarning).toBe(emitWarning);
      expect(emitWarning).toHaveBeenCalledTimes(3);
      expect(emitWarning).toHaveBeenCalledWith("application warning", "ExperimentalWarning");
      expect(emitWarning).toHaveBeenCalledWith(warning, "ApplicationWarning", "APP001");
      expect(emitWarning).toHaveBeenCalledWith(expect.any(Error));
      process.emitWarning(warning, "ExperimentalWarning");
      expect(emitWarning).toHaveBeenCalledTimes(4);
      expect(_testOnly.loadDatabaseSync(() => { throw new Error("unavailable"); })).toBeNull();
      expect(process.emitWarning).toBe(emitWarning);
    } finally {
      emitWarning.mockRestore();
    }
  });

  it("loads native SQLite in a cold subprocess and retains unrelated application diagnostics", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", [
      "import assert from 'node:assert/strict';",
      "import { createRequire } from 'node:module';",
      `import { loadDatabaseSync } from ${JSON.stringify(new URL("../../../../src/core/store/sqlite-runtime.ts", import.meta.url).href)};`,
      "const emitWarning = process.emitWarning;",
      "const DatabaseSync = loadDatabaseSync(createRequire(import.meta.url));",
      "assert.ok(DatabaseSync);",
      "assert.equal(process.emitWarning, emitWarning);",
      "const database = new DatabaseSync(':memory:');",
      "database.exec('CREATE TABLE proof (id INTEGER)');",
      "database.close();",
      "process.emitWarning('application diagnostic survives', 'ApplicationWarning', 'APP_SQLITE');",
      "console.log('cold native load passed');",
    ].join("\n")], {
      encoding: "utf8", timeout: 10_000, windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_NO_WARNINGS: undefined },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("cold native load passed");
    expect(result.stderr).toContain("application diagnostic survives");
    expect(result.stderr).not.toContain("SQLite is an experimental feature and might change at any time");
  });
});
