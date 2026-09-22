/** Detect low-information documentation and ratchet its per-file inventory. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import ts from "typescript";

const FILLER = [
  /Implements .+ for the public runtime surface of this module\./u,
  /Value that configures or reports .+ for this contract\./u,
  /Provides CLI runtime support for .+\./u,
  /payload exchanged by command, SDK, and package integrations\./u,
];
const BASELINE = "scripts/release/docstring-quality-baseline.json";

/** Return source locations of attached TSDoc filler, never string literals or ordinary comments. */
export function collectFillerDocstrings(filename, text) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const comments = new Map();
  const visit = (node) => {
    for (const doc of ts.getJSDocCommentsAndTags(node)) {
      if (doc.kind !== ts.SyntaxKind.JSDocComment) continue;
      const prose = text.slice(doc.pos, doc.end).replace(/\s*\*\s*/gu, " ").replace(/\s+/gu, " ");
      if (FILLER.some((pattern) => pattern.test(prose))) {
        comments.set(doc.pos, { path: filename, line: source.getLineAndCharacterOfPosition(doc.pos).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...comments.values()].sort((left, right) => left.line - right.line);
}

/** Validate a census before comparing it; corrupt ceilings must never disable enforcement. */
function assertCounts(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Docstring census must be an object");
  for (const [filename, count] of Object.entries(value)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${filename}: expected a non-negative integer`);
  }
}

/** Require exact current counts and prevent increases over a reviewed baseline. */
export function compareDocstringBaseline(actual, baseline, previous) {
  for (const counts of [actual, baseline]) assertCounts(counts);
  if (previous !== undefined) assertCounts(previous);
  const failures = [];
  for (const filename of [...new Set([...Object.keys(actual), ...Object.keys(baseline)])].sort()) {
    const count = actual[filename] ?? 0;
    const ceiling = baseline[filename] ?? 0;
    if (count > ceiling) failures.push(`${filename}: filler grew from ${ceiling} to ${count}`);
    if (count < ceiling) failures.push(`${filename}: lower baseline from ${ceiling} to ${count}`);
    if (previous !== undefined && ceiling > (previous[filename] ?? 0)) failures.push(`${filename}: baseline increased from ${previous[filename] ?? 0} to ${ceiling}`);
  }
  return failures;
}

/** Scan hand-authored runtime sources with the same roots as the all-source coverage gate. */
export function readDocstringCensus(root) {
  const files = fg.sync(["src/**/*.ts", "packages/**/*.ts", "scripts/**/*.{mjs,mts}", "plugins/**/*.{mjs,ts}", "docs/examples/**/*.{mjs,ts}"], {
    cwd: root, onlyFiles: true, ignore: ["**/node_modules/**", "**/*.d.ts", "scripts/prod/**"],
  }).sort();
  const findings = files.flatMap((filename) => collectFillerDocstrings(filename, readFileSync(path.join(root, filename), "utf8")));
  const counts = {};
  for (const entry of findings) counts[entry.path] = (counts[entry.path] ?? 0) + 1;
  return { files: files.length, findings, counts };
}

/** Read the reviewed baseline, distinguishing its initial introduction from Git failures. */
export function readPreviousDocstringBaseline(root, ref) {
  const files = execFileSync("git", ["ls-tree", "--name-only", ref, "--", BASELINE], { cwd: root, encoding: "utf8" });
  return files.trim() === "" ? undefined : JSON.parse(execFileSync("git", ["show", `${ref}:${BASELINE}`], { cwd: root, encoding: "utf8" })).counts;
}

/** Check or decrease the inventory; an explicit base ref protects CI against budget inflation. */
export function main(argv = process.argv.slice(2), root = process.cwd()) {
  if (argv.some((arg) => arg !== "--update")) throw new Error("Use quality:docstrings or quality:docstrings:update");
  const baselinePath = path.join(root, BASELINE);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const previous = process.env.PM_QUALITY_BASE_REF ? readPreviousDocstringBaseline(root, process.env.PM_QUALITY_BASE_REF) : undefined;
  const census = readDocstringCensus(root);
  const failures = compareDocstringBaseline(census.counts, baseline.counts, previous);
  const blockers = argv.includes("--update") ? failures.filter((failure) => !failure.includes(": lower baseline")) : failures;
  if (blockers.length > 0) throw new Error(`Docstring quality failed:\n${blockers.join("\n")}`);
  if (argv.includes("--update")) writeFileSync(baselinePath, `${JSON.stringify({ ...baseline, counts: census.counts }, null, 2)}\n`);
  return { files: census.files, filler_count: census.findings.length, files_with_filler: Object.keys(census.counts).length, owner: baseline.owner };
}
