/**
 * Built SDK corpus-shape comparison acceptance coverage.
 *
 * Tracker: pm-vv2lti.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../scripts/bench/compare-corpus-shapes.mjs";
import { withTempDir } from "../helpers/temp.js";

describe("corpus-shape comparison acceptance", () => {
  it("measures both default populations sequentially through the built SDK", async () => {
    await withTempDir("pm-corpus-comparison-", async (root) => {
      await expect(
        main([
          "--items",
          "100",
          "--iterations",
          "1",
          "--output",
          path.join(root, "comparison.json"),
        ]),
      ).resolves.toMatchObject({
        report: {
          item_count: 100,
          left: {
            shape: "scratch",
            measured_profile: { matches_declaration: true },
          },
          right: {
            shape: "representative",
            measured_profile: { matches_declaration: true },
          },
        },
      });
    });
  });
});
