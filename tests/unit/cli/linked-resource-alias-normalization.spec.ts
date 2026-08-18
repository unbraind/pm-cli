/**
 * @file Validates canonical linked-resource normalization across CLI aliases.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeCreateOptions,
  normalizeUpdateOptions,
} from "../../../src/sdk/cli-contracts/registration-helpers.js";

describe("linked-resource alias normalization", () => {
  it("folds alias-only create and update arrays into canonical keys", () => {
    expect(
      normalizeCreateOptions(
        {
          type: "Task",
          linkedFile: ["path=src/a.ts,scope=project"],
          linkedTest: ["command=pnpm test,scope=project"],
        },
        { requireType: false },
      ),
    ).toMatchObject({
      file: ["path=src/a.ts,scope=project"],
      test: ["command=pnpm test,scope=project"],
    });
    expect(
      normalizeUpdateOptions({
        linkedFile: ["path=src/b.ts,scope=project"],
        linkedTest: ["command=pnpm lint,scope=project"],
      }),
    ).toMatchObject({
      file: ["path=src/b.ts,scope=project"],
      test: ["command=pnpm lint,scope=project"],
    });
  });

  it("normalizes empty canonical and alias arrays to undefined", () => {
    expect(
      normalizeCreateOptions(
        { type: "Task", file: [], linkedFile: [], test: [], linkedTest: [] },
        { requireType: false },
      ),
    ).toMatchObject({ file: undefined, test: undefined });
    expect(
      normalizeUpdateOptions({
        file: [],
        linkedFile: [],
        test: [],
        linkedTest: [],
      }),
    ).toMatchObject({ file: undefined, test: undefined });
  });
});
