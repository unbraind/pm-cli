import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness(["../../../../scripts/release/utils.mjs"]);

const SCRIPT = "scripts/release/static-quality-gate.mjs";

type SqModule = {
  walkFiles: (dir: string, matcher: (p: string) => boolean, out?: string[]) => string[];
  relativeToRepo: (abs: string) => string;
  checkFileLength: (files: string[], maxSrc: number, maxTest: number) => unknown[];
  checkDirectoryLoad: (files: string[], maxPerDir: number) => unknown[];
  normalizeLine: (line: string) => string;
  checkDuplicateChunks: (files: string[], window: number, maxChunks: number) => unknown[];
  resolveRelativeImport: (fromAbs: string, spec: string) => string | null;
  sourceFilesOnly: (files: string[]) => string[];
  checkOrphanSourceModules: (files: string[]) => Array<{ path: string }>;
  complexityContribution: (node: unknown) => number;
  functionLikeName: (node: unknown, sf: unknown) => string;
  checkFunctionComplexity: (files: string[], max: number) => Array<{ function_name: string; complexity: number }>;
  usage: () => void;
  parseNumberFlag: (flags: Map<string, unknown>, key: string, fallback: number) => number;
  main: () => void;
};

function mockUtils(repoRoot: string): void {
  vi.doMock("../../../../scripts/release/utils.mjs", async () => {
    const actual = await vi.importActual<typeof import("../../../../scripts/release/utils.mjs")>(
      "../../../../scripts/release/utils.mjs",
    );
    return {
      ...actual,
      repoRoot,
      fail(message: string, exitCode = 1) {
        throw new Error(`FAIL:${exitCode}:${message}`);
      },
    };
  });
}

function mockFs(impl: Partial<typeof import("node:fs")>): void {
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return { ...actual, ...impl };
  });
}

