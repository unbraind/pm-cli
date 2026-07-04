import type { Stats } from "node:fs";
import * as fs from "node:fs";
import * as childProcess from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness(["../../../../scripts/release/utils.mjs"]);

const SCRIPT = "scripts/release/static-quality-gate.mjs";

function normalizeMockPath(value: unknown): string {
  return String(value).replaceAll("\\", "/");
}

type SqModule = {
  walkFiles: (
    dir: string,
    matcher: (p: string) => boolean,
    out?: string[],
    options?: { shouldSkipDirectory?: (p: string) => boolean } | null,
  ) => string[];
  relativeToRepo: (abs: string) => string;
  collectTypeScriptFiles: () => string[];
  checkFileLength: (files: string[], maxSrc: number, maxTest: number) => unknown[];
  checkDirectoryLoad: (files: string[], maxPerDir: number) => unknown[];
  normalizeLine: (line: string) => string;
  checkDuplicateChunks: (files: string[], window: number, maxChunks: number) => unknown[];
  resolveRelativeImport: (fromAbs: string, spec: string) => string | null;
  sourceFilesOnly: (files: string[]) => string[];
  hasModuleDocstring: (sourceText: string) => boolean;
  checkSourceDocstringCoverage: (
    files: string[],
    minCoveragePercent: number,
  ) => {
    ok: boolean;
    total: number;
    documented: number;
    missing: Array<{ path: string; reason: string }>;
    coverage_percent: number;
    min_coverage_percent: number;
  };
  checkExportedDocstringCoverage: (
    files: string[],
    minCoveragePercent: number,
  ) => {
    ok: boolean;
    total: number;
    documented: number;
    missing: Array<{ path: string; line: number; name: string; reason: string }>;
    coverage_percent: number;
    min_coverage_percent: number;
  };
  checkDocstringBoilerplate: (files: string[]) => Array<{ path: string; line: number; reason: string }>;
  documentedSourceFiles: (files: string[]) => string[];
  checkExportedMemberDocstringCoverage: (
    files: string[],
    minCoveragePercent: number,
  ) => {
    ok: boolean;
    total: number;
    documented: number;
    missing: Array<{ path: string; line: number; name: string; reason: string }>;
    coverage_percent: number;
    min_coverage_percent: number;
  };
  extractDocstringProse: (comment: string) => string;
  identifierWords: (name: string) => string[];
  isTrivialDocstring: (comment: string, symbolName: string) => boolean;
  checkTrivialDocstrings: (files: string[]) => Array<{ path: string; line: number; name: string; reason: string }>;
  checkOrphanSourceModules: (files: string[]) => Array<{ path: string }>;
  complexityContribution: (node: unknown) => number;
  functionLikeName: (node: unknown, sf: unknown) => string;
  checkFunctionComplexity: (files: string[], max: number) => Array<{ function_name: string; complexity: number }>;
  collectCodeFactorParityFiles: (
    changedPaths?: { ok: true; files: string[] } | { ok: false; files: string[]; error: string },
  ) => { ok: true; files: string[] } | { ok: false; files: string[]; error: string };
  checkCodeFactorComplexity: (
    max: number,
    changedPaths?: { ok: true; files: string[] } | { ok: false; files: string[]; error: string },
  ) => {
    ok: boolean;
    scanned_file_count: number;
    max_complexity: number;
    violations: Array<{ path: string; function_name: string; complexity: number; max_complexity: number }>;
    error?: string;
  };
  usage: () => void;
  parseNumberFlag: (flags: Map<string, unknown>, key: string, fallback: number) => number;
  countEslintSuppressions: (suppressionsPath: string) => number;
  checkEslintSuppressionsBudget: (maxSuppressions: number) => {
    ok: boolean;
    total: number | null;
    max_suppressions: number;
    error?: string;
  };
  MAX_ESLINT_SUPPRESSIONS: number;
  collectPragmaScanFiles: () => string[];
  readPragmaScanTexts: (files: string[]) => Array<{ path: string; text: string }>;
  countPragmaMatchesInTexts: (scanTexts: Array<{ path: string; text: string }>, pattern: RegExp) => number;
  checkInlinePragmaBudgets: (
    budgets?: {
      maxInlineEslintDisables?: number;
      maxBroadEslintDisables?: number;
      maxCoverageIgnorePragmas?: number;
      maxJscpdIgnorePragmas?: number;
    } | null,
    files?: string[],
  ) => {
    ok: boolean;
    scanned_file_count: number;
    error?: string;
    budgets: Record<string, { ok: boolean; total: number | null; max: number; error?: string }>;
  };
  MAX_INLINE_ESLINT_DISABLES: number;
  MAX_BROAD_ESLINT_DISABLES: number;
  MAX_COVERAGE_IGNORE_PRAGMAS: number;
  MAX_JSCPD_IGNORE_PRAGMAS: number;
  main: () => void;
};

// Pragma fixtures are assembled from fragments so this spec file itself never
// counts against the repo-wide inline-pragma budgets the gate enforces.
const ESLINT_DISABLE_PRAGMA = "// eslint-" + "disable-next-line complexity";
const ESLINT_BROAD_DISABLE_PRAGMA = "/* eslint-" + "disable no-console */";
const COVERAGE_IGNORE_PRAGMA = "/* v8 " + "ignore next */";
const JSCPD_IGNORE_PRAGMA = "// jscpd:" + "ignore-start";
const JSCPD_IGNORE_END_PRAGMA = "// jscpd:" + "ignore-end";

function mockUtils(repoRoot: string): void {
  vi.doMock("../../../../scripts/release/utils.mjs", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("../../../../scripts/release/utils.mjs");
    return {
      ...actual,
      repoRoot,
      fail(message: string, exitCode = 1) {
        throw new Error(`FAIL:${exitCode}:${message}`);
      },
    };
  });
}

function mockFs(impl: Partial<typeof fs>): void {
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs");
    return { ...actual, ...impl };
  });
}

function mockChildProcess(impl: Partial<typeof childProcess>): void {
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof childProcess>("node:child_process");
    return { ...actual, ...impl };
  });
}

