#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { fail, flagBool, flagString, parseFlags, repoRoot } from "./utils.mjs";

export function walkFiles(directory, matcher, out = []) {
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

export function relativeToRepo(absolutePath) {
  return path.relative(repoRoot, absolutePath).replaceAll(path.sep, "/");
}

export function loadText(absolutePath) {
  return readFileSync(absolutePath, "utf8");
}

export function collectTypeScriptFiles() {
  const roots = ["src", "tests", "packages"].map((segment) => path.join(repoRoot, segment));
  const matchesTs = (absolutePath) => absolutePath.endsWith(".ts") && !absolutePath.endsWith(".d.ts");
  const files = roots.flatMap((root) => walkFiles(root, matchesTs));
  return files.sort((left, right) => left.localeCompare(right));
}

export function checkFileLength(files, maxSrcLines, maxTestLines) {
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

export function checkDirectoryLoad(files, maxFilesPerDirectory) {
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

export function normalizeLine(rawLine) {
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

export function checkDuplicateChunks(files, duplicateWindowLines, maxDuplicateChunks) {
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

export function resolveRelativeImport(fromAbsolute, specifier) {
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

export function sourceFilesOnly(files) {
  return files.filter((absolutePath) => relativeToRepo(absolutePath).startsWith("src/"));
}

function stripShebang(sourceText) {
  if (!sourceText.startsWith("#!")) {
    return sourceText;
  }
  const newlineIndex = sourceText.indexOf("\n");
  return newlineIndex === -1 ? "" : sourceText.slice(newlineIndex + 1);
}

export function hasModuleDocstring(sourceText) {
  return stripShebang(sourceText).trimStart().startsWith("/**");
}

export function checkSourceDocstringCoverage(files, minCoveragePercent) {
  const sourceFiles = sourceFilesOnly(files);
  const missing = [];
  for (const absolutePath of sourceFiles) {
    if (!hasModuleDocstring(loadText(absolutePath))) {
      missing.push({ path: relativeToRepo(absolutePath), reason: "missing_module_docstring" });
    }
  }
  const documented = sourceFiles.length - missing.length;
  const coveragePercent = sourceFiles.length === 0 ? 100 : (documented / sourceFiles.length) * 100;
  return {
    ok: coveragePercent >= minCoveragePercent,
    total: sourceFiles.length,
    documented,
    missing: missing.sort((left, right) => left.path.localeCompare(right.path)),
    coverage_percent: Number(coveragePercent.toFixed(2)),
    min_coverage_percent: minCoveragePercent,
  };
}

function hasExportModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function exportedDocstringTarget(node) {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    hasExportModifier(node)
  ) {
    return node;
  }
  if (ts.isVariableStatement(node) && hasExportModifier(node)) {
    const hasFunctionInitializer = node.declarationList.declarations.some(
      (declaration) =>
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)),
    );
    if (hasFunctionInitializer) {
      return node;
    }
  }
  return undefined;
}

function declarationName(node) {
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    /* c8 ignore next -- exported variable-function targets require an identifier declaration name */
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : "exported_value";
  }
  return node.name && ts.isIdentifier(node.name) ? node.name.text : "exported_declaration";
}

function hasNodeDocstring(sourceFile, node) {
  const fullText = sourceFile.getFullText();
  const strippedText = stripShebang(fullText);
  const moduleDocRelativeStart = strippedText.trimStart().startsWith("/**") ? strippedText.indexOf("/**") : -1;
  const moduleDocStart = moduleDocRelativeStart === -1 ? -1 : fullText.length - strippedText.length + moduleDocRelativeStart;
  const ranges = ts.getLeadingCommentRanges(fullText, node.pos) ?? [];
  return ranges.some((range) => {
    if (range.pos === moduleDocStart) {
      return false;
    }
    const comment = fullText.slice(range.pos, range.end);
    return comment.startsWith("/**") && !comment.includes("@module");
  });
}

export function checkExportedDocstringCoverage(files, minCoveragePercent) {
  const missing = [];
  let total = 0;
  let documented = 0;
  for (const absolutePath of sourceFilesOnly(files)) {
    const sourceText = loadText(absolutePath);
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true);
    for (const node of sourceFile.statements) {
      const target = exportedDocstringTarget(node);
      if (!target) {
        continue;
      }
      total += 1;
      if (hasNodeDocstring(sourceFile, target)) {
        documented += 1;
        continue;
      }
      const start = sourceFile.getLineAndCharacterOfPosition(target.getStart(sourceFile));
      missing.push({
        path: relativeToRepo(absolutePath),
        line: start.line + 1,
        name: declarationName(target),
        reason: "missing_exported_docstring",
      });
    }
  }
  const coveragePercent = total === 0 ? 100 : (documented / total) * 100;
  return {
    ok: coveragePercent >= minCoveragePercent,
    total,
    documented,
    missing: missing.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line),
    coverage_percent: Number(coveragePercent.toFixed(2)),
    min_coverage_percent: minCoveragePercent,
  };
}

const BOILERPLATE_DOCSTRING_PATTERNS = [
  /Provides the exported .+ operation used by the pm CLI runtime and integration tests\./u,
  /Describes the exported .+ data contract used across command and SDK boundaries\./u,
  /Defines the exported .+ type contract used to keep command and SDK surfaces type-safe\./u,
];

