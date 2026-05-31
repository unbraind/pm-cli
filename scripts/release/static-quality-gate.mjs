#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fail, flagBool, flagString, parseFlags, repoRoot } from "./utils.mjs";

function walkFiles(directory, matcher, out = []) {
  if (!statSync(directory).isDirectory()) {
    return out;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(absolute, matcher, out);
      continue;
    }
    if (entry.isFile() && matcher(absolute)) {
      out.push(absolute);
    }
  }
  return out;
}

function relativeToRepo(absolutePath) {
  return path.relative(repoRoot, absolutePath).replaceAll(path.sep, "/");
}

function loadText(absolutePath) {
  return readFileSync(absolutePath, "utf8");
}

function collectTypeScriptFiles() {
  const roots = ["src", "tests", "packages"].map((segment) => path.join(repoRoot, segment));
  const matchesTs = (absolutePath) => absolutePath.endsWith(".ts") && !absolutePath.endsWith(".d.ts");
  const files = roots.flatMap((root) => walkFiles(root, matchesTs));
  return files.sort((left, right) => left.localeCompare(right));
}

function checkFileLength(files, maxSrcLines, maxTestLines) {
  const violations = [];
  for (const absolutePath of files) {
    const relativePath = relativeToRepo(absolutePath);
    const lineCount = loadText(absolutePath).split(/\r?\n/).length;
    const maxLines = relativePath.startsWith("tests/") ? maxTestLines : maxSrcLines;
    if (lineCount > maxLines) {
      violations.push({
        path: relativePath,
        line_count: lineCount,
        max_lines: maxLines,
      });
    }
  }
  return violations;
}

function checkDirectoryLoad(files, maxFilesPerDirectory) {
  const counts = new Map();
  for (const absolutePath of files) {
    const relativeDirectory = relativeToRepo(path.dirname(absolutePath));
    counts.set(relativeDirectory, (counts.get(relativeDirectory) ?? 0) + 1);
  }
  const violations = [];
  for (const [directory, count] of counts.entries()) {
    if (count > maxFilesPerDirectory) {
      violations.push({
        directory,
        file_count: count,
        max_files: maxFilesPerDirectory,
      });
    }
  }
  return violations.sort((left, right) => right.file_count - left.file_count);
}

function normalizeLine(rawLine) {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("*/")
  ) {
    return "";
  }
  return trimmed.replaceAll(/\s+/g, " ");
}

function checkDuplicateChunks(files, duplicateWindowLines, maxDuplicateChunks) {
  const windowMap = new Map();
  const duplicates = [];

  for (const absolutePath of files) {
    const relativePath = relativeToRepo(absolutePath);
    const lines = loadText(absolutePath).split(/\r?\n/).map(normalizeLine);
    for (let index = 0; index <= lines.length - duplicateWindowLines; index += 1) {
      const windowLines = lines.slice(index, index + duplicateWindowLines);
      if (windowLines.some((line) => line.length === 0)) {
        continue;
      }
      const key = windowLines.join("\n");
      const current = {
        path: relativePath,
        start_line: index + 1,
      };
      const first = windowMap.get(key);
      if (!first) {
        windowMap.set(key, current);
        continue;
      }
      if (first.path === current.path) {
        continue;
      }
      const isOverlappingDuplicate = duplicates.some(
        (entry) =>
          entry.first.path === first.path &&
          entry.second.path === current.path &&
          Math.abs(entry.first.start_line - first.start_line) < duplicateWindowLines &&
          Math.abs(entry.second.start_line - current.start_line) < duplicateWindowLines,
      );
      if (isOverlappingDuplicate) {
        continue;
      }
      duplicates.push({
        lines: duplicateWindowLines,
        first,
        second: current,
      });
      if (duplicates.length > maxDuplicateChunks) {
        return duplicates;
      }
    }
  }
  return duplicates;
}

function resolveRelativeImport(fromAbsolute, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const fromDirectory = path.dirname(fromAbsolute);
  const candidateBase = path.resolve(fromDirectory, specifier);
  const candidateWithoutJs = candidateBase.replace(/\.m?js$/u, "");
  const candidates = [
    candidateBase,
    candidateWithoutJs,
    `${candidateBase}.ts`,
    `${candidateBase}.tsx`,
    `${candidateWithoutJs}.ts`,
    `${candidateWithoutJs}.tsx`,
    path.join(candidateBase, "index.ts"),
    path.join(candidateWithoutJs, "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      const stats = statSync(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      // Ignore missing candidate paths.
    }
  }
  return null;
}

function sourceFilesOnly(files) {
  return files.filter((absolutePath) => relativeToRepo(absolutePath).startsWith("src/"));
}

function checkOrphanSourceModules(files) {
  const sourceFiles = sourceFilesOnly(files);
  const incoming = new Map(sourceFiles.map((file) => [file, 0]));

  for (const absolutePath of sourceFiles) {
    const sourceFile = ts.createSourceFile(absolutePath, loadText(absolutePath), ts.ScriptTarget.Latest, true);
    for (const statement of sourceFile.statements) {
      if (
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const resolved = resolveRelativeImport(absolutePath, statement.moduleSpecifier.text);
        if (resolved && incoming.has(resolved)) {
          incoming.set(resolved, (incoming.get(resolved) ?? 0) + 1);
        }
      }
    }
  }

  const entryAllowList = new Set([
    "src/cli.ts",
    "src/cli/main.ts",
    "src/cli/telemetry-flush.ts",
    "src/cli/search-refresh.ts",
    "src/mcp/server.ts",
    "src/sdk/index.ts",
    "src/sdk/testing.ts",
    "src/types/index.ts",
  ]);
  const violations = [];
  for (const [absolutePath, incomingCount] of incoming.entries()) {
    const relativePath = relativeToRepo(absolutePath);
    if (entryAllowList.has(relativePath)) {
      continue;
    }
    if (relativePath.startsWith("src/types/")) {
      continue;
    }
    if (relativePath.endsWith("/index.ts")) {
      continue;
    }
    if (relativePath.endsWith(".spec.ts")) {
      continue;
    }
    if (incomingCount === 0) {
      violations.push({
        path: relativePath,
        reason: "no_local_import_references",
      });
    }
  }
  return violations.sort((left, right) => left.path.localeCompare(right.path));
}

