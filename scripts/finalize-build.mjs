#!/usr/bin/env node

import { chmod, glob, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const DECLARATION_CONTINUATION_DELIMITERS = new Set([
  ts.SyntaxKind.ColonToken,
  ts.SyntaxKind.CommaToken,
  ts.SyntaxKind.SemicolonToken,
  ts.SyntaxKind.OpenBraceToken,
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.AmpersandToken,
]);
const DECLARATION_PUNCTUATION = new Set([
  ...DECLARATION_CONTINUATION_DELIMITERS,
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.OpenParenToken,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.OpenBracketToken,
  ts.SyntaxKind.CloseBracketToken,
]);

/** Remove declaration indentation and delimiter whitespace, retaining type tokens, ASI boundaries, literals and JSDoc bytes. */
function compactDeclaration(source) {
  const file = ts.createSourceFile("declaration.d.ts", source, ts.ScriptTarget.Latest, true);
  const literals = new Map();
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralTypeNode(node)) {
      literals.set(node.getStart(file), node.end);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const parts = [];
  let lineStart = true;
  let previousKind;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const start = scanner.getTokenPos();
    const end = literals.get(start) ?? scanner.getTextPos();
    const text = source.slice(start, end);
    const whitespace = kind === ts.SyntaxKind.WhitespaceTrivia || kind === ts.SyntaxKind.NewLineTrivia;
    const nextKind = whitespace ? scanner.lookAhead(() => {
      let next = scanner.scan();
      while (next === ts.SyntaxKind.WhitespaceTrivia || next === ts.SyntaxKind.NewLineTrivia) next = scanner.scan();
      return next;
    }) : undefined;
    // These delimiters already terminate or require a continuation; a newline
    // after any other token may be an automatic semicolon. Keep comment line
    // boundaries too, so TypeScript still attaches each JSDoc to its member.
    const removableWhitespace = (kind === ts.SyntaxKind.WhitespaceTrivia &&
      (lineStart || DECLARATION_PUNCTUATION.has(previousKind) || DECLARATION_PUNCTUATION.has(nextKind))) ||
      (kind === ts.SyntaxKind.NewLineTrivia && DECLARATION_CONTINUATION_DELIMITERS.has(previousKind) &&
        nextKind !== ts.SyntaxKind.SingleLineCommentTrivia && nextKind !== ts.SyntaxKind.MultiLineCommentTrivia);
    if (!removableWhitespace) parts.push(text);
    if (kind !== ts.SyntaxKind.WhitespaceTrivia) {
      lineStart = /[\r\n]$/u.test(text);
    }
    if (!whitespace) previousKind = kind;
    scanner.setTextPos(end);
  }
  return parts.join("");
}

/** Compact all emitted declarations without editing source or altering type literal contents. */
async function compactDeclarationOutputs(directory) {
  for await (const relative of glob("**/*.d.ts", { cwd: directory })) {
    const target = path.join(directory, relative);
    const source = await readFile(target, "utf8");
    await writeFile(target, compactDeclaration(source));
  }
}

/** Check optional emitted executables before chmod, treating only absent files as optional and propagating other stat failures. */
async function outputExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

/** Compact redundant runtime syntax without changing identifiers, module boundaries, or declarations. */
export async function compactRuntimeOutputs(directory) {
  const entryPoints = [];
  for await (const relative of glob("**/*.js", {
    cwd: directory,
    exclude: ["cli-bundle/**"],
  })) {
    entryPoints.push(relative);
  }
  if (entryPoints.length === 0) return;
  // esbuild resolves source files through symlinks; use the same physical root
  // for output paths so composed source maps remain relative and stable.
  const outputRoot = await realpath(directory);
  await build({
    entryPoints: entryPoints.map((relative) => path.join(outputRoot, relative)),
    outdir: outputRoot,
    outbase: outputRoot,
    allowOverwrite: true,
    bundle: false,
    platform: "node",
    format: "esm",
    target: "node22",
    minifyWhitespace: true,
    minifyIdentifiers: false,
    minifySyntax: true,
    sourcemap: true,
    sourcesContent: true,
    legalComments: "inline",
    logLevel: "silent",
  });
}

/** Finalize executable modes and the semantically identical compact public SDK manifest. */
export async function main(repoRoot = process.cwd()) {
  await compactRuntimeOutputs(path.join(repoRoot, "dist"));
  await compactDeclarationOutputs(path.join(repoRoot, "dist"));
  const executableOutputs = [
    path.join(repoRoot, "dist", "cli.js"),
    path.join(repoRoot, "dist", "mcp", "server.js"),
    path.join(repoRoot, "dist", "mcp", "http-server.js"),
  ];

  for (const outputPath of executableOutputs) {
    if (await outputExists(outputPath)) {
      await chmod(outputPath, 0o755);
    }
  }

  // Keep the checked-in compatibility manifest readable, while distributing
  // identical JSON data without indentation through its stable public export.
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "sdk", "public-surface.json"), "utf8"),
  );
  await writeFile(
    path.join(repoRoot, "dist", "sdk", "public-surface.json"),
    `${JSON.stringify(manifest)}\n`,
    "utf8",
  );
}

/* c8 ignore start -- CLI auto-run guard; logic covered via exported main() */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
/* c8 ignore stop */
