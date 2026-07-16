import { describe, expect, it } from "vitest";

import { normalizeStructuredLinkedTestEntry } from "../../../src/cli/commands/linked-test-entry.js";
import { PmCliError } from "../../../src/core/shared/errors.js";

describe("linked-test-entry.normalizeStructuredLinkedTestEntry", () => {
  it("keeps recognized keys (case-insensitive)", () => {
    expect(
      normalizeStructuredLinkedTestEntry(
        { Command: "node --version", SCOPE: "project" },
        "--test",
      ),
    ).toEqual({
      command: "node --version",
      scope: "project",
    });
  });

  it("pluralizes the error when multiple keys are unknown", () => {
    expect(() =>
      normalizeStructuredLinkedTestEntry({ bogus: "1", other: "2" }, "--add"),
    ).toThrow(/does not recognize keys "bogus", "other"/);
  });

  it("rejects duplicate keys after case normalization", () => {
    expect(() =>
      normalizeStructuredLinkedTestEntry(
        { command: "node --version", COMMAND: "node --help" },
        "--add",
      ),
    ).toThrow(/more than once after case normalization/);
  });

  it("uses singular wording for a single unknown key", () => {
    let captured: unknown;
    try {
      normalizeStructuredLinkedTestEntry({ bogus: "1" }, "--add");
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PmCliError);
    expect((captured as PmCliError).message).toContain(
      'does not recognize key "bogus"',
    );
  });
});