function complexityContribution(node) {
  if (ts.isIfStatement(node)) return 1;
  if (ts.isForStatement(node)) return 1;
  if (ts.isForInStatement(node)) return 1;
  if (ts.isForOfStatement(node)) return 1;
  if (ts.isWhileStatement(node)) return 1;
  if (ts.isDoStatement(node)) return 1;
  if (ts.isCatchClause(node)) return 1;
  if (ts.isConditionalExpression(node)) return 1;
  if (ts.isCaseClause(node)) return 1;
  if (ts.isBinaryExpression(node)) {
    if (
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return 1;
    }
  }
  return 0;
}

function functionLikeName(node, sourceFile) {
  if ("name" in node && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `<anonymous@${position.line + 1}>`;
}

function computeFunctionComplexity(node) {
  let complexity = 1;
  const visit = (child) => {
    complexity += complexityContribution(child);
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return complexity;
}

function checkFunctionComplexity(files, maxComplexity) {
  const violations = [];
  for (const absolutePath of files) {
    const sourceText = loadText(absolutePath);
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node)
      ) {
        const complexity = computeFunctionComplexity(node);
        if (complexity > maxComplexity) {
          const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push({
            path: relativeToRepo(absolutePath),
            function_name: functionLikeName(node, sourceFile),
            line: start.line + 1,
            complexity,
            max_complexity: maxComplexity,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations.sort((left, right) => right.complexity - left.complexity);
}

function usage() {
  console.log(`Usage:
  node scripts/release/static-quality-gate.mjs [--json]
    [--max-lines 3400]
    [--max-lines-tests 7000]
    [--max-complexity 260]
    [--max-files-per-dir 120]
    [--duplicate-window 24]
    [--max-duplicate-chunks 4]

Runs strict static quality checks for dead/orphan modules, duplicate chunks, complexity,
file-length limits, and directory organization density.
`);
}

function parseNumberFlag(flags, key, fallback) {
  const raw = flagString(flags, key, null);
  if (raw === null) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    fail(`Invalid --${key} value "${raw}".`);
  }
  return parsed;
}

function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    usage();
    return;
  }

  const outputJson = flagBool(flags, "json", false);
  const maxSrcLines = parseNumberFlag(flags, "max-lines", 3400);
  const maxTestLines = parseNumberFlag(flags, "max-lines-tests", 7000);
  const maxComplexity = parseNumberFlag(flags, "max-complexity", 260);
  const maxFilesPerDirectory = parseNumberFlag(flags, "max-files-per-dir", 120);
  const duplicateWindow = parseNumberFlag(flags, "duplicate-window", 24);
  const maxDuplicateChunks = parseNumberFlag(flags, "max-duplicate-chunks", 4);

  if (duplicateWindow < 5) {
    fail("--duplicate-window must be >= 5.");
  }

  const files = collectTypeScriptFiles();
  const duplicateScopeFiles = files.filter((absolutePath) => {
    const relative = relativeToRepo(absolutePath);
    return relative.startsWith("src/core/") || relative.startsWith("src/sdk/");
  });
  const fileLengthViolations = checkFileLength(files, maxSrcLines, maxTestLines);
  const directoryViolations = checkDirectoryLoad(files, maxFilesPerDirectory);
  const duplicateViolations = checkDuplicateChunks(duplicateScopeFiles, duplicateWindow, maxDuplicateChunks);
  const orphanViolations = checkOrphanSourceModules(files);
  const complexityViolations = checkFunctionComplexity(files, maxComplexity);

  const report = {
    ok:
      fileLengthViolations.length === 0 &&
      directoryViolations.length === 0 &&
      duplicateViolations.length <= maxDuplicateChunks &&
      orphanViolations.length === 0 &&
      complexityViolations.length === 0,
    scanned: {
      file_count: files.length,
      duplicate_scope_file_count: duplicateScopeFiles.length,
      duplicate_window_lines: duplicateWindow,
    },
    thresholds: {
      max_src_lines: maxSrcLines,
      max_test_lines: maxTestLines,
      max_complexity: maxComplexity,
      max_files_per_dir: maxFilesPerDirectory,
      max_duplicate_chunks: maxDuplicateChunks,
    },
    violations: {
      file_length: fileLengthViolations,
      directory_load: directoryViolations,
      duplicate_chunks: duplicateViolations,
      orphan_modules: orphanViolations,
      complexity: complexityViolations,
    },
  };

  if (outputJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.ok) {
    console.log("Static quality gate passed.");
  } else {
    console.error("Static quality gate failed.");
    if (fileLengthViolations.length > 0) {
      console.error(`- file_length violations: ${fileLengthViolations.length}`);
    }
    if (directoryViolations.length > 0) {
      console.error(`- directory_load violations: ${directoryViolations.length}`);
    }
    if (duplicateViolations.length > maxDuplicateChunks) {
      console.error(`- duplicate_chunks violations: ${duplicateViolations.length}`);
    }
    if (orphanViolations.length > 0) {
      console.error(`- orphan_modules violations: ${orphanViolations.length}`);
    }
    if (complexityViolations.length > 0) {
      console.error(`- complexity violations: ${complexityViolations.length}`);
    }
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

main();