describe("static-quality-gate", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

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
      harness.mockPosixPath();
      mockFs({
        statSync: vi.fn((p: string) => {
          if (String(p) === "/repo/src/dep.ts") return { isFile: () => true } as unknown as Stats;
          throw Object.assign(new Error("nope"), { code: "ENOENT" });
        }) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      expect(mod.resolveRelativeImport("/repo/src/main.ts", "node:path")).toBeNull();
      expect(mod.resolveRelativeImport("/repo/src/main.ts", "./dep")).toBe("/repo/src/dep.ts");
      expect(mod.resolveRelativeImport("/repo/src/main.ts", "./gone")).toBeNull();
    });

    it("checkSourceDocstringCoverage requires module TSDoc after optional shebang", async () => {
      mockUtils("/repo");
      const fileBodies: Record<string, string> = {
        "/repo/src/cli.ts": "#!/usr/bin/env node\n/** CLI entrypoint. */\nexport {};",
        "/repo/src/missing.ts": "export const missing = true;",
        "/repo/src/also-missing.ts": "export const alsoMissing = true;",
        "/repo/tests/sample.ts": "export const testOnly = true;",
      };
      mockFs({
        readFileSync: vi.fn((p: string) => fileBodies[String(p)] ?? "") as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      expect(mod.hasModuleDocstring("/** documented */\nexport {};")).toBe(true);
      expect(mod.hasModuleDocstring("#!/usr/bin/env node\n/** documented */\nexport {};")).toBe(true);
      expect(mod.hasModuleDocstring("#!/usr/bin/env node")).toBe(false);
      expect(mod.hasModuleDocstring("// not a docstring\nexport {};")).toBe(false);

      const report = mod.checkSourceDocstringCoverage(Object.keys(fileBodies), 100);
      expect(report.ok).toBe(false);
      expect(report.total).toBe(3);
      expect(report.documented).toBe(1);
      expect(report.coverage_percent).toBe(33.33);
      expect(report.missing).toEqual([
        { path: "src/also-missing.ts", reason: "missing_module_docstring" },
        { path: "src/missing.ts", reason: "missing_module_docstring" },
      ]);

      expect(mod.checkSourceDocstringCoverage(["/repo/tests/sample.ts"], 100)).toMatchObject({
        ok: true,
        total: 0,
        coverage_percent: 100,
      });
    });

    it("checkExportedDocstringCoverage requires TSDoc on exported declarations", async () => {
      mockUtils("/repo");
      const fileBodies: Record<string, string> = {
        "/repo/src/a.ts": [
          "/**",
          " * @module a",
          " *",
          " * Module docs.",
          " */",
          "/** Runs the documented API. */",
          "export function documented() { return true; }",
          "export function missing() { return false; }",
          "export function alsoMissing() { return false; }",
          "export default function () { return false; }",
          "export const missingArrow = () => false;",
          "/** Describes exported options. */",
          "export interface Options { ok: boolean; }",
          "function internal() { return true; }",
        ].join("\n"),
      };
      mockFs({
        readFileSync: vi.fn((p: string) => fileBodies[String(p)] ?? "") as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const report = mod.checkExportedDocstringCoverage(Object.keys(fileBodies), 100);
      expect(report.ok).toBe(false);
      expect(report.total).toBe(6);
      expect(report.documented).toBe(2);
      expect(report.coverage_percent).toBe(33.33);
      expect(report.missing).toEqual([
        { path: "src/a.ts", line: 8, name: "missing", reason: "missing_exported_docstring" },
        { path: "src/a.ts", line: 9, name: "alsoMissing", reason: "missing_exported_docstring" },
        { path: "src/a.ts", line: 10, name: "exported_declaration", reason: "missing_exported_docstring" },
        { path: "src/a.ts", line: 11, name: "missingArrow", reason: "missing_exported_docstring" },
      ]);
      // No exported declarations in scope → 100% by definition.
      expect(mod.checkExportedDocstringCoverage([], 100)).toMatchObject({
        total: 0,
        coverage_percent: 100,
        ok: true,
      });
    });

    it("checkExportedDocstringCoverage does not reuse the module docstring for the first export", async () => {
      mockUtils("/repo");
      const fileBodies: Record<string, string> = {
        "/repo/src/a.ts": [
          "/** Plain module documentation without an @module tag. */",
          "export function missingOwnDocstring() { return true; }",
          "/** Runs the documented API. */",
          "export const documentedArrow = () => true;",
        ].join("\n"),
      };
      mockFs({
        readFileSync: vi.fn((p: string) => fileBodies[String(p)] ?? "") as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const report = mod.checkExportedDocstringCoverage(Object.keys(fileBodies), 100);
      expect(report.ok).toBe(false);
      expect(report.total).toBe(2);
      expect(report.documented).toBe(1);
      expect(report.missing).toEqual([
        { path: "src/a.ts", line: 2, name: "missingOwnDocstring", reason: "missing_exported_docstring" },
      ]);
    });

    it("checkDocstringBoilerplate flags generated low-signal summaries", async () => {
      mockUtils("/repo");
      const fileBodies: Record<string, string> = {
        "/repo/src/a.ts": [
          "/**",
          " * Provides the exported run thing operation used by the pm CLI runtime and integration tests.",
          " */",
          "/* regular multiline comments are ignored by the boilerplate matcher */",
          "// plain leading comments are ignored by the boilerplate matcher",
          "export function runThing() { return true; }",
          "/**",
          " * Describes the exported OtherThing data contract used across command and SDK boundaries.",
          " */",
          "export interface OtherThing { ok: boolean; }",
        ].join("\n"),
        "/repo/src/b.ts": [
          "/**",
          " * Defines the exported Shape type contract used to keep command and SDK surfaces type-safe.",
          " */",
          "export interface Shape { ok: boolean; }",
        ].join("\n"),
      };
      mockFs({
        readFileSync: vi.fn((p: string) => fileBodies[String(p)] ?? "") as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      expect(mod.checkDocstringBoilerplate(Object.keys(fileBodies))).toEqual([
        { path: "src/a.ts", line: 1, reason: "boilerplate_docstring" },
        { path: "src/a.ts", line: 7, reason: "boilerplate_docstring" },
        { path: "src/b.ts", line: 1, reason: "boilerplate_docstring" },
      ]);
    });

    it("documentedSourceFiles: keeps src+packages non-spec files, drops tests/specs/others", async () => {
      mockUtils("/repo");
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const kept = mod
        .documentedSourceFiles([
          "/repo/src/a.ts",
          "/repo/packages/pkg/index.ts",
          "/repo/src/b.spec.ts",
          String.raw`/repo/src\windows.tsx`,
          String.raw`/repo/packages\pkg\component.test.tsx`,
          String.raw`/repo/packages\pkg\module.spec.cts`,
          "/repo/packages/pkg/c.test.ts",
          "/repo/tests/unit/d.ts",
          "/repo/scripts/e.ts",
        ])
        .map((p) => mod.relativeToRepo(p).replace(/\\/g, "/"));
      expect(kept).toEqual(["src/a.ts", "packages/pkg/index.ts", "src/windows.tsx"]);
    });

    it("extractDocstringProse + identifierWords normalize comments and identifiers", async () => {
      mockUtils("/repo");
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      expect(mod.extractDocstringProse("/** Single line. */")).toBe("Single line.");
      expect(mod.extractDocstringProse(["/**", " * Multi line", " * @remarks detail here", " */"].join("\n"))).toBe(
        "Multi line detail here",
      );
      expect(mod.extractDocstringProse("/** See {@link Foo} now. */")).toBe("See Foo now.");
      expect(mod.identifierWords("itemFrontMatter")).toEqual(["item", "front", "matter"]);
      expect(mod.identifierWords("Owner.snake_case")).toEqual(["owner", "snake", "case"]);
      expect(mod.identifierWords("")).toEqual([]);
      expect(mod.identifierWords(undefined as unknown as string)).toEqual([]);
    });

    it("isTrivialDocstring: empty/name-only trivial, informative prose not", async () => {
      mockUtils("/repo");
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      expect(mod.isTrivialDocstring("/** */", "foo")).toBe(true);
      expect(mod.isTrivialDocstring("/** The item id. */", "itemId")).toBe(true);
      expect(mod.isTrivialDocstring("/** Unique primary key. */", "id")).toBe(false);
    });

    it("checkExportedMemberDocstringCoverage: interface + type-literal members, skips index sigs and non-owners", async () => {
      mockUtils("/repo");
      const membersFixture = [
        "/** @module members */",
        "/** Documented widget. */",
        "export interface Widget {",
        "  /** The documented id. */",
        "  id: string;",
        "  name: string;",
        '  "weird-key": number;',
        "  [key: string]: unknown;",
        "}",
        "interface Hidden {",
        "  secret: string;",
        "}",
        "/** Documented shape. */",
        "export type Shape = {",
        "  /** Documented width. */",
        "  width: number;",
        "  height: number;",
        "};",
        "/** Plain alias. */",
        "export type Id = string;",
        "/** Documented make. */",
        "export function make() { return 0; }",
      ].join("\n");
      mockFs({
        readFileSync: vi.fn((p: string) => (String(p).endsWith("members.ts") ? membersFixture : "")) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const report = mod.checkExportedMemberDocstringCoverage(["/repo/src/members.ts"], 100);
      expect(report.total).toBe(5);
      expect(report.documented).toBe(2);
      expect(report.ok).toBe(false);
      expect(report.missing.map((m) => m.line).sort((a, b) => a - b)).toEqual([6, 7, 17]);
      expect(report.missing.every((m) => m.reason === "missing_member_docstring")).toBe(true);
      expect(report.missing.some((m) => m.name.includes("weird-key"))).toBe(true);
      // Same fixture passes when the minimum is relaxed to 0.
      expect(mod.checkExportedMemberDocstringCoverage(["/repo/src/members.ts"], 0).ok).toBe(true);
      // No documentable owners → 100% by definition.
      expect(mod.checkExportedMemberDocstringCoverage([], 100)).toMatchObject({
        total: 0,
        coverage_percent: 100,
        ok: true,
      });
    });

    it("checkExportedMemberDocstringCoverage: class members, accessors, private/static skips, anon owner", async () => {
      mockUtils("/repo");
      const klassFixture = [
        "/** @module klass */",
        "/** Documented rich. */",
        "export class Rich {",
        "  /** Documented ctor. */",
        "  constructor(input) {}",
        "  /** Documented value. */",
        '  value = "";',
        "  undocProp = 1;",
        "  /** Documented run. */",
        "  run() {}",
        "  undocMethod() {}",
        "  /** Documented size getter. */",
        "  get size() { return 0; }",
        "  set size(v) {}",
        "  static config = 1;",
        "  private secret() {}",
        "  protected helper() {}",
        "  #hidden() {}",
        "  [key: string]: unknown;",
        "}",
        "/** Documented empty. */",
        "export class Empty {",
        "  constructor() {}",
        "  /** Documented flag. */",
        "  flag = true;",
        "}",
      ].join("\n");
      const anonFixture = [
        "/** @module anon */",
        "/** Documented default class. */",
        "export default class {",
        "  /** Documented ping. */",
        "  ping() {}",
        "  pong() {}",
        "}",
      ].join("\n");
      mockFs({
        readFileSync: vi.fn((p: string) =>
          String(p).endsWith("klass.ts") ? klassFixture : String(p).endsWith("anon.ts") ? anonFixture : "",
        ) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const report = mod.checkExportedMemberDocstringCoverage(["/repo/src/klass.ts", "/repo/src/anon.ts"], 100);
      expect(report.total).toBe(11);
      expect(report.documented).toBe(6);
      const klassMissing = report.missing
        .filter((m) => m.path === "src/klass.ts")
        .map((m) => m.line)
        .sort((a, b) => a - b);
      expect(klassMissing).toEqual([8, 11, 14, 15]);
      const anonMissing = report.missing.find((m) => m.path === "src/anon.ts");
      expect(anonMissing?.name).toBe("exported_declaration.pong");
    });

    it("checkTrivialDocstrings: flags name-only stubs on declarations and members", async () => {
      mockUtils("/repo");
      const triviaFixture = [
        "/** @module trivia */",
        "/** id */",
        "export const id = 1;",
        "/** Computes the widget layout precisely. */",
        "export function layout() {}",
        "/** Documented widget. */",
        "export interface Widget {",
        "  /** The name. */",
        "  name: string;",
        "  /** Canonical unique storage key. */",
        "  key: string;",
        "  undoc: string;",
        "}",
        "const internalConst = 2;",
        "/** Documented service. */",
        "export class Service {",
        "  /** Builds the service from a name. */",
        "  constructor(name) {}",
        "  /** Runs the service loop. */",
        "  go() {}",
        "}",
      ].join("\n");
      mockFs({
        readFileSync: vi.fn((p: string) => (String(p).endsWith("trivia.ts") ? triviaFixture : "")) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const violations = mod.checkTrivialDocstrings(["/repo/src/trivia.ts"]);
      expect(violations.map((v) => v.line)).toEqual([3, 9]);
      expect(violations.find((v) => v.line === 3)?.name).toBe("id");
      expect(violations.find((v) => v.line === 9)?.name).toBe("Widget.name");
      expect(violations.every((v) => v.reason === "trivial_docstring")).toBe(true);
    });

    it("checkOrphanSourceModules: flags multiple orphans (sort), honors allowlist + skip + out-of-set import", async () => {
      mockUtils("/repo");
      harness.mockPosixPath();
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
            return { isFile: () => true } as unknown as Stats;
          }
          // The external import target resolves to a real file but is outside the set.
          if (String(p) === "/repo/external/out.ts") {
            return { isFile: () => true } as unknown as Stats;
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

    it("checkCodeFactorComplexity enforces changed shipped/script files only", async () => {
      mockUtils("/repo");
      const complexSource = [
        "export function changed(a, b) {",
        "  if (a) return 1;",
        "  if (b) return 2;",
        "  return 0;",
        "}",
      ].join("\n");
      mockFs({
        existsSync: vi.fn((p: string) => String(p).endsWith("changed.ts") || String(p).endsWith("tool.mjs")) as never,
        statSync: vi.fn(() => ({ isFile: () => true, isDirectory: () => false }) as unknown as Stats) as never,
        readFileSync: vi.fn((p: string) => (String(p).endsWith("changed.ts") ? complexSource : "export const ok = true;\n")) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const changedPaths = {
        ok: true as const,
        files: [
          "src/changed.ts",
          "scripts/tool.mjs",
          "tests/unit/changed.spec.ts",
          "docs/readme.md",
          "src/types/example.d.ts",
        ],
      };

      const parityFiles = mod.collectCodeFactorParityFiles(changedPaths);
      expect(parityFiles.ok).toBe(true);
      if (parityFiles.ok) {
        expect(parityFiles.files.map((filePath) => normalizeMockPath(filePath).replace("/repo/", "")).sort()).toEqual([
          "scripts/tool.mjs",
          "src/changed.ts",
        ]);
      }

      const report = mod.checkCodeFactorComplexity(2, changedPaths);
      expect(report.ok).toBe(false);
      expect(report.scanned_file_count).toBe(2);
      expect(report.violations).toEqual([
        expect.objectContaining({
          path: "src/changed.ts",
          function_name: "changed",
          complexity: 3,
          max_complexity: 2,
        }),
      ]);
    });

    it("checkCodeFactorComplexity reports git inspection failures", async () => {
      mockUtils("/repo");
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const report = mod.checkCodeFactorComplexity(16, {
        ok: false,
        files: [],
        error: "git unavailable",
      });
      expect(report).toMatchObject({
        ok: false,
        scanned_file_count: 0,
        max_complexity: 16,
        error: "git unavailable",
      });
    });

    it("checkCodeFactorComplexity reports default git scan failures after missing base refs", async () => {
      mockUtils("/repo");
      mockFs({
        existsSync: vi.fn((p: string) => normalizeMockPath(p) === "/repo/.git") as never,
      });
      mockChildProcess({
        execFileSync: vi.fn((cmd: string, args: string[]) => {
          expect(cmd).toBe("git");
          if (args[0] === "merge-base") {
            throw new Error("missing base");
          }
          throw new Error("diff unavailable");
        }) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const report = mod.checkCodeFactorComplexity(16);
      expect(report).toMatchObject({
        ok: false,
        scanned_file_count: 0,
        error: "Unable to inspect git changed files for CodeFactor parity.",
      });
    });

    it("checkCodeFactorComplexity falls back to worktree diffs when base refs are empty", async () => {
      mockUtils("/repo");
      mockFs({
        existsSync: vi.fn(
          (p: string) => normalizeMockPath(p) === "/repo/.git" || normalizeMockPath(p) === "/repo/src/changed.ts",
        ) as never,
        statSync: vi.fn((p: string) => {
          if (normalizeMockPath(p) === "/repo/src/changed.ts") {
            return { isFile: () => true, isDirectory: () => false } as unknown as Stats;
          }
          return { isFile: () => false, isDirectory: () => true } as unknown as Stats;
        }) as never,
        readFileSync: vi.fn(() => "export function changed(a) {\n  if (a) return 1;\n  return 0;\n}\n") as never,
      });
      mockChildProcess({
        execFileSync: vi.fn((cmd: string, args: string[]) => {
          expect(cmd).toBe("git");
          const joined = args.join(" ");
          if (joined === "merge-base HEAD origin/main" || joined === "merge-base HEAD main") {
            return "\n";
          }
          if (joined === "diff --name-only --diff-filter=ACMR") {
            return "src/changed.ts\n";
          }
          return "";
        }) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const report = mod.checkCodeFactorComplexity(1);
      expect(report.violations[0]).toMatchObject({ path: "src/changed.ts", complexity: 2 });
    });

    it("checkCodeFactorComplexity inspects git diff, staged, and unstaged paths in a checkout", async () => {
      mockUtils("/repo");
      mockFs({
        existsSync: vi.fn(
          (p: string) => normalizeMockPath(p) === "/repo/.git" || normalizeMockPath(p) === "/repo/src/changed.ts",
        ) as never,
        statSync: vi.fn((p: string) => {
          if (normalizeMockPath(p) === "/repo/src/changed.ts") {
            return { isFile: () => true, isDirectory: () => false } as unknown as Stats;
          }
          return { isFile: () => false, isDirectory: () => true } as unknown as Stats;
        }) as never,
        readFileSync: vi.fn(() => "export function changed(a) {\n  if (a) return 1;\n  return 0;\n}\n") as never,
      });
      mockChildProcess({
        execFileSync: vi.fn((cmd: string, args: string[]) => {
          expect(cmd).toBe("git");
          const joined = args.join(" ");
          if (joined === "merge-base HEAD origin/main") {
            throw new Error("missing origin");
          }
          if (joined === "merge-base HEAD main") {
            return "base-sha\n";
          }
          if (joined === "diff --name-only --diff-filter=ACMR base-sha...HEAD") {
            return "src/changed.ts\n";
          }
          if (joined === "diff --name-only --diff-filter=ACMR") {
            return "src/changed.ts\n";
          }
          if (joined === "diff --cached --name-only --diff-filter=ACMR") {
            return "tests/unit/ignored.spec.ts\n";
          }
          return "";
        }) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const report = mod.checkCodeFactorComplexity(1);
      expect(report.scanned_file_count).toBe(1);
      expect(report.violations[0]).toMatchObject({ path: "src/changed.ts", complexity: 2 });
    });

    it("countEslintSuppressions: rejects unreadable or malformed files and sums valid counts", async () => {
      const root = await harness.createTempRoot("pm-static-quality-suppressions-");
      mockUtils(root);
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      expect(() => mod.countEslintSuppressions(`${root}/eslint-suppressions.json`)).toThrow(
        /Unable to read ESLint suppressions budget file/,
      );
      await writeFile(`${root}/eslint-suppressions.json`, "{", "utf8");
      expect(() => mod.countEslintSuppressions(`${root}/eslint-suppressions.json`)).toThrow(
        /Invalid ESLint suppressions budget file/,
      );
      await writeFile(`${root}/eslint-suppressions.json`, "[]", "utf8");
      expect(() => mod.countEslintSuppressions(`${root}/eslint-suppressions.json`)).toThrow(/expected an object/);
      await writeFile(`${root}/eslint-suppressions.json`, JSON.stringify({ "src/a.ts": null }), "utf8");
      expect(() => mod.countEslintSuppressions(`${root}/eslint-suppressions.json`)).toThrow(/expected rule objects/);
      await writeFile(`${root}/eslint-suppressions.json`, JSON.stringify({ "src/a.ts": { complexity: {} } }), "utf8");
      expect(() => mod.countEslintSuppressions(`${root}/eslint-suppressions.json`)).toThrow(
        /expected non-negative integer counts/,
      );
      await writeFile(
        `${root}/eslint-suppressions.json`,
        JSON.stringify({ "src/a.ts": { complexity: { count: 1.5 } } }),
        "utf8",
      );
      expect(() => mod.countEslintSuppressions(`${root}/eslint-suppressions.json`)).toThrow(/expected non-negative integer counts/);
      await writeFile(
        `${root}/eslint-suppressions.json`,
        JSON.stringify({
          "src/a.ts": { complexity: { count: 2 }, "no-useless-assignment": { count: 1 } },
          "src/b.ts": { complexity: { count: 3 } },
        }),
        "utf8",
      );
      expect(mod.countEslintSuppressions(`${root}/eslint-suppressions.json`)).toBe(6);
    });

    it("countEslintSuppressions: normalizes non-Error read failures", async () => {
      mockUtils("/repo");
      mockFs({
        readFileSync: vi.fn(() => {
          throw "read-failed";
        }) as never,
      });
      const readFailureMod = await harness.importModuleStable<SqModule>(SCRIPT);
      expect(() => readFailureMod.countEslintSuppressions("/repo/eslint-suppressions.json")).toThrow(/read-failed/);
    });

    it("countEslintSuppressions: normalizes non-Error parse failures", async () => {
      const root = await harness.createTempRoot("pm-static-quality-non-error-parse-");
      await writeFile(`${root}/eslint-suppressions.json`, "{}", "utf8");
      mockUtils(root);
      const parseFailureMod = await harness.importModuleStable<SqModule>(SCRIPT);
      vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
        throw "parse-failed";
      });
      expect(() => parseFailureMod.countEslintSuppressions(`${root}/eslint-suppressions.json`)).toThrow(/parse-failed/);
    });

    it("checkEslintSuppressionsBudget: within and over budget", async () => {
      const root = await harness.createTempRoot("pm-static-quality-budget-");
      mockUtils(root);
      expect((await harness.importModuleStable<SqModule>(SCRIPT)).checkEslintSuppressionsBudget(1)).toMatchObject({
        ok: false,
        total: null,
        max_suppressions: 1,
        error: expect.stringContaining("Unable to read ESLint suppressions budget file"),
      });
      await writeFile(
        `${root}/eslint-suppressions.json`,
        JSON.stringify({ "src/a.ts": { complexity: { count: 2 } } }),
        "utf8",
      );
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const actualSuppressionCount = mod.countEslintSuppressions(`${root}/eslint-suppressions.json`);
      expect(mod.MAX_ESLINT_SUPPRESSIONS).toBeGreaterThanOrEqual(actualSuppressionCount);
      expect(mod.checkEslintSuppressionsBudget(2)).toEqual({ ok: true, total: 2, max_suppressions: 2 });
      expect(mod.checkEslintSuppressionsBudget(1)).toEqual({ ok: false, total: 2, max_suppressions: 1 });
    });

    it("checkEslintSuppressionsBudget: reports non-Error infrastructure failures", async () => {
      mockUtils("/repo");
      vi.doMock("node:path", () => {
        const pathWithThrowingJoin = {
          ...nodePath,
          join() {
            throw "path-join-failed";
          },
        };
        return {
          ...nodePath,
          default: pathWithThrowingJoin,
          join: pathWithThrowingJoin.join,
        };
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      expect(mod.checkEslintSuppressionsBudget(1)).toEqual({
        ok: false,
        total: null,
        max_suppressions: 1,
        error: "path-join-failed",
      });
    });

    it("collectPragmaScanFiles: scans lintable files, skips d.ts/node_modules/missing roots", async () => {
      const root = await harness.createTempRoot("pm-static-quality-pragma-scan-");
      await mkdir(`${root}/src`, { recursive: true });
      await mkdir(`${root}/scripts`, { recursive: true });
      await mkdir(`${root}/plugins/node_modules`, { recursive: true });
      await writeFile(`${root}/src/a.ts`, "export const a = 1;\n", "utf8");
      await writeFile(`${root}/src/a.d.ts`, "export declare const a: number;\n", "utf8");
      await writeFile(`${root}/src/readme.md`, "not code\n", "utf8");
      await writeFile(`${root}/scripts/b.mjs`, "export const b = 2;\n", "utf8");
      await writeFile(`${root}/scripts/c.cjs`, "module.exports = 3;\n", "utf8");
      await writeFile(`${root}/plugins/c.js`, "module.exports = 3;\n", "utf8");
      await writeFile(`${root}/plugins/node_modules/dep.js`, "module.exports = 4;\n", "utf8");
      mockUtils(root);
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const relative = mod.collectPragmaScanFiles().map((p) => p.slice(root.length + 1).replaceAll("\\", "/"));
      expect(relative).toEqual(["plugins/c.js", "scripts/b.mjs", "scripts/c.cjs", "src/a.ts"]);
    });

    it("collectTypeScriptFiles: skips package node_modules trees", async () => {
      const root = await harness.createTempRoot("pm-static-quality-ts-scan-");
      await mkdir(`${root}/src`, { recursive: true });
      await mkdir(`${root}/tests`, { recursive: true });
      await mkdir(`${root}/packages/pkg/src`, { recursive: true });
      await mkdir(`${root}/packages/pkg/node_modules/dep`, { recursive: true });
      await writeFile(`${root}/src/a.ts`, "export const a = 1;\n", "utf8");
      await writeFile(`${root}/src/a.d.ts`, "export declare const a: number;\n", "utf8");
      await writeFile(`${root}/tests/sample.ts`, "export const sample = true;\n", "utf8");
      await writeFile(`${root}/packages/pkg/src/index.ts`, "export const pkg = true;\n", "utf8");
      await writeFile(`${root}/packages/pkg/node_modules/dep/index.ts`, "export const dep = true;\n", "utf8");
      mockUtils(root);
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const relative = mod.collectTypeScriptFiles().map((p) => p.slice(root.length + 1).replaceAll("\\", "/"));
      expect(relative).toEqual(["packages/pkg/src/index.ts", "src/a.ts", "tests/sample.ts"]);
    });

    it("collectTypeScriptFiles: skips missing scan roots", async () => {
      const root = await harness.createTempRoot("pm-static-quality-ts-missing-roots-");
      await mkdir(`${root}/src`, { recursive: true });
      await writeFile(`${root}/src/a.ts`, "export const a = 1;\n", "utf8");
      mockUtils(root);
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const relative = mod.collectTypeScriptFiles().map((p) => p.slice(root.length + 1).replaceAll("\\", "/"));
      expect(relative).toEqual(["src/a.ts"]);
    });

    it("readPragmaScanTexts + checkInlinePragmaBudgets: totals, budgets, and defaults", async () => {
      const root = await harness.createTempRoot("pm-static-quality-pragma-budget-");
      await mkdir(`${root}/src`, { recursive: true });
      await writeFile(
        `${root}/src/pragmas.ts`,
        [
          ESLINT_DISABLE_PRAGMA,
          "export const a = 1;",
          ESLINT_BROAD_DISABLE_PRAGMA,
          "export const broad = 2;",
          COVERAGE_IGNORE_PRAGMA,
          "export const b = 3;",
          JSCPD_IGNORE_PRAGMA,
          "export const c = 4;",
          JSCPD_IGNORE_END_PRAGMA,
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(`${root}/src/clean.ts`, "export const clean = true;\n", "utf8");
      mockUtils(root);
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);

      const files = [`${root}/src/pragmas.ts`, `${root}/src/clean.ts`];
      const scanTexts = mod.readPragmaScanTexts(files);
      expect(
        mod.countPragmaMatchesInTexts(scanTexts, new RegExp("eslint-" + "disable-(?:next-line|line)\\b", "g")),
      ).toBe(1);
      expect(
        mod.countPragmaMatchesInTexts(
          [{ path: `${root}/src/repeated.ts`, text: [ESLINT_DISABLE_PRAGMA, ESLINT_DISABLE_PRAGMA].join("\n") }],
          new RegExp("eslint-" + "disable-(?:next-line|line)\\b"),
        ),
      ).toBe(2);
      expect(
        mod.countPragmaMatchesInTexts(scanTexts, new RegExp("eslint-" + "disable\\b(?!-(?:next-line|line)\\b)", "g")),
      ).toBe(1);
      expect(mod.countPragmaMatchesInTexts(scanTexts, new RegExp("never-matches-anything", "g"))).toBe(0);

      const withinBudget = mod.checkInlinePragmaBudgets(
        {
          maxInlineEslintDisables: 1,
          maxBroadEslintDisables: 1,
          maxCoverageIgnorePragmas: 1,
          maxJscpdIgnorePragmas: 1,
        },
        files,
      );
      expect(withinBudget.ok).toBe(true);
      expect(withinBudget.scanned_file_count).toBe(2);
      expect(withinBudget.budgets.inline_eslint_disables).toEqual({ ok: true, total: 1, max: 1 });
      expect(withinBudget.budgets.broad_eslint_disables).toEqual({ ok: true, total: 1, max: 1 });
      expect(withinBudget.budgets.coverage_ignore_pragmas).toEqual({ ok: true, total: 1, max: 1 });
      expect(withinBudget.budgets.jscpd_ignore_pragmas).toEqual({ ok: true, total: 1, max: 1 });

      // Default files argument scans the (mocked) repo root itself.
      const overBudget = mod.checkInlinePragmaBudgets({
        maxInlineEslintDisables: 0,
        maxBroadEslintDisables: 0,
        maxCoverageIgnorePragmas: 0,
        maxJscpdIgnorePragmas: 0,
      });
      expect(overBudget.ok).toBe(false);
      expect(overBudget.budgets.inline_eslint_disables).toEqual({ ok: false, total: 1, max: 0 });
      expect(overBudget.budgets.broad_eslint_disables).toEqual({ ok: false, total: 1, max: 0 });

      const defaultBroadBudget = mod.checkInlinePragmaBudgets(
        { maxInlineEslintDisables: 1, maxCoverageIgnorePragmas: 1, maxJscpdIgnorePragmas: 1 },
        files,
      );
      expect(defaultBroadBudget.budgets.broad_eslint_disables).toEqual({ ok: false, total: 1, max: 0 });

      const allDefaultBudgets = mod.checkInlinePragmaBudgets({}, files);
      expect(allDefaultBudgets.budgets.inline_eslint_disables.max).toBe(mod.MAX_INLINE_ESLINT_DISABLES);
      expect(allDefaultBudgets.budgets.broad_eslint_disables.max).toBe(mod.MAX_BROAD_ESLINT_DISABLES);
      expect(allDefaultBudgets.budgets.coverage_ignore_pragmas.max).toBe(mod.MAX_COVERAGE_IGNORE_PRAGMAS);
      expect(allDefaultBudgets.budgets.jscpd_ignore_pragmas.max).toBe(mod.MAX_JSCPD_IGNORE_PRAGMAS);

      const omittedBudgets = mod.checkInlinePragmaBudgets();
      expect(omittedBudgets.scanned_file_count).toBe(2);
      expect(omittedBudgets.budgets.inline_eslint_disables.max).toBe(mod.MAX_INLINE_ESLINT_DISABLES);
      expect(omittedBudgets.budgets.broad_eslint_disables.max).toBe(mod.MAX_BROAD_ESLINT_DISABLES);

      const nullBudgets = mod.checkInlinePragmaBudgets(null, files);
      expect(nullBudgets.budgets.inline_eslint_disables.max).toBe(mod.MAX_INLINE_ESLINT_DISABLES);
      expect(nullBudgets.budgets.broad_eslint_disables.max).toBe(mod.MAX_BROAD_ESLINT_DISABLES);

      expect(mod.MAX_INLINE_ESLINT_DISABLES).toBeGreaterThanOrEqual(0);
      expect(mod.MAX_BROAD_ESLINT_DISABLES).toBe(0);
      expect(mod.MAX_COVERAGE_IGNORE_PRAGMAS).toBeGreaterThanOrEqual(0);
      expect(mod.MAX_JSCPD_IGNORE_PRAGMAS).toBe(0);
    });

    it("checkInlinePragmaBudgets reads scan files once and reuses cached text", async () => {
      mockUtils("/repo");
      const readFileSync = vi.fn((p: string) => {
        if (String(p).endsWith("a.ts")) {
          return [ESLINT_DISABLE_PRAGMA, COVERAGE_IGNORE_PRAGMA, "export const a = 1;"].join("\n");
        }
        if (String(p).endsWith("b.ts")) {
          return [ESLINT_BROAD_DISABLE_PRAGMA, JSCPD_IGNORE_PRAGMA, "export const b = 1;"].join("\n");
        }
        return "";
      });
      mockFs({ readFileSync: readFileSync as never });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const files = ["/repo/src/a.ts", "/repo/src/b.ts"];
      const scanTexts = mod.readPragmaScanTexts(files);
      expect(mod.countPragmaMatchesInTexts(scanTexts, new RegExp("eslint-" + "disable-(?:next-line|line)\\b", "g"))).toBe(
        1,
      );

      const report = mod.checkInlinePragmaBudgets(
        {
          maxInlineEslintDisables: 1,
          maxBroadEslintDisables: 1,
          maxCoverageIgnorePragmas: 1,
          maxJscpdIgnorePragmas: 1,
        },
        files,
      );
      expect(report.ok).toBe(true);
      expect(report.budgets.inline_eslint_disables).toEqual({ ok: true, total: 1, max: 1 });
      expect(report.budgets.broad_eslint_disables).toEqual({ ok: true, total: 1, max: 1 });
      expect(report.budgets.coverage_ignore_pragmas).toEqual({ ok: true, total: 1, max: 1 });
      expect(report.budgets.jscpd_ignore_pragmas).toEqual({ ok: true, total: 1, max: 1 });
      // 2 explicit readPragmaScanTexts calls above plus 2 internal reads from
      // checkInlinePragmaBudgets; the budget check itself reuses cached text.
      expect(readFileSync).toHaveBeenCalledTimes(4);
      expect(readFileSync.mock.calls.map((call) => String(call[0]))).toEqual([...files, ...files]);
    });

    it("checkInlinePragmaBudgets: reports unreadable scan files as structured failures", async () => {
      mockUtils("/repo");
      mockFs({
        readFileSync: vi.fn((p: string) => {
          if (String(p).endsWith("unreadable.ts")) {
            throw new Error("unreadable pragma fixture");
          }
          return "";
        }) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const report = mod.checkInlinePragmaBudgets(
        {
          maxInlineEslintDisables: 0,
          maxBroadEslintDisables: 0,
          maxCoverageIgnorePragmas: 0,
          maxJscpdIgnorePragmas: 0,
        },
        ["/repo/src/unreadable.ts"],
      );
      expect(report.ok).toBe(false);
      expect(report.error).toBe("unreadable pragma fixture");
      expect(report.budgets.inline_eslint_disables).toEqual({
        ok: false,
        total: null,
        max: 0,
      });
      expect(report.budgets.broad_eslint_disables).toEqual({ ok: false, total: null, max: 0 });
      expect(report.budgets.coverage_ignore_pragmas).toEqual({ ok: false, total: null, max: 0 });
      expect(report.budgets.jscpd_ignore_pragmas).toEqual({ ok: false, total: null, max: 0 });
    });

    it("checkInlinePragmaBudgets: stringifies non-Error scan failures", async () => {
      mockUtils("/repo");
      mockFs({
        readFileSync: vi.fn(() => {
          throw "pragma-read-failed";
        }) as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const report = mod.checkInlinePragmaBudgets(
        {
          maxInlineEslintDisables: 0,
          maxBroadEslintDisables: 0,
          maxCoverageIgnorePragmas: 0,
          maxJscpdIgnorePragmas: 0,
        },
        ["/repo/src/unreadable.ts"],
      );
      expect(report.budgets.inline_eslint_disables).toMatchObject({
        ok: false,
        total: null,
        max: 0,
      });
      expect(report.error).toBe("pragma-read-failed");
    });

    it("walkFiles: non-directory short-circuits and nested walk collects matches", async () => {
      mockUtils("/repo");
      harness.mockPosixPath();
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
      expect(mod.walkFiles("/root", matcher, [], null)).toEqual(["/root/sub/b.ts", "/root/a.ts"]);
      expect(mod.walkFiles("/notdir", matcher)).toEqual([]);
    });

    it("walkFiles: directory skip predicate avoids descending ignored trees", async () => {
      mockUtils("/repo");
      harness.mockPosixPath();
      const readdirSync = vi.fn((p: string) => {
        if (String(p) === "/root") {
          return [
            { name: "node_modules", isDirectory: () => true, isFile: () => false },
            { name: "src", isDirectory: () => true, isFile: () => false },
          ];
        }
        if (String(p) === "/root/src") {
          return [{ name: "a.ts", isDirectory: () => false, isFile: () => true }];
        }
        throw new Error(`Unexpected directory read: ${p}`);
      });
      mockFs({
        statSync: vi.fn((p: string) => ({
          isDirectory: () =>
            String(p) === "/root" || String(p) === "/root/src" || String(p) === "/root/node_modules",
        })) as never,
        readdirSync: readdirSync as never,
      });
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      const collected = mod.walkFiles("/root", (p) => p.endsWith(".ts"), [], {
        shouldSkipDirectory: (p) => p.endsWith("/node_modules"),
      });
      expect(collected).toEqual(["/root/src/a.ts"]);
      expect(readdirSync).not.toHaveBeenCalledWith("/root/node_modules", expect.anything());
    });
  });

  describe("main()", () => {
    async function seedRoots(root: string): Promise<void> {
      // collectTypeScriptFiles() walks src/tests/packages; all three must exist
      // because walkFiles() statSync's the root before checking isDirectory().
      for (const segment of ["src", "tests", "packages"]) {
        await mkdir(`${root}/${segment}`, { recursive: true });
      }
      await writeFile(`${root}/eslint-suppressions.json`, "{}\n", "utf8");
    }

    async function seedFixture(root: string): Promise<void> {
      await seedRoots(root);
      const files = {
        "src/cli.ts": [
          "/** CLI test fixture. */",
          'import "./core/a";',
          "/** Marks the fixture entrypoint as loaded. */",
          "export const cli = true;",
          "",
        ].join("\n"),
        "src/core/a.ts": [
          "/** Core test fixture. */",
          'import "./b";',
          "/** Runs the fixture command. */",
          "export function run() { return true; }",
          "",
        ].join("\n"),
        "src/core/b.ts": [
          "/** Leaf test fixture. */",
          "/** Fixture leaf sentinel number. */",
          "export const value = 1;",
          "",
        ].join("\n"),
        "tests/unit/sample.ts": "export const sample = true;\n",
        // Packages are held to the same documentation bar as src/, so the fixture
        // package needs both a module header and a per-export docstring to be clean.
        "packages/pkg/index.ts": [
          "/** @module pkg */",
          "/** Fixture package flag. */",
          "export const pkg = true;",
          "",
        ].join("\n"),
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
        scanned: {
          file_count: number;
          source_docstring_coverage_percent: number;
          exported_docstring_coverage_percent: number;
          member_docstring_coverage_percent: number;
        };
        source_docstrings: { coverage_percent: number };
        exported_docstrings: { coverage_percent: number };
        member_docstrings: { coverage_percent: number };
      };
      expect(payload.ok).toBe(true);
      expect(payload.scanned.file_count).toBeGreaterThan(0);
      expect(payload.scanned.source_docstring_coverage_percent).toBe(100);
      expect(payload.scanned.exported_docstring_coverage_percent).toBe(100);
      expect(payload.scanned.member_docstring_coverage_percent).toBe(100);
      expect(payload.source_docstrings.coverage_percent).toBe(100);
      expect(payload.exported_docstrings.coverage_percent).toBe(100);
      expect(payload.member_docstrings.coverage_percent).toBe(100);
    });

    it("reports member_docstring and trivial_docstring violations in text mode", async () => {
      const root = await harness.createTempRoot("pm-static-quality-docs-");
      await seedRoots(root);
      await mkdir(`${root}/src/core`, { recursive: true });
      // src/cli.ts is entry-allowlisted (never an orphan) and imports the contract
      // module so the contract module is not flagged as an orphan either.
      await writeFile(
        `${root}/src/cli.ts`,
        [
          "/** Entry fixture. */",
          'import "./core/contract";',
          "/** Marks the fixture entry as loaded. */",
          "export const cli = true;",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        `${root}/src/core/contract.ts`,
        [
          "/** @module contract */",
          "/** id */", // name-only docstring → trivial_docstring violation
          "export const id = 1;",
          "/** Documented contract. */",
          "export interface Contract {",
          "  undocumented: string;", // missing member docstring → member coverage < 100
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      mockUtils(root);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--max-lines", "500", "--max-lines-tests", "500"];
      mod.main();
      expect(process.exitCode).toBe(1);
      const emitted = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(emitted.some((line) => line.includes("member_docstring coverage"))).toBe(true);
      expect(emitted.some((line) => line.includes("trivial_docstring violations"))).toBe(true);
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
      await mkdir(`${root}/src/core`, { recursive: true });
      const block = [
        "/** Duplicate fixture one. */",
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
      await mkdir(`${root}/src/cli`, { recursive: true });
      const block = [
        "/** Duplicate fixture one. */",
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
      await mkdir(`${root}/src`, { recursive: true });
      // A lone unreferenced src module → orphan_modules violation (line 401-402).
      await writeFile(`${root}/src/lonely.ts`, "/** Lonely fixture. */\nexport const lonely = 1;\n", "utf8");
      mockUtils(root);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--max-lines", "500", "--max-lines-tests", "500"];
      mod.main();
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("orphan_modules violations"))).toBe(true);
    });

    it("reports source_docstring coverage violations in text mode", async () => {
      const root = await harness.createTempRoot("pm-static-quality-docstrings-");
      await seedRoots(root);
      await mkdir(`${root}/src`, { recursive: true });
      await writeFile(`${root}/src/cli.ts`, "export const cli = true;\n", "utf8");
      mockUtils(root);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--max-lines", "500", "--max-lines-tests", "500"];
      mod.main();
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("source_docstring coverage"))).toBe(true);
    });

    it("reports exported_docstring coverage violations in text mode", async () => {
      const root = await harness.createTempRoot("pm-static-quality-exported-docstrings-");
      await seedRoots(root);
      await mkdir(`${root}/src`, { recursive: true });
      await writeFile(
        `${root}/src/cli.ts`,
        ["/**", " * @module cli", " *", " * Module docs.", " */", "export function missing() { return true; }", ""].join("\n"),
        "utf8",
      );
      mockUtils(root);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--max-lines", "500", "--max-lines-tests", "500"];
      mod.main();
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("exported_docstring coverage"))).toBe(true);
    });

    it("reports boilerplate_docstring violations in text mode", async () => {
      const root = await harness.createTempRoot("pm-static-quality-boilerplate-docstrings-");
      await seedRoots(root);
      await mkdir(`${root}/src`, { recursive: true });
      await writeFile(
        `${root}/src/cli.ts`,
        [
          "/**",
          " * @module cli",
          " *",
          " * Module docs.",
          " */",
          "/**",
          " * Defines the exported CliOptions type contract used to keep command and SDK surfaces type-safe.",
          " */",
          "export interface CliOptions { ok: boolean; }",
          "",
        ].join("\n"),
        "utf8",
      );
      mockUtils(root);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--max-lines", "500", "--max-lines-tests", "500"];
      mod.main();
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("boilerplate_docstring violations"))).toBe(true);
    });

    it("reports eslint_suppressions budget violations in text mode", async () => {
      const root = await harness.createTempRoot("pm-static-quality-suppbudget-");
      await seedFixture(root);
      await writeFile(
        `${root}/eslint-suppressions.json`,
        JSON.stringify({ "src/core/a.ts": { complexity: { count: 2 } } }),
        "utf8",
      );
      mockUtils(root);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--max-lines", "500", "--max-lines-tests", "500", "--max-eslint-suppressions", "1"];
      mod.main();
      expect(process.exitCode).toBe(1);
      const emitted = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(emitted.some((line) => line.includes("eslint_suppressions budget exceeded: 2 > 1"))).toBe(true);
    });

    it("reports eslint_suppressions file failures in text mode", async () => {
      const root = await harness.createTempRoot("pm-static-quality-suppfile-");
      await seedFixture(root);
      await rm(`${root}/eslint-suppressions.json`);
      mockUtils(root);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--max-lines", "500", "--max-lines-tests", "500"];
      mod.main();
      expect(process.exitCode).toBe(1);
      const emitted = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(emitted.some((line) => line.includes("eslint_suppressions budget failed"))).toBe(true);
    });

    it("reports inline pragma budget violations in text mode", async () => {
      const root = await harness.createTempRoot("pm-static-quality-pragmabudget-");
      await seedFixture(root);
      await writeFile(
        `${root}/src/core/pragma-user.ts`,
        [
          "/** Pragma fixture. */",
          'import "./a";',
          ESLINT_DISABLE_PRAGMA,
          "export const p = 1;",
          ESLINT_BROAD_DISABLE_PRAGMA,
          "export const p2 = 2;",
          COVERAGE_IGNORE_PRAGMA,
          "export const q = 3;",
          JSCPD_IGNORE_PRAGMA,
          "export const r = 4;",
          JSCPD_IGNORE_END_PRAGMA,
          "",
        ].join("\n"),
        "utf8",
      );
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
        "--max-inline-lint-disables",
        "0",
        "--max-broad-lint-disables",
        "0",
        "--max-coverage-ignore-pragmas",
        "0",
        "--max-jscpd-ignore-pragmas",
        "0",
      ];
      mod.main();
      expect(process.exitCode).toBe(1);
      const emitted = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(emitted.some((line) => line.includes("inline_eslint_disables budget exceeded: 1 > 0"))).toBe(true);
      expect(emitted.some((line) => line.includes("broad_eslint_disables budget exceeded: 1 > 0"))).toBe(true);
      expect(emitted.some((line) => line.includes("coverage_ignore_pragmas budget exceeded: 1 > 0"))).toBe(true);
      expect(emitted.some((line) => line.includes("jscpd_ignore_pragmas budget exceeded: 1 > 0"))).toBe(true);
    });

    it("reports inline pragma scan failures in text mode", async () => {
      const root = await harness.createTempRoot("pm-static-quality-pragma-read-fail-");
      await seedFixture(root);
      await mkdir(`${root}/scripts`, { recursive: true });
      await writeFile(`${root}/scripts/unreadable.mjs`, "export const unreadable = true;\n", "utf8");
      const realReadFileSync = fs.readFileSync;
      mockUtils(root);
      mockFs({
        readFileSync: vi.fn((p: string, options?: BufferEncoding) => {
          if (String(p).replaceAll("\\", "/").endsWith("scripts/unreadable.mjs")) {
            throw new Error("unreadable pragma file");
          }
          return realReadFileSync(p, options);
        }) as never,
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--max-lines", "500", "--max-lines-tests", "500"];
      mod.main();
      expect(process.exitCode).toBe(1);
      const emitted = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(emitted.some((line) => line.includes("inline_pragmas scan failed"))).toBe(true);
      expect(emitted.some((line) => line.includes("unreadable pragma file"))).toBe(true);
    });

    it("reports CodeFactor parity scan failures in text mode", async () => {
      const root = await harness.createTempRoot("pm-static-quality-codefactor-fail-");
      await seedFixture(root);
      await mkdir(`${root}/.git`, { recursive: true });
      mockUtils(root);
      mockChildProcess({
        execFileSync: vi.fn((cmd: string, args: string[]) => {
          expect(cmd).toBe("git");
          if (args[0] === "merge-base") {
            throw new Error("missing base");
          }
          throw new Error("diff unavailable");
        }) as never,
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--max-lines", "500", "--max-lines-tests", "500"];
      mod.main();
      expect(process.exitCode).toBe(1);
      const emitted = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(emitted.some((line) => line.includes("codefactor_complexity scan failed"))).toBe(true);
    });

    it("rejects a duplicate-window below the minimum", async () => {
      mockUtils("/repo");
      const mod = await harness.importModuleStable<SqModule>(SCRIPT);
      process.argv = ["node", "x", "--duplicate-window", "3"];
      expect(() => mod.main()).toThrow("--duplicate-window must be >= 5.");
    });
  });
});
