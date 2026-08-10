/**
 * @module absence-tolerance-gate tests
 *
 * Proves the ENOENT-only absence detector recognises both the helper-call and
 * inline comparison shapes, ignores clauses that already accept ENOTDIR, and
 * that the ratchet fails in both directions rather than only on regression.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectScanFiles,
  evaluateAbsenceTolerance,
  findEnoentOnlyAbsenceCatches,
  main,
  readBaseline,
  runAbsenceToleranceGate,
} from "../../../../scripts/release/absence-tolerance-gate.mjs";

const temporaryRoots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-absence-gate-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "src", "core"), { recursive: true });
  return root;
}

async function baselineFile(root: string, ceiling: unknown): Promise<string> {
  const target = path.join(root, "baseline.json");
  await writeFile(
    target,
    JSON.stringify({
      version: 1,
      max_enoent_only_absence_catches: ceiling,
    }),
    "utf8",
  );
  return target;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("findEnoentOnlyAbsenceCatches", () => {
  it("flags the inline comparison shape", () => {
    const source = `
      export async function read(): Promise<string | null> {
        try {
          return await load();
        } catch (error: unknown) {
          if ((error as { code?: string }).code === "ENOENT") return null;
          throw error;
        }
      }
    `;
    const findings = findEnoentOnlyAbsenceCatches(source, "src/core/a.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(5);
  });

  it("flags the helper-call shape where the literal is a call argument", () => {
    const source = `
      try { run(); } catch (error) { if (isErrno(error, "ENOENT")) return null; throw error; }
    `;
    expect(findEnoentOnlyAbsenceCatches(source, "src/core/b.ts")).toHaveLength(
      1,
    );
  });

  it("accepts a clause that already tolerates ENOTDIR", () => {
    const source = `
      try { run(); } catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return null;
        throw error;
      }
    `;
    expect(findEnoentOnlyAbsenceCatches(source, "src/core/c.ts")).toEqual([]);
  });

  it("ignores clauses that never mention absence at all", () => {
    const source = `try { run(); } catch { return null; }`;
    expect(findEnoentOnlyAbsenceCatches(source, "src/core/d.ts")).toEqual([]);
  });

  it("descends into nested functions rather than stopping at the first child", () => {
    const source = `
      export function outer() {
        function inner() {
          try { a(); } catch (e) { if (isErrno(e, "ENOENT")) return null; throw e; }
        }
        try { b(); } catch (e) { if (isErrno(e, "ENOENT")) return null; throw e; }
        return inner;
      }
    `;
    expect(findEnoentOnlyAbsenceCatches(source, "src/core/e.ts")).toHaveLength(
      2,
    );
  });
});

describe("collectScanFiles", () => {
  it("returns sorted TypeScript sources and skips declarations and build output", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "src", "dist"), { recursive: true });
    await writeFile(path.join(root, "src", "b.ts"), "export {};", "utf8");
    await writeFile(path.join(root, "src", "a.ts"), "export {};", "utf8");
    await writeFile(path.join(root, "src", "types.d.ts"), "export {};", "utf8");
    await writeFile(path.join(root, "src", "notes.md"), "text", "utf8");
    await writeFile(path.join(root, "src", "dist", "x.ts"), "export {};", "utf8");
    const files = await collectScanFiles(root, ["src"]);
    expect(files.map((file: string) => path.basename(file))).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("skips scan roots that do not exist", async () => {
    const root = await fixtureRoot();
    expect(await collectScanFiles(root, ["missing"])).toEqual([]);
  });
});

describe("readBaseline", () => {
  it("reads a non-negative integer ceiling", async () => {
    const root = await fixtureRoot();
    const target = await baselineFile(root, 3);
    expect((await readBaseline(target)).ceiling).toBe(3);
  });

  it("falls back to the repository baseline when no path is given", async () => {
    const { ceiling } = await readBaseline();
    expect(Number.isInteger(ceiling)).toBe(true);
    expect(ceiling).toBeGreaterThanOrEqual(0);
  });

  it("refuses a non-integer ceiling", async () => {
    const root = await fixtureRoot();
    const target = await baselineFile(root, "many");
    await expect(readBaseline(target)).rejects.toThrow(
      /must be a non-negative integer/u,
    );
  });

  it("refuses a negative ceiling", async () => {
    const root = await fixtureRoot();
    const target = await baselineFile(root, -1);
    await expect(readBaseline(target)).rejects.toThrow(
      /must be a non-negative integer/u,
    );
  });
});

describe("evaluateAbsenceTolerance", () => {
  it("holds when observed equals the ceiling", () => {
    const report = evaluateAbsenceTolerance([{ file: "a", line: 1 }], 1);
    expect(report).toMatchObject({ ok: true, direction: "held", observed: 1 });
  });

  it("fails upward on a regression", () => {
    const report = evaluateAbsenceTolerance(
      [
        { file: "a", line: 1 },
        { file: "b", line: 2 },
      ],
      1,
    );
    expect(report.ok).toBe(false);
    expect(report.direction).toBe("regression");
    expect(report.message).toContain("isFileAbsentError");
  });

  it("fails downward so an undeclared improvement cannot leave slack", () => {
    const report = evaluateAbsenceTolerance([], 2);
    expect(report.ok).toBe(false);
    expect(report.direction).toBe("undeclared_improvement");
    expect(report.message).toContain("Lower max_enoent_only_absence_catches");
  });
});

describe("runAbsenceToleranceGate", () => {
  it("scores the supplied files against the declared ceiling", async () => {
    const root = await fixtureRoot();
    const target = path.join(root, "src", "core", "reader.ts");
    await writeFile(
      target,
      `try { a(); } catch (e) { if (isErrno(e, "ENOENT")) return null; throw e; }`,
      "utf8",
    );
    const baseline = await baselineFile(root, 1);
    const report = await runAbsenceToleranceGate({
      baselinePath: baseline,
      files: [target],
    });
    expect(report).toMatchObject({ ok: true, observed: 1 });
  });

  it("discovers files from the repository when none are supplied", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "src", "clean.ts"), "export {};", "utf8");
    const baseline = await baselineFile(root, 0);
    const report = await runAbsenceToleranceGate({
      baselinePath: baseline,
      root,
    });
    expect(report).toMatchObject({ ok: true, observed: 0 });
  });
});

describe("main", () => {
  it("reports the held ceiling on stdout", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "src", "clean.ts"), "export {};", "utf8");
    const baseline = await baselineFile(root, 45);
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const report = await main(["--baseline", baseline]);
    expect(report.ok).toBe(true);
    expect(write.mock.calls.at(-1)?.[0]).toContain("absence-tolerance-gate ok");
  });

  it("prints offending sites and fails when the ceiling is breached", async () => {
    const root = await fixtureRoot();
    const baseline = await baselineFile(root, 0);
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const report = await main(["--baseline", baseline]);
    expect(report.ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0]?.[0]).toContain("absence-tolerance-gate:");
    expect(write).toHaveBeenCalled();
  });

  it("defaults to the repository baseline when no flag is passed", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const report = await main([]);
    expect(report.ok).toBe(true);
    expect(write).toHaveBeenCalled();
  });
});
