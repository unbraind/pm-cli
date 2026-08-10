#!/usr/bin/env node

/**
 * Ratchet the population of absence-tolerant readers that only accept `ENOENT`.
 *
 * Tracker: pm-7rrqsk (partial application of a replication set). A reader that
 * treats a missing optional file as a default must accept `ENOTDIR` alongside
 * `ENOENT`: when an ancestor path component is a regular file the target cannot
 * exist either, so the two errno values answer the same question. Handling only
 * `ENOENT` converts a graceful default into an unclassified runtime fault that
 * escapes the caller's own root validation, reaches Sentry as an
 * `unexpected_fault`, and blocks the release gate.
 *
 * The bound is a ceiling that may only fall. Both directions fail: a higher
 * observed count is a regression, and a lower one is an undeclared improvement
 * that must be written down so the next regression cannot hide beneath slack.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { fail, flagString, parseFlags, repoRoot } from "./utils.mjs";

const DEFAULT_BASELINE_PATH = path.join(
  repoRoot,
  "scripts",
  "release",
  "absence-tolerance-baseline.json",
);
const SCAN_ROOTS = Object.freeze(["src"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage"]);
const ABSENT_ERRNO = "ENOENT";
const DIRECTORY_ERRNO = "ENOTDIR";

/** Collect the TypeScript sources this gate scans, sorted for stable reporting. */
export async function collectScanFiles(root = repoRoot, roots = SCAN_ROOTS) {
  const files = [];
  const pending = roots.map((entry) => path.join(root, entry));
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(absolute);
        continue;
      }
      if (entry.name.endsWith(".d.ts") || !entry.name.endsWith(".ts")) continue;
      files.push(absolute);
    }
  }
  return files.sort();
}

// `forEachChild` stops as soon as its callback returns a truthy value, so the
// recursive step must not forward the accumulator back to it.
function collectStringLiterals(node, found) {
  if (ts.isStringLiteralLike(node)) found.add(node.text);
  ts.forEachChild(node, (child) => {
    collectStringLiterals(child, found);
  });
  return found;
}

/**
 * Report every catch clause in one source that tolerates `ENOENT` alone.
 *
 * The literal set is read from the whole clause body rather than from a
 * comparison shape, so helper calls such as `isErrno(error, "ENOENT")` and
 * inline `error.code === "ENOENT"` tests are both recognised.
 */
export function findEnoentOnlyAbsenceCatches(sourceText, filePath) {
  const source = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
  );
  const findings = [];
  const visit = (node) => {
    if (ts.isCatchClause(node)) {
      const literals = collectStringLiterals(node.block, new Set());
      if (literals.has(ABSENT_ERRNO) && !literals.has(DIRECTORY_ERRNO)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        findings.push({
          file: path.relative(repoRoot, filePath).split(path.sep).join("/"),
          line: line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** Read the declared ceiling for this gate. */
export async function readBaseline(baselinePath = DEFAULT_BASELINE_PATH) {
  const parsed = JSON.parse(await readFile(baselinePath, "utf8"));
  const ceiling = parsed?.max_enoent_only_absence_catches;
  if (!Number.isInteger(ceiling) || ceiling < 0) {
    throw new Error(
      `Invalid baseline ${baselinePath}: max_enoent_only_absence_catches must be a non-negative integer.`,
    );
  }
  return { ceiling, allowed: parsed };
}

/** Score the observed population against the declared ceiling. */
export function evaluateAbsenceTolerance(findings, ceiling) {
  const observed = findings.length;
  if (observed > ceiling) {
    return {
      ok: false,
      observed,
      ceiling,
      direction: "regression",
      message:
        `${observed} catch clauses tolerate ${ABSENT_ERRNO} without ${DIRECTORY_ERRNO}, above the declared ceiling of ${ceiling}. ` +
        `An optional-file reader must treat ${DIRECTORY_ERRNO} as absence too; use isFileAbsentError from src/core/fs/fs-utils.ts.`,
      findings,
    };
  }
  if (observed < ceiling) {
    return {
      ok: false,
      observed,
      ceiling,
      direction: "undeclared_improvement",
      message:
        `${observed} catch clauses tolerate ${ABSENT_ERRNO} without ${DIRECTORY_ERRNO}, below the declared ceiling of ${ceiling}. ` +
        `Lower max_enoent_only_absence_catches to ${observed} so the ratchet keeps holding.`,
      findings,
    };
  }
  return { ok: true, observed, ceiling, direction: "held", findings };
}

/** Scan the repository and return the gate report without exiting. */
export async function runAbsenceToleranceGate(options = {}) {
  // `readBaseline` owns the default path so the fallback lives in one place.
  const { ceiling } = await readBaseline(options.baselinePath);
  const files = options.files ?? (await collectScanFiles(options.root));
  const findings = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    findings.push(...findEnoentOnlyAbsenceCatches(text, file));
  }
  return evaluateAbsenceTolerance(findings, ceiling);
}

/** CLI entrypoint for the absence-tolerance ratchet. */
export async function main(argv = process.argv.slice(2)) {
  const { flags } = parseFlags(argv);
  const baselinePath = flagString(flags, "baseline", DEFAULT_BASELINE_PATH);
  const report = await runAbsenceToleranceGate({ baselinePath });
  if (!report.ok) {
    for (const finding of report.findings.slice(0, 20)) {
      process.stdout.write(`${finding.file}:${finding.line}\n`);
    }
    fail(`absence-tolerance-gate: ${report.message}`);
    return report;
  }
  process.stdout.write(
    `absence-tolerance-gate ok: ${report.observed} ${ABSENT_ERRNO}-only absence catches at the declared ceiling.\n`,
  );
  return report;
}

/* c8 ignore start -- entrypoint guard is exercised through main() directly. */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
/* c8 ignore stop */
