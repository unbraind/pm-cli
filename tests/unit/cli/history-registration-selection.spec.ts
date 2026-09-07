/** @module tests/unit/cli/history-registration-selection
 * Keeps legacy maintenance startup limited to the same mutation family as restore.
 */
import { describe, expect, it } from "vitest";
import { _testOnly } from "../../../src/cli/main.js";

describe("history maintenance registration selection", () => {
  it("loads only mutation registrations for each legacy maintenance command", () => {
    for (const command of ["history-repair", "history-redact", "history-compact"]) {
      expect(_testOnly.resolveCoreCommandRegistrationSelection([command])).toEqual({
        setup: false,
        listQuery: false,
        mutation: true,
        operation: false,
        targetCommandName: command,
      });
    }
  });
});
