#!/usr/bin/env node

/**
 * Prevent optional governance-audit APIs from leaking back into bare core.
 *
 * The word "audit" remains legitimate for immutable history/integrity concepts,
 * package-install guidance, and the package itself. This ratchet therefore
 * targets exact executable/API tokens instead of banning ordinary prose.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const FORBIDDEN_CORE_AUDIT_PATTERNS = [
  /--allow-audit(?:-[a-z-]+)?\b/gu,
  /--audit\b/gu,
  /\ballowAudit[A-Z_a-z]*\b/gu,
  /\ballow_audit_[a-z_]+\b/gu,
  /\baudit_update\b/gu,
  /\baudit_release\b/gu,
  /\baudit_smoke\b/gu,
  /\blinked_artifact_audit\b/gu,
  /\brun(?:DedupeAudit|DedupeMerge|CommentsAudit|Normalize)\b/gu,
];

function walk(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, out);
    } else if (/\.(?:ts|json)$/u.test(entry.name)) {
      out.push(absolute);
    }
  }
  return out;
}

export function findAuditBoundaryViolations(
  sources,
  patterns = FORBIDDEN_CORE_AUDIT_PATTERNS,
) {
  const violations = [];
  for (const source of sources) {
    const lines = source.text.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (match) {
          violations.push({
            path: source.path,
            line: index + 1,
            token: match[0],
          });
        }
      }
    }
  }
  return violations;
}

export function loadBareCoreBoundarySources(root = repoRoot) {
  const srcRoot = path.join(root, "src");
  return [
    ...walk(srcRoot).map((absolute) => ({
      path: path.relative(root, absolute).replaceAll(path.sep, "/"),
      text: readFileSync(absolute, "utf8"),
    })),
    {
      path: "PRD.md",
      text: readFileSync(path.join(root, "PRD.md"), "utf8"),
    },
  ];
}

export function main(
  violations = findAuditBoundaryViolations(loadBareCoreBoundarySources()),
) {
  if (violations.length > 0) {
    console.error("Audit package boundary violations detected:");
    for (const violation of violations) {
      console.error(
        `- ${violation.path}:${violation.line} contains ${JSON.stringify(violation.token)}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log("Audit package boundary gate passed.");
}

export function runIfMain(candidate = process.argv[1]) {
  if (candidate && path.resolve(candidate) === fileURLToPath(import.meta.url)) {
    main();
  }
}

runIfMain();
