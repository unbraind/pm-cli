import { describe, expect, it } from "vitest";
import { analyzeSdkCliParameterCompleteness } from "../../../../src/sdk/cli-contracts/completeness.js";

describe("SDK CLI completeness normalization", () => {
  it("ignores short and duplicate long flag rows", () => {
    const [coverage] = analyzeSdkCliParameterCompleteness({
      actions: ["create"],
      resolveFlags: () => [
        { flag: "-t" },
        { flag: "--title" },
        { flag: "--title" },
      ],
      resolveParameters: () => ["title"],
    });
    expect(coverage?.cli).toHaveLength(1);
    expect(coverage?.unclassified).toEqual([]);
  });
});
