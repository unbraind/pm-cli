/**
 * Same-count corpus population comparison tests.
 *
 * Tracker: pm-vv2lti.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  compareShapeReports,
  main,
  runCorpusShapeComparisonEntrypoint,
} from "../../../scripts/bench/compare-corpus-shapes.mjs";
import { withTempDir } from "../../helpers/temp.js";

function report(shape: string, p95: number, itemCount = 100, seed = 42) {
  return {
    fixture: {
      item_count: itemCount,
      seed,
      shape: { name: shape, measured_profile: { shape } },
    },
    transports: {
      sdk: {
        search: { p95_ms: p95 },
        zero: { p95_ms: shape === "scratch" ? 0 : 1 },
      },
    },
  };
}

describe("corpus-shape comparison", () => {
  it("classifies faster, slower, zero-baseline, and within-margin operations", () => {
    const compared = compareShapeReports(
      {
        ...report("scratch", 10),
        transports: {
          sdk: {
            faster: { p95_ms: 10 },
            slower: { p95_ms: 10 },
            stable: { p95_ms: 10 },
            zero: { p95_ms: 0 },
          },
        },
      },
      {
        ...report("representative", 10),
        transports: {
          sdk: {
            faster: { p95_ms: 5 },
            slower: { p95_ms: 15 },
            stable: { p95_ms: 11 },
            zero: { p95_ms: 1 },
            ignored: { p95_ms: 1 },
          },
        },
      },
    );
    expect(compared.operations).toMatchObject({
      faster: { classification: "faster", right_vs_left_percent: -50 },
      slower: { classification: "slower", right_vs_left_percent: 50 },
      stable: { classification: "within_margin", right_vs_left_percent: 10 },
      zero: {
        classification: "within_margin",
        right_vs_left_percent: null,
      },
    });
    expect(
      compareShapeReports(report("scratch", 0), report("representative", 0))
        .operations.search,
    ).toMatchObject({
      classification: "within_margin",
      right_vs_left_percent: 0,
    });
  });

  it("writes a shape report and rejects incomparable inputs", async () => {
    await withTempDir("pm-corpus-compare-", async (root) => {
      const output = path.join(root, "comparison.json");
      const run = async (options: { shape: string }) =>
        report(options.shape, options.shape === "scratch" ? 10 : 15);
      await expect(
        main(["--output", output, "--items", "100"], { run }),
      ).resolves.toMatchObject({
        report: {
          item_count: 100,
          left: { shape: "scratch" },
          right: { shape: "representative" },
        },
        outputPath: output,
      });
      expect(JSON.parse(await readFile(output, "utf8")).version).toBe(1);
      await expect(
        main(
          [
            "--output",
            output,
            "--left-shape",
            "deep-graph",
            "--right-shape",
            "multi-decade",
          ],
          { run },
        ),
      ).resolves.toMatchObject({
        report: {
          left: { shape: "deep-graph" },
          right: { shape: "multi-decade" },
        },
      });
      await expect(
        main(["--output"], { run, defaultOutputPath: output }),
      ).resolves.toMatchObject({ outputPath: output });

      await expect(
        main([], {
          run: async (options: { shape: string }) =>
            report(
              options.shape,
              10,
              options.shape === "scratch" ? 100 : 101,
            ),
        }),
      ).rejects.toThrow("identical item counts and seeds");
    });
  });

  it("runs success, failure, default output, and import entrypoint paths", async () => {
    const scriptPath = path.resolve(
      process.cwd(),
      "scripts/bench/compare-corpus-shapes.mjs",
    );
    const successful = async () => ({
      report: {
        item_count: 10,
        left: { shape: "scratch" },
        right: { shape: "representative" },
      },
      outputPath: path.join(process.cwd(), "comparison.json"),
    });
    const write = vi.fn();
    await expect(
      runCorpusShapeComparisonEntrypoint({
        argv: [process.execPath, scriptPath],
        run: successful,
        write,
      }),
    ).resolves.toBe(true);
    expect(String(write.mock.calls[0]?.[0])).toContain('"scratch"');
    await expect(
      runCorpusShapeComparisonEntrypoint({ argv: [process.execPath] }),
    ).resolves.toBe(false);

    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await runCorpusShapeComparisonEntrypoint({
      argv: [process.execPath, scriptPath],
      run: successful,
    });
    expect(stdout).toHaveBeenCalled();
    stdout.mockRestore();

    const onError = vi.fn();
    await expect(
      runCorpusShapeComparisonEntrypoint({
        argv: [process.execPath, scriptPath],
        run: async () => {
          throw new Error("comparison failed");
        },
        onError,
      }),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "comparison failed" }),
    );
    await withTempDir("pm-corpus-entrypoint-default-", async (root) => {
      await expect(
        runCorpusShapeComparisonEntrypoint({
          argv: [
            process.execPath,
            scriptPath,
            "--items",
            "100",
            "--iterations",
            "1",
            "--output",
            path.join(root, "comparison.json"),
          ],
          write,
        }),
      ).resolves.toBe(true);
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("EXIT:1");
      }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runCorpusShapeComparisonEntrypoint({
        argv: [process.execPath, scriptPath],
        run: async () => {
          throw new Error("default comparison failure");
        },
      }),
    ).rejects.toThrow("EXIT:1");
    expect(error).toHaveBeenCalledWith("Error: default comparison failure");
    exit.mockRestore();
    error.mockRestore();
  });
});
