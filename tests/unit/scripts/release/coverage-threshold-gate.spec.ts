import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findCoverageDeficits,
  main,
  runIfMain,
} from "../../../../scripts/release/coverage-threshold-gate.mjs";

const complete = {
  lines: { covered: 3, total: 3 },
  branches: { covered: 2, total: 2 },
  functions: { covered: 1, total: 1 },
  statements: { covered: 3, total: 3 },
};

describe("exact coverage threshold gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("accepts only exact covered-versus-total parity", () => {
    expect(
      findCoverageDeficits({ total: complete, "src/complete.ts": complete }),
    ).toEqual([]);
  });

  it("rejects a rounded 100% report using integer uncovered counts", () => {
    const almostComplete = {
      ...complete,
      branches: { covered: 10_000, total: 10_001, pct: 100 },
    };
    expect(
      findCoverageDeficits({
        total: almostComplete,
        "src/almost-complete.ts": almostComplete,
      }),
    ).toEqual([
      {
        file: "total",
        metric: "branches",
        uncovered: 1,
        covered: 10_000,
        total: 10_001,
      },
      {
        file: "src/almost-complete.ts",
        metric: "branches",
        uncovered: 1,
        covered: 10_000,
        total: 10_001,
      },
    ]);
  });

  it("fails closed for missing or malformed counts", () => {
    for (const invalidSummary of ["invalid", null, []]) {
      expect(() => findCoverageDeficits(invalidSummary)).toThrow(
        "Coverage summary must be a JSON object.",
      );
    }
    expect(() => findCoverageDeficits({})).toThrow(
      "Coverage summary is missing the total entry.",
    );
    for (const invalidEntry of ["invalid", null, []]) {
      expect(() => findCoverageDeficits({ total: invalidEntry })).toThrow(
        "Coverage entry for total must be an object.",
      );
    }
    for (const invalidCounts of [
      null,
      3,
      { covered: "3", total: 3 },
      { covered: 3, total: "3" },
      { covered: 2.5, total: 3 },
      { covered: 2, total: 2.5 },
      { covered: -1, total: 3 },
      { covered: 4, total: 3 },
    ]) {
      expect(() =>
        findCoverageDeficits({
          total: { ...complete, lines: invalidCounts },
        }),
      ).toThrow("Coverage entry total has invalid lines counts.");
    }
  });

  it("reports actionable file deficits and entrypoint outcomes", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pm-coverage-gate-"));
    const summaryPath = path.join(root, "coverage-summary.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      writeFileSync(
        summaryPath,
        JSON.stringify({ total: complete, "src/ok.ts": complete }),
      );
      main(summaryPath);
      expect(log).toHaveBeenCalledWith(
        "Exact coverage gate passed: 100/100/100/100 with zero uncovered counts.",
      );

      const deficient = { ...complete, lines: { covered: 2, total: 3 } };
      writeFileSync(
        summaryPath,
        JSON.stringify({ total: deficient, "src/missing.ts": deficient }),
      );
      main(summaryPath);
      expect(error).toHaveBeenCalledWith(
        "- src/missing.ts: lines 2/3 (1 uncovered)",
      );
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      runIfMain("");
      runIfMain("/tmp/not-coverage-threshold-gate.mjs");
      expect(process.exitCode).toBeUndefined();

      const originalCwd = process.cwd();
      const defaultSummaryRoot = path.join(root, "default");
      mkdirSync(path.join(defaultSummaryRoot, "coverage"), { recursive: true });
      writeFileSync(
        path.join(defaultSummaryRoot, "coverage", "coverage-summary.json"),
        JSON.stringify({ total: complete }),
      );
      process.chdir(defaultSummaryRoot);
      try {
        runIfMain(
          fileURLToPath(
            new URL(
              "../../../../scripts/release/coverage-threshold-gate.mjs",
              import.meta.url,
            ),
          ),
        );
      } finally {
        process.chdir(originalCwd);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
