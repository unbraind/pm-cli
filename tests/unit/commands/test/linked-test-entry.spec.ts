import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { admitLinkedTestRequest, assertLinkedTestContext, normalizeStructuredLinkedTestEntry } from "../../../../src/sdk/test/entry.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";

describe("linked-test context recovery", () => {
  it("preserves fatal failures and normalizes only pre-write usage refusals", () => {
    const receipt = { selected: [1] };
    expect(admitLinkedTestRequest(() => receipt)).toBe(receipt);
    for (const original of [new Error("unexpected failure"), new PmCliError("execution failure", 5)]) {
      try {
        admitLinkedTestRequest(() => { throw original; });
        expect.unreachable("Fatal failures must propagate");
      } catch (error) {
        expect(error).toBe(original);
        expect(error).not.toHaveProperty("context.changed");
      }
    }
    expect(() => admitLinkedTestRequest(() => { throw new PmCliError("invalid value", 2); })).toThrow(expect.objectContaining({
      code: "invalid_argument_value", context: expect.objectContaining({ changed: false, required: "invalid value" }),
    }));
  });
  it.skipIf(process.platform === "win32").each([
    "node --version",
    "node -e 'console.log(\"quoted\", \"$HOME\", \"$(printf changed)\", \"`printf changed`\")'",
  ])("preserves the complete command as one JSON argument: %s", (command) => {
    let captured: unknown;
    try {
      assertLinkedTestContext({ command, pm_context_mode: "none" });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PmCliError);
    const example = (captured as PmCliError).context.examples?.[0];
    expect(example).toBeDefined();
    // Record shell-parsed argv without invoking pm or executing the linked test.
    const result = spawnSync("sh", ["-c", `pm() { printf '%s\\0' "$@"; }\n${example}`], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const args = result.stdout.split("\0").slice(0, -1);
    expect(args.slice(0, 3)).toEqual(["test", "<id>", "--add-json"]);
    expect(args).toHaveLength(4);
    expect(JSON.parse(args[3])).toEqual({
      command,
      pm_context_mode: "none",
      workspace_context_mode: "isolated",
    });
  });
});

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
