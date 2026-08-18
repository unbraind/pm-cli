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

  it("classifies a legacy long flag through its canonical alias target", () => {
    const [coverage] = analyzeSdkCliParameterCompleteness({
      actions: ["create"],
      resolveFlags: () => [
        { flag: "--canonical", aliases: ["--legacy"] },
        { flag: "--legacy" },
      ],
      resolveParameters: () => ["canonical"],
    });

    expect(coverage?.cli).toEqual([
      expect.objectContaining({
        input: "--canonical",
        disposition: "shared",
      }),
      expect.objectContaining({
        input: "--legacy",
        counterpart: "canonical",
        disposition: "compatibility_alias",
      }),
    ]);

    const [missingCounterpart] = analyzeSdkCliParameterCompleteness({
      actions: ["create"],
      resolveFlags: () => [
        { flag: "--canonical", aliases: ["--legacy"] },
        { flag: "--legacy" },
      ],
      resolveParameters: () => [],
    });
    expect(missingCounterpart?.unclassified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: "--legacy",
          disposition: "unclassified",
        }),
      ]),
    );
  });
});