describe("static-quality-gate", () => {
  describe("pure helpers", () => {
    it("covers usage, normalizeLine, and scalar normalize branches", async () => {
      mockUtils("/repo");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      mod.usage();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Usage:"))).toBe(true);

      expect(mod.normalizeLine("   ")).toBe("");
      expect(mod.normalizeLine("// comment")).toBe("");
      expect(mod.normalizeLine("/* block")).toBe("");
      expect(mod.normalizeLine("* jsdoc")).toBe("");
      expect(mod.normalizeLine("*/")).toBe("");
      expect(mod.normalizeLine("const   x   =  1")).toBe("const x = 1");
    });

    it("parseNumberFlag: fallback, valid, invalid", async () => {
      mockUtils("/repo");
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      expect(mod.parseNumberFlag(new Map(), "x", 7)).toBe(7);
      expect(mod.parseNumberFlag(new Map([["x", "12"]]), "x", 7)).toBe(12);
      expect(() => mod.parseNumberFlag(new Map([["x", "-1"]]), "x", 7)).toThrow(/Invalid --x/);
      expect(() => mod.parseNumberFlag(new Map([["x", "nan"]]), "x", 7)).toThrow(/Invalid --x/);
    });

    it("checkFileLength + checkDirectoryLoad flag oversize files and dense dirs", async () => {
      mockUtils("/repo");
      mockFs({
        readFileSync: vi.fn((p: string) => {
          if (String(p).endsWith("big.ts")) return "a\n".repeat(10);
          if (String(p).endsWith("bigtest.ts")) return "a\n".repeat(10);
          return "one\ntwo";
        }) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const lenViol = mod.checkFileLength(
        ["/repo/src/big.ts", "/repo/tests/bigtest.ts", "/repo/src/small.ts"],
        3,
        3,
      ) as Array<{ path: string }>;
      expect(lenViol.some((v) => v.path === "src/big.ts")).toBe(true);
      expect(lenViol.some((v) => v.path === "tests/bigtest.ts")).toBe(true);
      expect(lenViol.some((v) => v.path === "src/small.ts")).toBe(false);

      // Two over-budget directories so the sort comparator (line 74) runs.
      const dirViol = mod.checkDirectoryLoad(
        ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts", "/repo/lib/d.ts", "/repo/lib/e.ts", "/repo/x/f.ts"],
        1,
      ) as Array<{ directory: string; file_count: number }>;
      expect(dirViol.some((v) => v.directory === "src" && v.file_count === 3)).toBe(true);
      expect(dirViol.some((v) => v.directory === "lib" && v.file_count === 2)).toBe(true);
      // Sorted descending by file_count.
      expect(dirViol[0].file_count).toBeGreaterThanOrEqual(dirViol[1].file_count);
    });

    it("checkDuplicateChunks: dup, skip-blank, same-file, cap, and overlapping-duplicate guard", async () => {
      mockUtils("/repo");
      const dupBlock = ["line one here", "line two here", "line three here", "line four here", "line five here"].join(
        "\n",
      );
      // A file that repeats two distinct 5-line blocks so b.ts matches a.ts at two
      // non-overlapping offsets — the second match for the same path pair is far
      // enough away that the overlap guard is false (pushes a second duplicate),
      // while a near-adjacent third match trips the overlap guard (continue).
      const dupBlockB = [
        "line one here",
        "line two here",
        "line three here",
        "line four here",
        "line five here",
        "spacer alpha one",
        "spacer alpha two",
        "spacer alpha three",
        "spacer alpha four",
        "spacer alpha five",
        "spacer alpha six",
        "spacer alpha seven",
        "line one here",
        "line two here",
        "line three here",
        "line four here",
        "line five here",
      ].join("\n");
      mockFs({
        readFileSync: vi.fn((p: string) => {
          const s = String(p);
          if (s.endsWith("a.ts")) return dupBlock;
          if (s.endsWith("b.ts")) return dupBlockB;
          if (s.endsWith("blank.ts")) return "x\n\ny\n\nz\n\nq\n\nr";
          return "";
        }) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      // a.ts has one 5-line window; b.ts repeats it twice. The first b.ts match
      // records a duplicate; the second match is non-overlapping → second duplicate.
      const dups = mod.checkDuplicateChunks(["/repo/src/core/a.ts", "/repo/src/core/b.ts"], 5, 10) as Array<unknown>;
      expect(dups.length).toBeGreaterThanOrEqual(1);

      // window with blank lines is skipped → no dup
      expect(mod.checkDuplicateChunks(["/repo/src/core/blank.ts"], 5, 4)).toEqual([]);

      // cap: maxDuplicateChunks=0 → returns early after first dup pushed
      const capped = mod.checkDuplicateChunks(["/repo/src/core/a.ts", "/repo/src/core/b.ts"], 5, 0) as Array<unknown>;
      expect(capped.length).toBe(1);
    });

    it("checkDuplicateChunks: same-file repeat is ignored (first.path === current.path)", async () => {
      mockUtils("/repo");
      const repeated = [
        "alpha line one",
        "alpha line two",
        "alpha line three",
        "alpha line four",
        "alpha line five",
        "alpha line one",
        "alpha line two",
        "alpha line three",
        "alpha line four",
        "alpha line five",
      ].join("\n");
      mockFs({
        readFileSync: vi.fn(() => repeated) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      // Single file repeating a window — the same-file branch (line 115/116) continues.
      expect(mod.checkDuplicateChunks(["/repo/src/core/dup.ts"], 5, 4)).toEqual([]);
    });

    it("checkDuplicateChunks: overlapping-duplicate guard skips near-adjacent re-match", async () => {
      mockUtils("/repo");
      // a.ts has a sliding pair of windows; b.ts repeats the same content so each of
      // a.ts's overlapping windows produces a near-adjacent match for the same path
      // pair — the second match trips isOverlappingDuplicate (line 118-126).
      const block = [
        "shared row one",
        "shared row two",
        "shared row three",
        "shared row four",
        "shared row five",
        "shared row six",
      ].join("\n");
      mockFs({
        readFileSync: vi.fn((p: string) => {
          const s = String(p);
          if (s.endsWith("a.ts")) return block;
          if (s.endsWith("b.ts")) return block;
          return "";
        }) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      // window=5 over a 6-line block yields windows at offsets 0 and 1. The offset-1
      // window of b.ts matches a.ts's offset-1 window adjacent to the offset-0 pair
      // → overlap guard returns true and continues, leaving a single duplicate.
      const dups = mod.checkDuplicateChunks(["/repo/src/core/a.ts", "/repo/src/core/b.ts"], 5, 10) as Array<unknown>;
      expect(dups.length).toBe(1);
    });

    it("resolveRelativeImport: non-relative null, resolves .ts, missing → null", async () => {
      mockUtils("/repo");
      mockFs({
        statSync: vi.fn((p: string) => {
          if (String(p) === "/repo/src/dep.ts") return { isFile: () => true } as unknown as import("node:fs").Stats;
          throw Object.assign(new Error("nope"), { code: "ENOENT" });
        }) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      expect(mod.resolveRelativeImport("/repo/src/main.ts", "node:path")).toBeNull();
      expect(mod.resolveRelativeImport("/repo/src/main.ts", "./dep")).toBe("/repo/src/dep.ts");
      expect(mod.resolveRelativeImport("/repo/src/main.ts", "./gone")).toBeNull();
    });

    it("checkOrphanSourceModules: flags multiple orphans (sort), honors allowlist + skip + out-of-set import", async () => {
      mockUtils("/repo");
      const fileBodies: Record<string, string> = {
        // imports a path that resolves OUTSIDE the incoming map → exercises the
        // `incoming.has(resolved)` false branch (line 188) without crediting it.
        "/repo/src/cli/main.ts": 'import "../used.ts";\nexport * from "../barrel/index.ts";\nimport "../../external/out.ts";',
        "/repo/src/used.ts": "export const used = 1;",
        // Two orphans so the final sort comparator (line 227) is exercised.
        "/repo/src/zeta-orphan.ts": "export const z = 1;",
        "/repo/src/alpha-orphan.ts": "export const a = 1;",
        "/repo/src/types/x.ts": "export type X = 1;",
        "/repo/src/barrel/index.ts": "export const b = 1;",
        "/repo/src/thing.spec.ts": "export const t = 1;",
      };
      mockFs({
        readFileSync: vi.fn((p: string) => fileBodies[String(p)] ?? "") as never,
        statSync: vi.fn((p: string) => {
          if (Object.prototype.hasOwnProperty.call(fileBodies, String(p))) {
            return { isFile: () => true } as unknown as import("node:fs").Stats;
          }
          // The external import target resolves to a real file but is outside the set.
          if (String(p) === "/repo/external/out.ts") {
            return { isFile: () => true } as unknown as import("node:fs").Stats;
          }
          throw Object.assign(new Error("nope"), { code: "ENOENT" });
        }) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const orphans = mod.checkOrphanSourceModules(Object.keys(fileBodies));
      const paths = orphans.map((o) => o.path);
      expect(paths).toContain("src/zeta-orphan.ts");
      expect(paths).toContain("src/alpha-orphan.ts");
      // Sorted ascending by path.
      expect(paths.indexOf("src/alpha-orphan.ts")).toBeLessThan(paths.indexOf("src/zeta-orphan.ts"));
      expect(paths).not.toContain("src/cli/main.ts");
      expect(paths).not.toContain("src/types/x.ts");
      expect(paths).not.toContain("src/barrel/index.ts");
      expect(paths).not.toContain("src/thing.spec.ts");
      expect(paths).not.toContain("src/used.ts");
    });

    it("checkFunctionComplexity: flags complex fn, names anon, covers all node kinds", async () => {
      mockUtils("/repo");
      const complexSource = [
        "export function busy(a, b, c) {",
        "  if (a) { return 1; }",
        "  for (let i = 0; i < 1; i++) {}",
        "  for (const k in a) {}",
        "  for (const v of b) {}",
        "  while (a) { break; }",
        "  do {} while (a);",
        "  try {} catch (e) {}",
        "  const t = a ? 1 : 2;",
        "  switch (a) { case 1: break; default: break; }",
        "  const z = a && b || c;",
        "  const n = a ?? b;",
        "  return z;",
        "}",
        "const arrow = () => { if (true) return 1; };",
        "const expr = function () { return 1; };",
      ].join("\n");
      mockFs({
        readFileSync: vi.fn(() => complexSource) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const viol = mod.checkFunctionComplexity(["/repo/src/x.ts"], 3);
      expect(viol.some((v) => v.function_name === "busy")).toBe(true);
      const all = mod.checkFunctionComplexity(["/repo/src/x.ts"], 1);
      expect(all.some((v) => v.function_name.startsWith("<anonymous@"))).toBe(true);
    });

    it("walkFiles: non-directory short-circuits and nested walk collects matches", async () => {
      mockUtils("/repo");
      mockFs({
        statSync: vi.fn((p: string) => ({
          isDirectory: () => String(p) === "/root" || String(p) === "/root/sub",
        })) as never,
        readdirSync: vi.fn((p: string) => {
          if (String(p) === "/root") {
            return [
              { name: "sub", isDirectory: () => true, isFile: () => false },
              { name: "a.ts", isDirectory: () => false, isFile: () => true },
              { name: "skip.md", isDirectory: () => false, isFile: () => true },
            ];
          }
          if (String(p) === "/root/sub") {
            return [{ name: "b.ts", isDirectory: () => false, isFile: () => true }];
          }
          return [];
        }) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const matcher = (p: string) => p.endsWith(".ts");
      const collected = mod.walkFiles("/root", matcher);
      expect(collected).toContain("/root/a.ts");
      expect(collected).toContain("/root/sub/b.ts");
      expect(collected).not.toContain("/root/skip.md");
      expect(mod.walkFiles("/notdir", matcher)).toEqual([]);
    });
  });

  describe("main()", () => {
    async function seedRoots(root: string): Promise<void> {
      // collectTypeScriptFiles() walks src/tests/packages; all three must exist
      // because walkFiles() statSync's the root before checking isDirectory().
      const { mkdir } = await import("node:fs/promises");
      for (const segment of ["src", "tests", "packages"]) {
        await mkdir(`${root}/${segment}`, { recursive: true });
      }
    }

    async function seedFixture(root: string): Promise<void> {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await seedRoots(root);
      const files = {
        "src/cli.ts": 'import "./core/a";\nexport const cli = true;\n',
        "src/core/a.ts": 'import "./b";\nexport function run() { return true; }\n',
        "src/core/b.ts": "export const value = 1;\n",
        "tests/unit/sample.ts": "export const sample = true;\n",
        "packages/pkg/index.ts": "export const pkg = true;\n",
      } as const;
      for (const [relativePath, content] of Object.entries(files)) {
        await mkdir(`${root}/${relativePath.split("/").slice(0, -1).join("/")}`, { recursive: true });
        await writeFile(`${root}/${relativePath}`, content, "utf8");
      }
    }

    it("--help prints usage and returns early", async () => {
      mockUtils("/repo");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--help"];
      mod.main();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Usage:"))).toBe(true);
    });

    it("full JSON scan passes for a clean fixture", async () => {
      const root = await harness.createTempRoot("pm-static-quality-pass-");
      await seedFixture(root);
      mockUtils(root);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = [
        "node",
        "x",
        "--json",
        "--max-lines",
        "500",
        "--max-lines-tests",
        "500",
        "--max-complexity",
        "20",
        "--max-files-per-dir",
        "20",
        "--duplicate-window",
        "5",
        "--max-duplicate-chunks",
        "1",
      ];
      mod.main();
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
        ok: boolean;
        scanned: { file_count: number };
      };
      expect(payload.ok).toBe(true);
      expect(payload.scanned.file_count).toBeGreaterThan(0);
    });

    it("full text scan prints success message when clean", async () => {
      const root = await harness.createTempRoot("pm-static-quality-passtext-");
      await seedFixture(root);
      mockUtils(root);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--max-lines", "500", "--max-lines-tests", "500"];
      mod.main();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Static quality gate passed."))).toBe(true);
    });

    it("full text scan reports every violation category and sets exit code", async () => {
      const root = await harness.createTempRoot("pm-static-quality-fail-");
      await seedFixture(root);
      const { writeFile } = await import("node:fs/promises");
      // A function with a branch so complexity (2) exceeds --max-complexity 1.
      await writeFile(`${root}/src/core/b.ts`, "export function pick(a) {\n  if (a) { return 1; }\n  return 0;\n}\n", "utf8");
      mockUtils(root);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      // Tight thresholds force file_length, directory_load, duplicate_chunks,
      // complexity violations all at once (text branch lines 388-405).
      process.argv = [
        "node",
        "x",
        "--max-lines",
        "1",
        "--max-lines-tests",
        "1",
        "--max-complexity",
        "1",
        "--max-files-per-dir",
        "1",
        "--duplicate-window",
        "5",
        "--max-duplicate-chunks",
        "0",
      ];
      mod.main();
      expect(process.exitCode).toBe(1);
      const emitted = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(emitted.some((line) => line.includes("Static quality gate failed."))).toBe(true);
      expect(emitted.some((line) => line.includes("file_length violations"))).toBe(true);
      expect(emitted.some((line) => line.includes("directory_load violations"))).toBe(true);
      expect(emitted.some((line) => line.includes("complexity violations"))).toBe(true);
    });

    it("reports duplicate_chunks violations in text mode", async () => {
      const root = await harness.createTempRoot("pm-static-quality-dup-");
      await seedRoots(root);
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(`${root}/src/core`, { recursive: true });
      const block = [
        "export const sharedConstantOne = 1;",
        "export const sharedConstantTwo = 2;",
        "export const sharedConstantThree = 3;",
        "export const sharedConstantFour = 4;",
        "export const sharedConstantFive = 5;",
        "export const sharedConstantSix = 6;",
      ].join("\n");
      // Two files in src/core (the duplicate scope) sharing a >=5-line window so a
      // cross-file duplicate is recorded; max-duplicate-chunks 0 makes it a violation.
      await writeFile(`${root}/src/core/one.ts`, `${block}\n`, "utf8");
      await writeFile(`${root}/src/core/two.ts`, `${block}\n`, "utf8");
      mockUtils(root);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = [
        "node",
        "x",
        "--max-lines",
        "500",
        "--max-lines-tests",
        "500",
        "--duplicate-window",
        "5",
        "--max-duplicate-chunks",
        "0",
      ];
      mod.main();
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("duplicate_chunks violations"))).toBe(true);
    });

    it("includes src/cli files in duplicate scope", async () => {
      const root = await harness.createTempRoot("pm-static-quality-dup-cli-");
      await seedRoots(root);
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(`${root}/src/cli`, { recursive: true });
      const block = [
        "export const sharedCliOne = 1;",
        "export const sharedCliTwo = 2;",
        "export const sharedCliThree = 3;",
        "export const sharedCliFour = 4;",
        "export const sharedCliFive = 5;",
        "export const sharedCliSix = 6;",
      ].join("\n");
      await writeFile(`${root}/src/cli/one.ts`, `${block}\n`, "utf8");
      await writeFile(`${root}/src/cli/two.ts`, `${block}\n`, "utf8");
      mockUtils(root);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = [
        "node",
        "x",
        "--max-lines",
        "500",
        "--max-lines-tests",
        "500",
        "--duplicate-window",
        "5",
        "--max-duplicate-chunks",
        "0",
      ];
      mod.main();
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("duplicate_chunks violations"))).toBe(true);
    });

    it("reports orphan_modules violations in text mode", async () => {
      const root = await harness.createTempRoot("pm-static-quality-orphan-");
      await seedRoots(root);
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(`${root}/src`, { recursive: true });
      // A lone unreferenced src module → orphan_modules violation (line 401-402).
      await writeFile(`${root}/src/lonely.ts`, "export const lonely = 1;\n", "utf8");
      mockUtils(root);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--max-lines", "500", "--max-lines-tests", "500"];
      mod.main();
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("orphan_modules violations"))).toBe(true);
    });

    it("rejects a duplicate-window below the minimum", async () => {
      mockUtils("/repo");
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--duplicate-window", "3"];
      expect(() => mod.main()).toThrow("--duplicate-window must be >= 5.");
    });
  });
});
