import { describe, expect, it } from "vitest";
import {
  resolveSourceContextWritePolicy,
  SOURCE_CONTEXT_ACCESS_ENV,
  SOURCE_CONTEXT_WRITE_OVERRIDE_ENV,
} from "../../../src/sdk/environment/source-context.js";
import {
  LINKED_TEST_PROTECTED_ENV_KEYS,
  parseLinkedTestEnvClear,
  parseLinkedTestEnvSet,
} from "../../../src/sdk/test/parsers.js";
import { runLinkedTests } from "../../../src/sdk/test/execution.js";

describe("source context write policy", () => {
  it("preserves legacy writes and requires an explicit read-only override", () => {
    expect(resolveSourceContextWritePolicy({})).toEqual({
      access: "write",
      write_override_applied: false,
      source_writes_allowed: true,
    });
    expect(
      resolveSourceContextWritePolicy({
        [SOURCE_CONTEXT_ACCESS_ENV]: "read_only",
      }),
    ).toEqual({
      access: "read_only",
      write_override_applied: false,
      source_writes_allowed: false,
    });
    expect(
      resolveSourceContextWritePolicy({
        [SOURCE_CONTEXT_ACCESS_ENV]: " read_only ",
        [SOURCE_CONTEXT_WRITE_OVERRIDE_ENV]: "1",
      }),
    ).toEqual({
      access: "read_only",
      write_override_applied: true,
      source_writes_allowed: true,
    });
  });

  it("protects the host-owned access and override variables from test metadata", () => {
    expect(LINKED_TEST_PROTECTED_ENV_KEYS.has(SOURCE_CONTEXT_ACCESS_ENV)).toBe(
      true,
    );
    expect(
      LINKED_TEST_PROTECTED_ENV_KEYS.has(SOURCE_CONTEXT_WRITE_OVERRIDE_ENV),
    ).toBe(true);
    expect(() =>
      parseLinkedTestEnvSet(
        `${SOURCE_CONTEXT_WRITE_OVERRIDE_ENV}=1`,
        "--env-set",
      ),
    ).toThrow(/reserved for sandbox safety/);
    expect(() =>
      parseLinkedTestEnvClear(SOURCE_CONTEXT_ACCESS_ENV, "--env-clear"),
    ).toThrow(/reserved for sandbox safety/);
  });

  it("marks every linked-test child source context read-only", async () => {
    const [result] = await runLinkedTests(
      [
        {
          command:
            'node -e "process.stdout.write(process.env.PM_SOURCE_CONTEXT_ACCESS ?? \'missing\')"',
          scope: "project",
        },
      ],
      20,
    );
    expect(result).toMatchObject({ status: "passed", stdout: "read_only" });
  });
});
