/** @module tests/unit/core/item/sqlite-runtime
 * Checks the optional native loader's exact warning boundary and restoration.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { _testOnly } from "../../../../src/core/store/item-metadata-query-index.js";

describe("optional SQLite runtime diagnostics", () => {
  it("filters only the native experimental announcement during synchronous loading and restores warning delivery", () => {
    const warning = "SQLite is an experimental feature and might change at any time";
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      expect(_testOnly.loadDatabaseSync((specifier) => {
        expect(specifier).toBe("node:sqlite");
        process.emitWarning(warning, "ExperimentalWarning");
        process.emitWarning("application warning", "ExperimentalWarning");
        process.emitWarning(warning, "ApplicationWarning", "APP001");
        process.emitWarning(new Error(warning));
        return { DatabaseSync };
      })).toBe(DatabaseSync);
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
});