export function checkDocstringBoilerplate(files) {
  const violations = [];
  for (const absolutePath of sourceFilesOnly(files)) {
    const sourceText = loadText(absolutePath);
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true);
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, sourceText);
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      if (token === ts.SyntaxKind.MultiLineCommentTrivia) {
        const commentStart = scanner.getTokenPos();
        const comment = sourceText.slice(commentStart, scanner.getTextPos());
        if (comment.startsWith("/**")) {
          const matched = BOILERPLATE_DOCSTRING_PATTERNS.find((pattern) => pattern.test(comment));
          if (matched) {
            const start = sourceFile.getLineAndCharacterOfPosition(commentStart);
            violations.push({
              path: relativeToRepo(absolutePath),
              line: start.line + 1,
              reason: "boilerplate_docstring",
            });
          }
        }
      }
      token = scanner.scan();
    }
  }
  return violations.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

export function checkOrphanSourceModules(files) {
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
          /* c8 ignore next -- `incoming.has(resolved)` guarantees a numeric entry; the `?? 0` fallback is unreachable */
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

export function complexityContribution(node) {
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

export function functionLikeName(node, sourceFile) {
  if ("name" in node && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `<anonymous@${position.line + 1}>`;
}

export function computeFunctionComplexity(node) {
  let complexity = 1;
  const visit = (child) => {
    complexity += complexityContribution(child);
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return complexity;
}

export function checkFunctionComplexity(files, maxComplexity) {
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

export function usage() {
  console.log(`Usage:
  node scripts/release/static-quality-gate.mjs [--json]
    [--max-lines 3400]
    [--max-lines-tests 7000]
    [--max-complexity 260]
    [--max-files-per-dir 120]
    [--duplicate-window 24]
    [--max-duplicate-chunks 8]
    [--min-docstring-coverage 100]
    [--min-exported-docstring-coverage 100]

Runs strict static quality checks for dead/orphan modules, duplicate chunks, complexity,
file-length limits, source-file/exported declaration docstring coverage, and directory organization density.
`);
}

export function parseNumberFlag(flags, key, fallback) {
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

export function main() {
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
  const maxDuplicateChunks = parseNumberFlag(flags, "max-duplicate-chunks", 8);
  const minDocstringCoverage = parseNumberFlag(flags, "min-docstring-coverage", 100);
  const minExportedDocstringCoverage = parseNumberFlag(flags, "min-exported-docstring-coverage", 100);

  if (duplicateWindow < 5) {
    fail("--duplicate-window must be >= 5.");
  }

  const files = collectTypeScriptFiles();
  const duplicateScopeFiles = files.filter((absolutePath) => {
    const relative = relativeToRepo(absolutePath);
    return relative.startsWith("src/core/") || relative.startsWith("src/sdk/") || relative.startsWith("src/cli/");
  });
  const fileLengthViolations = checkFileLength(files, maxSrcLines, maxTestLines);
  const directoryViolations = checkDirectoryLoad(files, maxFilesPerDirectory);
  const duplicateViolations = checkDuplicateChunks(duplicateScopeFiles, duplicateWindow, maxDuplicateChunks);
  const orphanViolations = checkOrphanSourceModules(files);
  const complexityViolations = checkFunctionComplexity(files, maxComplexity);
  const sourceDocstringCoverage = checkSourceDocstringCoverage(files, minDocstringCoverage);
  const exportedDocstringCoverage = checkExportedDocstringCoverage(files, minExportedDocstringCoverage);
  const boilerplateDocstringViolations = checkDocstringBoilerplate(files);

  const report = {
    ok:
      fileLengthViolations.length === 0 &&
      directoryViolations.length === 0 &&
      duplicateViolations.length <= maxDuplicateChunks &&
      orphanViolations.length === 0 &&
      complexityViolations.length === 0 &&
      sourceDocstringCoverage.ok &&
      exportedDocstringCoverage.ok &&
      boilerplateDocstringViolations.length === 0,
    scanned: {
      file_count: files.length,
      duplicate_scope_file_count: duplicateScopeFiles.length,
      duplicate_window_lines: duplicateWindow,
      source_docstring_coverage_percent: sourceDocstringCoverage.coverage_percent,
      exported_docstring_coverage_percent: exportedDocstringCoverage.coverage_percent,
    },
    thresholds: {
      max_src_lines: maxSrcLines,
      max_test_lines: maxTestLines,
      max_complexity: maxComplexity,
      max_files_per_dir: maxFilesPerDirectory,
      max_duplicate_chunks: maxDuplicateChunks,
      min_docstring_coverage_percent: minDocstringCoverage,
      min_exported_docstring_coverage_percent: minExportedDocstringCoverage,
    },
    violations: {
      file_length: fileLengthViolations,
      directory_load: directoryViolations,
      duplicate_chunks: duplicateViolations,
      orphan_modules: orphanViolations,
      complexity: complexityViolations,
      source_docstrings: sourceDocstringCoverage.missing,
      exported_docstrings: exportedDocstringCoverage.missing,
      boilerplate_docstrings: boilerplateDocstringViolations,
    },
    source_docstrings: sourceDocstringCoverage,
    exported_docstrings: exportedDocstringCoverage,
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
    if (!sourceDocstringCoverage.ok) {
      console.error(
        `- source_docstring coverage: ${sourceDocstringCoverage.coverage_percent}% ` +
          `< ${sourceDocstringCoverage.min_coverage_percent}% (${sourceDocstringCoverage.missing.length} missing)`,
      );
    }
    if (!exportedDocstringCoverage.ok) {
      console.error(
        `- exported_docstring coverage: ${exportedDocstringCoverage.coverage_percent}% ` +
          `< ${exportedDocstringCoverage.min_coverage_percent}% (${exportedDocstringCoverage.missing.length} missing)`,
      );
    }
    if (boilerplateDocstringViolations.length > 0) {
      console.error(`- boilerplate_docstring violations: ${boilerplateDocstringViolations.length}`);
    }
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

/* c8 ignore start -- CLI auto-run guard; logic covered via exported main() */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
/* c8 ignore stop */
