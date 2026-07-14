#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { fail, flagBool, flagString, parseFlags, repoRoot } from "./utils.mjs";

export function walkFiles(directory, matcher, out = [], options = {}) {
  const opts = options ?? {};
  if (!statSync(directory).isDirectory()) {
    return out;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (opts.shouldSkipDirectory?.(absolute) === true) {
        continue;
      }
      walkFiles(absolute, matcher, out, opts);
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
  const files = roots
    .filter((root) => existsSync(root))
    .flatMap((root) =>
      walkFiles(root, matchesTs, [], {
        shouldSkipDirectory: (absolutePath) => path.basename(absolutePath) === "node_modules",
      }),
    );
  return files.sort((left, right) => left.localeCompare(right));
}

export function checkFileLength(files, maxSrcLines, maxTestLines) {
  const violations = [];
  for (const absolutePath of files) {
    const relativePath = relativeToRepo(absolutePath);
    const physicalLines = loadText(absolutePath).split(/\r?\n/);
    // Measure implementation size. Public TSDoc has its own mandatory 100%
    // gates, so counting comment-only and blank lines here would make the two
    // quality contracts conflict and incentivize less useful documentation.
    const lineCount = physicalLines.filter((line) => normalizeLine(line).length > 0).length;
    const maxLines = relativePath.startsWith("tests/") ? maxTestLines : maxSrcLines;
    if (lineCount > maxLines) {
      violations.push({
        path: relativePath,
        line_count: lineCount,
        physical_line_count: physicalLines.length,
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
  if (!specifier.startsWith(".") && !specifier.startsWith("src/")) {
    return null;
  }
  const candidateBase = specifier.startsWith("src/")
    ? path.resolve(repoRoot, specifier)
    : path.resolve(path.dirname(fromAbsolute), specifier);
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

// Documentation scope for the docstring-coverage gates: every hand-authored,
// shipped TypeScript module under `src/` and `packages/`. Test files (`*.spec.ts`,
// `*.test.ts`) are excluded because their describe/it blocks are self-documenting
// and carry no public API; `.d.ts` files are already filtered upstream. This is
// deliberately broader than `sourceFilesOnly` (which stays `src/`-only for the
// orphan-module check) so first-party extension packages are held to the same
// documentation bar as the core CLI they extend.
export function documentedSourceFiles(files) {
  return files.filter((absolutePath) => {
    const relativePath = relativeToRepo(absolutePath).replace(/\\/g, "/");
    if (!relativePath.startsWith("src/") && !relativePath.startsWith("packages/")) {
      return false;
    }
    return !/\.(?:spec|test)\.[cm]?tsx?$/u.test(relativePath);
  });
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

function formatCoveragePercent(coveragePercent, minCoveragePercent) {
  const fractionalPart = String(minCoveragePercent).split(".")[1] ?? "";
  const displayPrecision = Math.max(2, fractionalPart.replace(/0+$/u, "").length + 1);
  return Number(coveragePercent.toFixed(displayPrecision));
}

export function checkSourceDocstringCoverage(files, minCoveragePercent) {
  const sourceFiles = documentedSourceFiles(files);
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
    coverage_percent: formatCoveragePercent(coveragePercent, minCoveragePercent),
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
  // Every exported binding is public API — a re-exported constant, a frozen
  // lookup table, or a configuration object is just as much a documented surface
  // as an exported function. The previous gate only required docstrings on
  // exported *function* values; the data-contract tier documents them all.
  if (ts.isVariableStatement(node) && hasExportModifier(node)) {
    return node;
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

// Returns the declaration's OWN `/** ... */` docstring comment text, or null.
// The file-level module doc is excluded two ways: by position (a leading comment
// sitting exactly at the module-doc offset is the module banner, not this node's
// doc) and by content (any `@module` comment is a module banner). This is what
// stops the first declaration in a file from silently inheriting the module doc.
function nodeOwnDocstringComment(sourceFile, node) {
  const fullText = sourceFile.getFullText();
  const strippedText = stripShebang(fullText);
  const moduleDocRelativeStart = strippedText.trimStart().startsWith("/**") ? strippedText.indexOf("/**") : -1;
  const moduleDocStart =
    moduleDocRelativeStart === -1 ? -1 : fullText.length - strippedText.length + moduleDocRelativeStart;
  const ranges = ts.getLeadingCommentRanges(fullText, node.pos) ?? [];
  for (const range of ranges) {
    const comment = fullText.slice(range.pos, range.end);
    if (range.pos === moduleDocStart) {
      continue;
    }
    if (comment.startsWith("/**") && !comment.includes("@module")) {
      return comment;
    }
  }
  return null;
}

function hasNodeDocstring(sourceFile, node) {
  return nodeOwnDocstringComment(sourceFile, node) !== null;
}

export function checkExportedDocstringCoverage(files, minCoveragePercent) {
  const missing = [];
  let total = 0;
  let documented = 0;
  for (const absolutePath of documentedSourceFiles(files)) {
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
    coverage_percent: formatCoveragePercent(coveragePercent, minCoveragePercent),
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
  for (const absolutePath of documentedSourceFiles(files)) {
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

function ownerDisplayName(node) {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : "exported_declaration";
}

function simpleMemberName(sourceFile, member) {
  if (ts.isConstructorDeclaration(member)) {
    return "constructor";
  }
  // Non-constructor members reach here only after collectExportedMemberTargets
  // has confirmed they carry a name, so `member.name` is always defined. Plain
  // identifiers use their text directly; string/numeric/computed member names
  // fall back to their verbatim source text.
  return ts.isIdentifier(member.name) ? member.name.text : member.name.getText(sourceFile);
}

// A class member is out of the public-documentation scope when it is explicitly
// `private`/`protected` or uses an ECMAScript `#private` name — those are
// implementation details, not the class's documented contract.
function isNonPublicClassMember(member) {
  const hasNonPublicModifier =
    member.modifiers?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    ) === true;
  return hasNonPublicModifier || (member.name !== undefined && ts.isPrivateIdentifier(member.name));
}

// The documented members of an exported declaration: every interface member,
// every property of an object-literal type alias, and every public
// method/accessor/property (plus a parameterized constructor) of a class. Members
// without a name (index/call/construct signatures) carry no documentable symbol
// and are skipped.
function collectExportedMemberTargets(node) {
  if (ts.isInterfaceDeclaration(node)) {
    return node.members.filter((member) => member.name !== undefined);
  }
  if (ts.isTypeAliasDeclaration(node)) {
    // A type alias always has a `.type`; only object-literal shapes expose
    // per-field members worth documenting (unions/keywords/mapped types do not).
    return ts.isTypeLiteralNode(node.type)
      ? node.type.members.filter((member) => member.name !== undefined)
      : [];
  }
  return node.members.filter((member) => {
    if (isNonPublicClassMember(member)) {
      return false;
    }
    // Methods, accessors, and properties always carry a name; a parameterized
    // constructor documents its inputs. Static blocks, index signatures, and
    // parameterless constructors expose no documentable contract.
    if (
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member) ||
      ts.isPropertyDeclaration(member)
    ) {
      return true;
    }
    return ts.isConstructorDeclaration(member) && member.parameters.length > 0;
  });
}

function isDocumentableMemberOwner(node) {
  return (
    hasExportModifier(node) &&
    (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node))
  );
}

export function checkExportedMemberDocstringCoverage(files, minCoveragePercent) {
  const missing = [];
  let total = 0;
  let documented = 0;
  for (const absolutePath of documentedSourceFiles(files)) {
    const sourceText = loadText(absolutePath);
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true);
    for (const node of sourceFile.statements) {
      if (!isDocumentableMemberOwner(node)) {
        continue;
      }
      const ownerName = ownerDisplayName(node);
      for (const member of collectExportedMemberTargets(node)) {
        total += 1;
        if (hasNodeDocstring(sourceFile, member)) {
          documented += 1;
          continue;
        }
        const start = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile));
        missing.push({
          path: relativeToRepo(absolutePath),
          line: start.line + 1,
          name: `${ownerName}.${simpleMemberName(sourceFile, member)}`,
          reason: "missing_member_docstring",
        });
      }
    }
  }
  const coveragePercent = total === 0 ? 100 : (documented / total) * 100;
  return {
    ok: coveragePercent >= minCoveragePercent,
    total,
    documented,
    missing: missing.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line),
    coverage_percent: formatCoveragePercent(coveragePercent, minCoveragePercent),
    min_coverage_percent: minCoveragePercent,
  };
}

// Function words plus a handful of generic nouns that describe "some declaration"
// rather than THIS declaration. A docstring whose only words are these plus the
// symbol's own name tokens restates the identifier instead of explaining it. The
// set is intentionally tiny so the check fires only on genuinely empty prose.
const DOCSTRING_FILLER_WORDS = new Set([
  "the", "a", "an", "of", "for", "to", "and", "or", "is", "are", "be", "this", "that",
  "these", "those", "it", "its", "in", "on", "by", "with", "as", "from", "into",
  "value", "values",
]);

// Reduces a docstring comment to its plain prose: drops the `/** */` fences, the
// per-line leading `*`, and TSDoc tag markers (`@param`, `{@link}`) while keeping
// the words around them, so a tag-only docstring is still judged on its content.
export function extractDocstringProse(comment) {
  const withoutFences = comment.replace(/^\/\*\*/u, "").replace(/\*\/\s*$/u, "");
  const joined = withoutFences
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*\*?\s?/u, ""))
    .join(" ");
  return joined
    .replace(/\{?@[a-zA-Z]+\}?|\}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

// Splits an identifier (camelCase, PascalCase, snake_case, dotted owner.member)
// into its lowercase word tokens so they can be subtracted from a docstring's
// prose when judging whether the docstring adds information beyond the name.
export function identifierWords(name) {
  return (name ?? "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

// True when a docstring adds nothing beyond the symbol's own name: after removing
// filler words and the identifier's tokens, no meaningful word remains. Catches
// empty (`/** */`) and name-restating (`/** The item id. */` on `itemId`) stubs
// without penalizing terse-but-informative prose (`/** Unique primary key. */`).
export function isTrivialDocstring(comment, symbolName) {
  const nameTokens = new Set(identifierWords(symbolName));
  const meaningful = extractDocstringProse(comment)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .filter((word) => !DOCSTRING_FILLER_WORDS.has(word) && !nameTokens.has(word));
  return meaningful.length === 0;
}

export function checkTrivialDocstrings(files) {
  const violations = [];
  for (const absolutePath of documentedSourceFiles(files)) {
    const sourceText = loadText(absolutePath);
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true);
    const inspect = (node, reportName, triviaName) => {
      const comment = nodeOwnDocstringComment(sourceFile, node);
      if (comment === null || !isTrivialDocstring(comment, triviaName)) {
        return;
      }
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({
        path: relativeToRepo(absolutePath),
        line: start.line + 1,
        name: reportName,
        reason: "trivial_docstring",
      });
    };
    for (const node of sourceFile.statements) {
      const target = exportedDocstringTarget(node);
      if (target) {
        const name = declarationName(target);
        inspect(target, name, name);
      }
      if (isDocumentableMemberOwner(node)) {
        const ownerName = ownerDisplayName(node);
        for (const member of collectExportedMemberTargets(node)) {
          const simple = simpleMemberName(sourceFile, member);
          inspect(member, `${ownerName}.${simple}`, simple);
        }
      }
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

export const SDK_IMPORT_BOUNDARY_BASELINE = "scripts/release/sdk-import-boundary-baseline.json";

function isSdkBoundarySource(relativePath) {
  return (
    relativePath === "src/cli.ts" ||
    relativePath.startsWith("src/cli/") ||
    relativePath === "src/mcp.ts" ||
    relativePath.startsWith("src/mcp/")
  );
}

export function collectSdkBoundarySourceFiles(files) {
  return files.filter((absolutePath) => isSdkBoundarySource(relativeToRepo(absolutePath)));
}

function moduleSpecifierText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function isRequireCallExpression(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require";
}

function importModuleSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier
  ) {
    return moduleSpecifierText(node.moduleSpecifier);
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression
  ) {
    return moduleSpecifierText(node.moduleReference.expression);
  }
  if (
    isRequireCallExpression(node) &&
    node.arguments.length === 1
  ) {
    return moduleSpecifierText(node.arguments[0]);
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    (node.arguments.length === 1 || node.arguments.length === 2)
  ) {
    return moduleSpecifierText(node.arguments[0]);
  }
  return null;
}

function isDynamicImportExpression(node) {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

export function collectUnsupportedDynamicImportExpressions(files) {
  return collectUnsupportedDynamicImportExpressionsFromBoundaryFiles(collectSdkBoundarySourceFiles(files));
}

function collectUnsupportedDynamicImportExpressionsFromBoundaryFiles(boundarySourceFiles) {
  const violations = [];
  for (const absolutePath of boundarySourceFiles) {
    if (!existsSync(absolutePath)) {
      continue;
    }
    const relativeSource = relativeToRepo(absolutePath);
    const sourceText = loadText(absolutePath);
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (isDynamicImportExpression(node)) {
        if (node.arguments.length < 1 || node.arguments.length > 2 || moduleSpecifierText(node.arguments[0]) === null) {
          const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push({
            source: relativeSource,
            line: start.line + 1,
            reason: "computed_dynamic_import",
          });
        }
      }
      if (
        isRequireCallExpression(node) &&
        (node.arguments.length !== 1 || moduleSpecifierText(node.arguments[0]) === null)
      ) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({
          source: relativeSource,
          line: start.line + 1,
          reason: "computed_require",
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations.sort((left, right) => left.source.localeCompare(right.source) || left.line - right.line);
}

export function collectPrivateCoreImportEdges(files) {
  return collectPrivateCoreImportEdgesFromBoundaryFiles(collectSdkBoundarySourceFiles(files));
}

function collectPrivateCoreImportEdgesFromBoundaryFiles(boundarySourceFiles) {
  const edges = [];
  const seen = new Set();
  for (const absolutePath of boundarySourceFiles) {
    if (!existsSync(absolutePath)) {
      continue;
    }
    const relativeSource = relativeToRepo(absolutePath);
    const sourceFile = ts.createSourceFile(absolutePath, loadText(absolutePath), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      const specifier = importModuleSpecifier(node);
      if (specifier === null) {
        ts.forEachChild(node, visit);
        return;
      }
      const resolved = resolveRelativeImport(absolutePath, specifier);
      if (!resolved) {
        ts.forEachChild(node, visit);
        return;
      }
      const relativeImport = relativeToRepo(resolved);
      if (relativeImport.startsWith("src/core/")) {
        const edge = { source: relativeSource, import_path: relativeImport };
        const key = importEdgeKey(edge);
        if (!seen.has(key)) {
          seen.add(key);
          edges.push(edge);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return edges.sort(
    (left, right) => left.source.localeCompare(right.source) || left.import_path.localeCompare(right.import_path),
  );
}

function baselineImportEdgesFromEntries(entries, baselinePath) {
  if (!Array.isArray(entries)) {
    throw new Error(`Invalid SDK import-boundary baseline ${baselinePath}: allowed_private_core_imports must be an array.`);
  }
  const edges = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.source !== "string" || !Array.isArray(entry.imports)) {
      throw new Error(
        `Invalid SDK import-boundary baseline ${baselinePath}: entries must include source and imports fields.`,
      );
    }
    if (!isSdkBoundarySource(entry.source)) {
      throw new Error(
        `Invalid SDK import-boundary baseline ${baselinePath}: source "${entry.source}" is not an SDK boundary source.`,
      );
    }
    for (const importPath of entry.imports) {
      if (typeof importPath !== "string") {
        throw new Error(`Invalid SDK import-boundary baseline ${baselinePath}: imports must be strings.`);
      }
      if (!importPath.startsWith("src/core/")) {
        throw new Error(
          `Invalid SDK import-boundary baseline ${baselinePath}: import "${importPath}" is not a private core import.`,
        );
      }
      edges.push({ source: entry.source, import_path: importPath });
    }
  }
  return edges;
}

function readSdkImportBoundaryBaseline(baselinePath) {
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`Invalid SDK import-boundary baseline ${baselinePath}: expected an object.`);
  }
  if (parsed.version !== 1) {
    throw new Error(`Invalid SDK import-boundary baseline ${baselinePath}: version must be 1.`);
  }
  return baselineImportEdgesFromEntries(parsed.allowed_private_core_imports, baselinePath);
}

function importEdgeKey(edge) {
  return `${edge.source}\u0000${edge.import_path}`;
}

export function checkSdkImportBoundary(
  files = collectTypeScriptFiles(),
  baselinePath = path.join(repoRoot, SDK_IMPORT_BOUNDARY_BASELINE),
) {
  const boundarySourceFiles = collectSdkBoundarySourceFiles(files);
  const actualEdges = collectPrivateCoreImportEdgesFromBoundaryFiles(boundarySourceFiles);
  const unsupportedDynamicImports = collectUnsupportedDynamicImportExpressionsFromBoundaryFiles(boundarySourceFiles);
  let baselineEdges;
  try {
    baselineEdges = readSdkImportBoundaryBaseline(baselinePath);
  } catch (error) {
    return {
      ok: false,
      scanned_file_count: boundarySourceFiles.length,
      actual_edge_count: actualEdges.length,
      baseline_edge_count: null,
      new_private_core_imports: [],
      stale_baseline_imports: [],
      unsupported_dynamic_imports: unsupportedDynamicImports,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const actualKeys = new Set(actualEdges.map(importEdgeKey));
  const baselineKeys = new Set(baselineEdges.map(importEdgeKey));
  const scannedBoundarySources = new Set(boundarySourceFiles.map(relativeToRepo));
  const newPrivateCoreImports = actualEdges.filter((edge) => !baselineKeys.has(importEdgeKey(edge)));
  const staleBaselineImports = baselineEdges
    .filter(
      (edge) =>
        (scannedBoundarySources.has(edge.source) || !existsSync(path.join(repoRoot, edge.source))) &&
        !actualKeys.has(importEdgeKey(edge)),
    )
    .sort((left, right) => left.source.localeCompare(right.source) || left.import_path.localeCompare(right.import_path));
  return {
    ok:
      newPrivateCoreImports.length === 0 &&
      staleBaselineImports.length === 0 &&
      unsupportedDynamicImports.length === 0,
    scanned_file_count: boundarySourceFiles.length,
    actual_edge_count: actualEdges.length,
    baseline_edge_count: baselineEdges.length,
    new_private_core_imports: newPrivateCoreImports,
    stale_baseline_imports: staleBaselineImports,
    unsupported_dynamic_imports: unsupportedDynamicImports,
  };
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

function gitLines(args) {
  const output = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function firstGitLine(args) {
  const [line] = gitLines(args);
  return line ?? null;
}

function resolveOriginDefaultBranchRef() {
  try {
    const branchRef = firstGitLine(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    return branchRef?.startsWith("origin/") ? branchRef : null;
  } catch {
    return null;
  }
}

const CODEFACTOR_BASE_REF_FALLBACKS = ["origin/main", "main", "origin/master", "master", "origin/develop", "develop"];

function resolveCodeFactorBaseRef() {
  const candidates = new Set([resolveOriginDefaultBranchRef(), ...CODEFACTOR_BASE_REF_FALLBACKS].filter(Boolean));
  for (const candidate of candidates) {
    try {
      const mergeBase = firstGitLine(["merge-base", "HEAD", candidate]);
      if (mergeBase) {
        return mergeBase;
      }
    } catch {
      // Try the next locally available base ref.
    }
  }
  return null;
}

function collectChangedRelativePaths() {
  const changed = new Set();
  if (!existsSync(path.join(repoRoot, ".git"))) {
    return { ok: true, files: [] };
  }
  try {
    const baseRef = resolveCodeFactorBaseRef();
    if (baseRef) {
      for (const filePath of gitLines(["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...HEAD`])) {
        changed.add(filePath);
      }
    }
    for (const args of [
      ["diff", "--name-only", "--diff-filter=ACMR"],
      ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    ]) {
      for (const filePath of gitLines(args)) {
        changed.add(filePath);
      }
    }
    if (!baseRef && changed.size === 0) {
      return {
        ok: false,
        files: [],
        error: `Unable to determine committed changed files for CodeFactor parity without origin default branch, ${CODEFACTOR_BASE_REF_FALLBACKS.join(", ")}, or worktree diffs.`,
      };
    }
  } catch {
    return { ok: false, files: [], error: "Unable to inspect git changed files for CodeFactor parity." };
  }
  return { ok: true, files: [...changed].sort((left, right) => left.localeCompare(right)) };
}

function isCodeFactorParityPath(relativePath) {
  if (
    relativePath.startsWith("tests/") ||
    relativePath.endsWith(".d.ts") ||
    /\.(?:spec|test)\.[cm]?tsx?$/u.test(relativePath)
  ) {
    return false;
  }
  if (!/\.(?:[cm]?js|[cm]?ts)$/u.test(relativePath)) {
    return false;
  }
  return (
    relativePath.startsWith("src/") ||
    relativePath.startsWith("packages/") ||
    relativePath.startsWith("scripts/")
  );
}

export function collectCodeFactorParityFiles(changedPaths = collectChangedRelativePaths()) {
  if (!changedPaths.ok) {
    return changedPaths;
  }
  const files = changedPaths.files
    .filter(isCodeFactorParityPath)
    .map((relativePath) => path.join(repoRoot, relativePath))
    .filter((absolutePath) => existsSync(absolutePath) && statSync(absolutePath).isFile());
  return { ok: true, files };
}

export function checkCodeFactorComplexity(maxComplexity, changedPaths = collectChangedRelativePaths()) {
  const parityFiles = collectCodeFactorParityFiles(changedPaths);
  if (!parityFiles.ok) {
    return {
      ok: false,
      scanned_file_count: 0,
      max_complexity: maxComplexity,
      violations: [],
      error: parityFiles.error,
    };
  }
  const violations = checkFunctionComplexity(parityFiles.files, maxComplexity);
  return {
    ok: violations.length === 0,
    scanned_file_count: parityFiles.files.length,
    max_complexity: maxComplexity,
    violations,
  };
}

// Hard budget for the grandfathered ESLint bulk-suppressions baseline
// (`eslint-suppressions.json`). ESLint itself fails when a suppression goes
// stale, so the baseline can only shrink; this budget makes growth impossible
// without a loud, reviewable edit to this gate script. Lower it as the
// baseline burns down — never raise it except when a NEW rule is added to the
// gate and its pre-existing violations are grandfathered in the same change
// (as with sonarjs/cognitive-complexity <= 16, re-baselined 104 -> 180; the
// burn-down of that slice is tracked on the pm-92if epic).
export const MAX_ESLINT_SUPPRESSIONS = 170;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function countEslintSuppressions(suppressionsPath) {
  let raw;
  try {
    raw = readFileSync(suppressionsPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ESLint suppressions budget file ${suppressionsPath}: ${message}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ESLint suppressions budget file ${suppressionsPath}: ${message}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid ESLint suppressions budget file ${suppressionsPath}: expected an object.`);
  }
  let total = 0;
  for (const rules of Object.values(parsed)) {
    if (!isRecord(rules)) {
      throw new Error(`Invalid ESLint suppressions budget file ${suppressionsPath}: expected rule objects.`);
    }
    for (const entry of Object.values(rules)) {
      if (!isRecord(entry) || !Number.isInteger(entry.count) || entry.count < 0) {
        throw new Error(`Invalid ESLint suppressions budget file ${suppressionsPath}: expected non-negative integer counts.`);
      }
      total += entry.count;
    }
  }
  return total;
}

export function checkEslintSuppressionsBudget(maxSuppressions) {
  let total;
  try {
    const suppressionsPath = path.join(repoRoot, "eslint-suppressions.json");
    total = countEslintSuppressions(suppressionsPath);
  } catch (error) {
    return {
      ok: false,
      total: null,
      max_suppressions: maxSuppressions,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ok: total <= maxSuppressions,
    total,
    max_suppressions: maxSuppressions,
  };
}

// Inline gate-silencing pragmas are the quiet way around the mandatory gates:
// an ESLint disable comment mutes lint, a v8/c8/istanbul coverage pragma
// removes lines from the 100% coverage surface, and a jscpd ignore block hides
// duplication from the clone gate — all without touching any config file a
// reviewer would watch. Budget them exactly like the bulk-suppressions
// baseline: hard ceilings enforced here, lowered as usage burns down — never
// raise them. (Pragma spellings are deliberately paraphrased here so this
// comment does not count against its own budgets.)
export const MAX_INLINE_ESLINT_DISABLES = 5;
export const MAX_BROAD_ESLINT_DISABLES = 0;
export const MAX_COVERAGE_IGNORE_PRAGMAS = 496;
export const MAX_JSCPD_IGNORE_PRAGMAS = 0;

// Pragma-bearing surfaces: every directory ESLint lints, coverage measures, or
// jscpd scans. Roots are skipped when absent so sparse fixtures still scan.
const PRAGMA_SCAN_ROOTS = ["src", "tests", "packages", "scripts", "plugins", "docs/examples"];

export function collectPragmaScanFiles() {
  const matcher = (absolutePath) =>
    (absolutePath.endsWith(".ts") && !absolutePath.endsWith(".d.ts")) ||
    absolutePath.endsWith(".mjs") ||
    absolutePath.endsWith(".js") ||
    absolutePath.endsWith(".cjs");
  const files = PRAGMA_SCAN_ROOTS.map((segment) => path.join(repoRoot, segment))
    .filter((root) => existsSync(root))
    .flatMap((root) =>
      walkFiles(root, matcher, [], {
        shouldSkipDirectory: (absolutePath) => path.basename(absolutePath) === "node_modules",
      }),
    );
  return files.sort((left, right) => left.localeCompare(right));
}

export function readPragmaScanTexts(files) {
  return files.map((absolutePath) => ({ path: absolutePath, text: loadText(absolutePath) }));
}

export function countPragmaMatchesInTexts(scanTexts, pattern) {
  const globalPattern = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  let total = 0;
  for (const scanText of scanTexts) {
    const matches = scanText.text.match(globalPattern);
    if (matches) {
      total += matches.length;
    }
  }
  return total;
}

// Pattern sources are assembled from fragments so this gate and its spec
// fixtures never count their own pattern literals as pragma usage.
export function checkInlinePragmaBudgets(budgets = {}, files = collectPragmaScanFiles()) {
  const resolvedBudgets = budgets ?? {};
  const checks = [
    [
      "inline_eslint_disables",
      "eslint-" + "disable-(?:next-line|line)\\b",
      resolvedBudgets.maxInlineEslintDisables ?? MAX_INLINE_ESLINT_DISABLES,
    ],
    [
      "broad_eslint_disables",
      "eslint-" + "disable\\b(?!-(?:next-line|line)\\b)",
      resolvedBudgets.maxBroadEslintDisables ?? MAX_BROAD_ESLINT_DISABLES,
    ],
    [
      "coverage_ignore_pragmas",
      "(?:v8|c8|istanbul) " + "ignore",
      resolvedBudgets.maxCoverageIgnorePragmas ?? MAX_COVERAGE_IGNORE_PRAGMAS,
    ],
    [
      "jscpd_ignore_pragmas",
      "jscpd:" + "ignore-" + "start",
      resolvedBudgets.maxJscpdIgnorePragmas ?? MAX_JSCPD_IGNORE_PRAGMAS,
    ],
  ];
  const report = { ok: true, scanned_file_count: files.length, budgets: {} };
  let scanTexts;
  try {
    scanTexts = readPragmaScanTexts(files);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.ok = false;
    report.error = message;
    for (const [key, , max] of checks) {
      report.budgets[key] = { ok: false, total: null, max };
    }
    return report;
  }
  for (const [key, patternSource, max] of checks) {
    const total = countPragmaMatchesInTexts(scanTexts, new RegExp(patternSource, "g"));
    const ok = total <= max;
    report.ok = report.ok && ok;
    report.budgets[key] = { ok, total, max };
  }
  return report;
}

export function usage() {
  console.log(`Usage:
  node scripts/release/static-quality-gate.mjs [--json]
    [--max-lines 3400]
    [--max-lines-tests 7000]
    [--max-complexity 260]
    [--max-codefactor-complexity 16]
    [--max-files-per-dir 120]
    [--duplicate-window 24]
    [--max-duplicate-chunks 8]
    [--min-docstring-coverage 100]
    [--min-exported-docstring-coverage 100]
    [--min-member-docstring-coverage 100]
    [--max-eslint-suppressions ${MAX_ESLINT_SUPPRESSIONS}]
    [--max-inline-lint-disables ${MAX_INLINE_ESLINT_DISABLES}]
    [--max-broad-lint-disables ${MAX_BROAD_ESLINT_DISABLES}]
    [--max-coverage-ignore-pragmas ${MAX_COVERAGE_IGNORE_PRAGMAS}]
    [--max-jscpd-ignore-pragmas ${MAX_JSCPD_IGNORE_PRAGMAS}]

Runs strict static quality checks for dead/orphan modules, duplicate chunks, complexity,
file-length limits, docstring coverage across src/ and packages/ (module headers, exported
declarations incl. consts, and members of exported interfaces/type aliases/classes), rejection
of boilerplate and name-restating docstrings, directory organization density, the ESLint
bulk-suppressions baseline budget, and hard budgets on inline gate-silencing pragmas
(ESLint disable comments, coverage-ignore pragmas, jscpd ignores). Changed shipped/script files
also get a CodeFactor-parity complexity check so branch-local issues fail before push. The
SDK import-boundary ratchet compares src/cli + src/mcp private src/core imports against
${SDK_IMPORT_BOUNDARY_BASELINE}; new private imports, computed dynamic imports, and stale
baseline entries all fail.
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

function parseQualityThresholds(flags) {
  const thresholds = {
    maxSrcLines: parseNumberFlag(flags, "max-lines", 3400),
    maxTestLines: parseNumberFlag(flags, "max-lines-tests", 7000),
    maxComplexity: parseNumberFlag(flags, "max-complexity", 260),
    maxCodeFactorComplexity: parseNumberFlag(flags, "max-codefactor-complexity", 16),
    maxFilesPerDirectory: parseNumberFlag(flags, "max-files-per-dir", 120),
    duplicateWindow: parseNumberFlag(flags, "duplicate-window", 24),
    maxDuplicateChunks: parseNumberFlag(flags, "max-duplicate-chunks", 8),
    minDocstringCoverage: parseNumberFlag(flags, "min-docstring-coverage", 100),
    minExportedDocstringCoverage: parseNumberFlag(flags, "min-exported-docstring-coverage", 100),
    minMemberDocstringCoverage: parseNumberFlag(flags, "min-member-docstring-coverage", 100),
    maxEslintSuppressions: parseNumberFlag(flags, "max-eslint-suppressions", MAX_ESLINT_SUPPRESSIONS),
    maxInlineEslintDisables: parseNumberFlag(flags, "max-inline-lint-disables", MAX_INLINE_ESLINT_DISABLES),
    maxBroadEslintDisables: parseNumberFlag(flags, "max-broad-lint-disables", MAX_BROAD_ESLINT_DISABLES),
    maxCoverageIgnorePragmas: parseNumberFlag(flags, "max-coverage-ignore-pragmas", MAX_COVERAGE_IGNORE_PRAGMAS),
    maxJscpdIgnorePragmas: parseNumberFlag(flags, "max-jscpd-ignore-pragmas", MAX_JSCPD_IGNORE_PRAGMAS),
  };
  if (thresholds.duplicateWindow < 5) {
    fail("--duplicate-window must be >= 5.");
  }
  return thresholds;
}

function buildQualityReport(files, duplicateScopeFiles, thresholds) {
  const fileLengthViolations = checkFileLength(files, thresholds.maxSrcLines, thresholds.maxTestLines);
  const directoryViolations = checkDirectoryLoad(files, thresholds.maxFilesPerDirectory);
  const duplicateViolations = checkDuplicateChunks(
    duplicateScopeFiles,
    thresholds.duplicateWindow,
    thresholds.maxDuplicateChunks,
  );
  const orphanViolations = checkOrphanSourceModules(files);
  const complexityViolations = checkFunctionComplexity(files, thresholds.maxComplexity);
  const sourceDocstringCoverage = checkSourceDocstringCoverage(files, thresholds.minDocstringCoverage);
  const exportedDocstringCoverage = checkExportedDocstringCoverage(files, thresholds.minExportedDocstringCoverage);
  const memberDocstringCoverage = checkExportedMemberDocstringCoverage(files, thresholds.minMemberDocstringCoverage);
  const boilerplateDocstringViolations = checkDocstringBoilerplate(files);
  const trivialDocstringViolations = checkTrivialDocstrings(files);
  const eslintSuppressionsBudget = checkEslintSuppressionsBudget(thresholds.maxEslintSuppressions);
  const inlinePragmaBudgets = checkInlinePragmaBudgets(thresholds);
  const codeFactorComplexity = checkCodeFactorComplexity(thresholds.maxCodeFactorComplexity);
  const sdkImportBoundary = checkSdkImportBoundary(files);
  return {
    ok:
      eslintSuppressionsBudget.ok &&
      inlinePragmaBudgets.ok &&
      codeFactorComplexity.ok &&
      sdkImportBoundary.ok &&
      fileLengthViolations.length === 0 &&
      directoryViolations.length === 0 &&
      duplicateViolations.length <= thresholds.maxDuplicateChunks &&
      orphanViolations.length === 0 &&
      complexityViolations.length === 0 &&
      sourceDocstringCoverage.ok &&
      exportedDocstringCoverage.ok &&
      memberDocstringCoverage.ok &&
      boilerplateDocstringViolations.length === 0 &&
      trivialDocstringViolations.length === 0,
    scanned: {
      file_count: files.length,
      duplicate_scope_file_count: duplicateScopeFiles.length,
      sdk_boundary_file_count: sdkImportBoundary.scanned_file_count,
      duplicate_window_lines: thresholds.duplicateWindow,
      source_docstring_coverage_percent: sourceDocstringCoverage.coverage_percent,
      exported_docstring_coverage_percent: exportedDocstringCoverage.coverage_percent,
      member_docstring_coverage_percent: memberDocstringCoverage.coverage_percent,
    },
    thresholds: {
      max_src_lines: thresholds.maxSrcLines,
      max_test_lines: thresholds.maxTestLines,
      max_complexity: thresholds.maxComplexity,
      max_codefactor_complexity: thresholds.maxCodeFactorComplexity,
      max_files_per_dir: thresholds.maxFilesPerDirectory,
      max_duplicate_chunks: thresholds.maxDuplicateChunks,
      max_eslint_suppressions: thresholds.maxEslintSuppressions,
      max_inline_eslint_disables: thresholds.maxInlineEslintDisables,
      max_broad_eslint_disables: thresholds.maxBroadEslintDisables,
      max_coverage_ignore_pragmas: thresholds.maxCoverageIgnorePragmas,
      max_jscpd_ignore_pragmas: thresholds.maxJscpdIgnorePragmas,
      min_docstring_coverage_percent: thresholds.minDocstringCoverage,
      min_exported_docstring_coverage_percent: thresholds.minExportedDocstringCoverage,
      min_member_docstring_coverage_percent: thresholds.minMemberDocstringCoverage,
    },
    violations: {
      file_length: fileLengthViolations,
      directory_load: directoryViolations,
      duplicate_chunks: duplicateViolations,
      orphan_modules: orphanViolations,
      complexity: complexityViolations,
      source_docstrings: sourceDocstringCoverage.missing,
      exported_docstrings: exportedDocstringCoverage.missing,
      member_docstrings: memberDocstringCoverage.missing,
      boilerplate_docstrings: boilerplateDocstringViolations,
      trivial_docstrings: trivialDocstringViolations,
      codefactor_complexity: codeFactorComplexity.violations,
      sdk_import_boundary: {
        new_private_core_imports: sdkImportBoundary.new_private_core_imports,
        stale_baseline_imports: sdkImportBoundary.stale_baseline_imports,
        unsupported_dynamic_imports: sdkImportBoundary.unsupported_dynamic_imports,
      },
    },
    source_docstrings: sourceDocstringCoverage,
    exported_docstrings: exportedDocstringCoverage,
    member_docstrings: memberDocstringCoverage,
    eslint_suppressions: eslintSuppressionsBudget,
    inline_pragmas: inlinePragmaBudgets,
    codefactor_complexity: codeFactorComplexity,
    sdk_import_boundary: sdkImportBoundary,
  };
}

function printViolationCount(label, count) {
  if (count > 0) {
    console.error(`- ${label} violations: ${count}`);
  }
}

function printDocstringCoverageFailure(label, coverage) {
  if (!coverage.ok) {
    console.error(
      `- ${label} coverage: ${coverage.coverage_percent}% ` +
        `< ${coverage.min_coverage_percent}% (${coverage.missing.length} missing)`,
    );
  }
}

function printEslintSuppressionsFailure(eslintSuppressions) {
  if (eslintSuppressions.ok) {
    return;
  }
  if (eslintSuppressions.error) {
    console.error(`- eslint_suppressions budget failed: ${eslintSuppressions.error}`);
    return;
  }
  console.error(
    `- eslint_suppressions budget exceeded: ${eslintSuppressions.total} ` +
      `> ${eslintSuppressions.max_suppressions} (burn the baseline down, never grow it)`,
  );
}

function printInlinePragmaFailures(inlinePragmas) {
  if (inlinePragmas.error) {
    console.error(`- inline_pragmas scan failed: ${inlinePragmas.error}`);
    return;
  }
  for (const [key, budget] of Object.entries(inlinePragmas.budgets)) {
    if (!budget.ok) {
      console.error(
        `- ${key} budget exceeded: ${budget.total} > ${budget.max} ` +
          `(remove the inline pragma; never raise the budget)`,
      );
    }
  }
}

function printQualityFailureSummary(report) {
  console.error("Static quality gate failed.");
  printViolationCount("file_length", report.violations.file_length.length);
  printViolationCount("directory_load", report.violations.directory_load.length);
  if (report.violations.duplicate_chunks.length > report.thresholds.max_duplicate_chunks) {
    printViolationCount("duplicate_chunks", report.violations.duplicate_chunks.length);
  }
  printViolationCount("orphan_modules", report.violations.orphan_modules.length);
  printViolationCount("complexity", report.violations.complexity.length);
  printDocstringCoverageFailure("source_docstring", report.source_docstrings);
  printDocstringCoverageFailure("exported_docstring", report.exported_docstrings);
  printDocstringCoverageFailure("member_docstring", report.member_docstrings);
  printViolationCount("boilerplate_docstring", report.violations.boilerplate_docstrings.length);
  if (report.violations.trivial_docstrings.length > 0) {
    console.error(
      `- trivial_docstring violations: ${report.violations.trivial_docstrings.length} ` +
        `(docstring restates the symbol name; describe purpose/units/invariants instead)`,
    );
  }
  if (report.codefactor_complexity.error) {
    console.error(`- codefactor_complexity scan failed: ${report.codefactor_complexity.error}`);
  } else {
    printViolationCount("codefactor_complexity", report.violations.codefactor_complexity.length);
  }
  if (report.sdk_import_boundary.error) {
    console.error(`- sdk_import_boundary scan failed: ${report.sdk_import_boundary.error}`);
    printViolationCount(
      "sdk_import_boundary unsupported_dynamic_import",
      report.violations.sdk_import_boundary.unsupported_dynamic_imports.length,
    );
  } else {
    printViolationCount(
      "sdk_import_boundary new_private_core_import",
      report.violations.sdk_import_boundary.new_private_core_imports.length,
    );
    printViolationCount(
      "sdk_import_boundary stale_baseline_import",
      report.violations.sdk_import_boundary.stale_baseline_imports.length,
    );
    printViolationCount(
      "sdk_import_boundary unsupported_dynamic_import",
      report.violations.sdk_import_boundary.unsupported_dynamic_imports.length,
    );
  }
  printEslintSuppressionsFailure(report.eslint_suppressions);
  printInlinePragmaFailures(report.inline_pragmas);
}

function printQualityReport(report, outputJson) {
  if (outputJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.ok) {
    console.log("Static quality gate passed.");
  } else {
    printQualityFailureSummary(report);
  }
}

export function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    usage();
    return;
  }

  const outputJson = flagBool(flags, "json", false);
  const thresholds = parseQualityThresholds(flags);

  const files = collectTypeScriptFiles();
  const duplicateScopeFiles = files.filter((absolutePath) => {
    const relative = relativeToRepo(absolutePath);
    return relative.startsWith("src/core/") || relative.startsWith("src/sdk/") || relative.startsWith("src/cli/");
  });
  const report = buildQualityReport(files, duplicateScopeFiles, thresholds);
  printQualityReport(report, outputJson);

  if (!report.ok) {
    process.exitCode = 1;
  }
}

/* c8 ignore start -- CLI auto-run guard; logic covered via exported main() */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
/* c8 ignore stop */
