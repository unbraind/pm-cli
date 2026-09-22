import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectFillerDocstrings, compareDocstringBaseline, main, readDocstringCensus, readPreviousDocstringBaseline } from "../../../../scripts/release/docstring-quality.mjs";

describe("docstring content ratchet", () => {
  it("finds filler only in documentation comments, including wrapped prose", () => {
    const source = [
      '/** Implements run for the public runtime surface of this module. */',
      'export function run() {}',
      '/** Contract fields. */',
      'export interface Options {',
      ' /** Value that configures or reports size for this contract. */',
      ' size: number;',
      '}',
      '/** Provides CLI runtime support for\n * Parsing. */',
      'export const parser = 1;',
      '/** Documents a payload exchanged by command, SDK, and package integrations. */',
      'export type Payload = string;',
      'const literal = "/** Value that configures or reports fake for this contract. */";',
      '// Implements ignored for the public runtime surface of this module.',
      '/** Maximum request body size in bytes; rejects oversized inputs before parsing. */',
      'export const maxBytes = 4096;',
      '/** @param value Text parsed as a decimal count. */',
      'export function parse(value: string) {}',
    ].join('\n');
    expect(collectFillerDocstrings("src/example.ts", source).map((entry) => entry.line)).toEqual([1, 5, 8, 11]);
    expect(collectFillerDocstrings("src/empty.ts", "")).toEqual([]);
  });

  it("rejects growth, stale ceilings and baseline inflation without trading between files", () => {
    expect(compareDocstringBaseline({ "src/a.ts": 2 }, { "src/a.ts": 2 })).toEqual([]);
    expect(compareDocstringBaseline({ "src/a.ts": 3 }, { "src/a.ts": 2 })).toContain("src/a.ts: filler grew from 2 to 3");
    expect(compareDocstringBaseline({ "src/b.ts": 1 }, { "src/a.ts": 2 })).toEqual([
      "src/a.ts: lower baseline from 2 to 0",
      "src/b.ts: filler grew from 0 to 1",
    ]);
    expect(compareDocstringBaseline({}, { "src/a.ts": 1 }, { "src/a.ts": 0 })).toContain("src/a.ts: baseline increased from 0 to 1");
    expect(compareDocstringBaseline({ "src/new.ts": 1 }, { "src/new.ts": 1 }, {})).toEqual(["src/new.ts: baseline increased from 0 to 1"]);
    expect(() => compareDocstringBaseline({}, { "src/a.ts": -1 })).toThrow(/non-negative integer/);
    expect(() => compareDocstringBaseline({}, null)).toThrow(/object/);
  });
});

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("docstring inventory integration", () => {
  it("checks real sources, decreases exact ceilings and rejects edited history baselines", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pm-docstring-quality-"));
    roots.push(root);
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "scripts", "release"), { recursive: true });
    const source = path.join(root, "src", "a.ts");
    const baseline = path.join(root, "scripts", "release", "docstring-quality-baseline.json");
    writeFileSync(source, "/** Value that configures or reports size for this contract. */\nexport const size = 1;\n");
    writeFileSync(baseline, JSON.stringify({ version: 1, owner: "pm-dvwm", counts: { "src/a.ts": 1 } }));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "initial"], { cwd: root });
    vi.stubEnv("PM_QUALITY_BASE_REF", "HEAD");
    expect(main([], root)).toEqual({ files: 1, filler_count: 1, files_with_filler: 1, owner: "pm-dvwm" });
    expect(() => main(["--ignore"], root)).toThrow(/Use quality/);
    writeFileSync(source, "/** Maximum request size in bytes. */\nexport const size = 1;\n");
    expect(() => main([], root)).toThrow(/lower baseline/);
    expect(main(["--update"], root).filler_count).toBe(0);
    expect(JSON.parse(readFileSync(baseline, "utf8")).counts).toEqual({});
    expect(readDocstringCensus(root).findings).toEqual([]);
    writeFileSync(baseline, JSON.stringify({ counts: { "src/a.ts": 2 } }));
    expect(() => main(["--update"], root)).toThrow(/baseline increased/);
    execFileSync("git", ["rm", "--cached", "scripts/release/docstring-quality-baseline.json"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "remove"], { cwd: root });
    expect(readPreviousDocstringBaseline(root, "HEAD")).toBeUndefined();
    vi.stubEnv("PM_QUALITY_BASE_REF", "");
    writeFileSync(baseline, JSON.stringify({ counts: {} }));
    expect(main([], root).filler_count).toBe(0);
  });
});
