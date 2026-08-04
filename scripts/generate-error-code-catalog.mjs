#!/usr/bin/env node
/**
 * Generate the public error-code catalog from literal structured guidance
 * declarations so the vocabulary cannot drift from executable code.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const EXIT_CODE_VALUES = new Map([
  ["SUCCESS", 0],
  ["GENERIC_FAILURE", 1],
  ["USAGE", 2],
  ["NOT_FOUND", 3],
  ["CONFLICT", 4],
  ["DEPENDENCY_FAILED", 5],
]);

const EXIT_CODE_CLASSES = new Map([
  [1, "generic_failure"],
  [2, "usage"],
  [3, "not_found"],
  [4, "conflict"],
  [5, "dependency_failed"],
]);

const FALLBACK_EXIT_CODES_BY_CODE = new Map([["unknown_error", 1]]);

function resolveExplicitExitCode(property) {
  const declaration = ts.findAncestor(
    property,
    (node) =>
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "PmCliError",
  );
  if (!declaration || !ts.isNewExpression(declaration)) return undefined;
  const expression = declaration.arguments?.[1];
  if (expression && ts.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (
    expression &&
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "EXIT_CODE"
  ) {
    return EXIT_CODE_VALUES.get(expression.name.text);
  }
  return undefined;
}

function renderGeneratedStringProperty(name, value) {
  const literal = JSON.stringify(value);
  const oneLine = `    ${name}: ${literal},`;
  return oneLine.length <= 80
    ? [oneLine]
    : [`    ${name}:`, `      ${literal},`];
}

function renderGeneratedStringArray(name, values) {
  const literals = values.map((value) => JSON.stringify(value));
  const oneLine = `    ${name}: [${literals.join(", ")}],`;
  return oneLine.length <= 80
    ? [oneLine]
    : [
        `    ${name}: [`,
        ...literals.map((literal) => `      ${literal},`),
        "    ],",
      ];
}

async function discoverSourceFiles(sourceRoot, outputPath) {
  const sourceFiles = [];
  const pendingDirectories = [sourceRoot];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(absolute);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        absolute !== outputPath
      ) {
        sourceFiles.push(absolute);
      }
    }
  }
  return sourceFiles.sort();
}

function collectSourceDeclarations(sourceFile, sourcePath, sourcesByCode) {
  const visit = (node) => {
    const property = ts.isPropertyAssignment(node) ? node : undefined;
    const codeInitializer =
      property && ts.isAsExpression(property.initializer)
        ? property.initializer.expression
        : property?.initializer;
    const codeName =
      property &&
      ((ts.isIdentifier(property.name) && property.name.text === "code") ||
        (ts.isStringLiteral(property.name) && property.name.text === "code"));
    if (
      property &&
      codeName &&
      codeInitializer &&
      ts.isStringLiteral(codeInitializer) &&
      /^[a-z][a-z0-9_]*$/.test(codeInitializer.text)
    ) {
      const code = codeInitializer.text;
      const entry = sourcesByCode.get(code) ?? {
        sources: new Set(),
        explicitExitCodes: new Set(),
      };
      entry.sources.add(sourcePath);
      const explicitExitCode = resolveExplicitExitCode(property);
      if (explicitExitCode !== undefined) {
        entry.explicitExitCodes.add(explicitExitCode);
      }
      sourcesByCode.set(code, entry);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function resolveFallbackExitCode(code) {
  const explicitFallback = FALLBACK_EXIT_CODES_BY_CODE.get(code);
  if (explicitFallback !== undefined) return explicitFallback;
  if (code.includes("not_found") || code.startsWith("missing_item")) return 3;
  if (code.includes("conflict") || code.includes("already_")) return 4;
  if (code.includes("dependency_failed")) return 5;
  if (
    code.includes("invalid") ||
    code.includes("unknown") ||
    code.includes("required") ||
    code.includes("usage")
  ) {
    return 2;
  }
  return 1;
}

function inferEmittingCommands(sources) {
  const commands = new Set();
  let hasCrossCuttingSource = false;
  for (const source of sources) {
    const commandMatch = source.match(/^cli\/commands\/([^/]+)\.ts$/u);
    const lifecycleMatch = source.match(/^sdk\/lifecycle\/([^/]+)\.ts$/u);
    const queryMatch = source.match(/^sdk\/query\/([^/]+)\.ts$/u);
    const matched = commandMatch ?? lifecycleMatch ?? queryMatch;
    if (matched?.[1]) {
      commands.add(matched[1]);
    } else {
      hasCrossCuttingSource = true;
    }
  }
  if (hasCrossCuttingSource) commands.add("*");
  return [...commands].sort();
}

async function readStabilityLedger(stabilityPath) {
  const content = await readFile(stabilityPath, "utf8").catch((error) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  });
  if (content === null) return null;
  const parsed = JSON.parse(content);
  if (
    parsed?.schema_version !== 1 ||
    !Array.isArray(parsed.stable_codes) ||
    parsed.stable_codes.some((code) => typeof code !== "string")
  ) {
    throw new Error("Invalid error-code stability ledger.");
  }
  return new Set(parsed.stable_codes);
}

function renderCatalogRow(code, entry, stableCodes) {
  if (entry.explicitExitCodes.size > 1) {
    throw new Error(
      `Conflicting explicit exit codes for ${code}: ${[...entry.explicitExitCodes].sort((left, right) => left - right).join(", ")}`,
    );
  }
  const exitCode =
    [...entry.explicitExitCodes][0] ?? resolveFallbackExitCode(code);
  const errorClass = EXIT_CODE_CLASSES.get(exitCode);
  if (!errorClass) {
    throw new Error(`Unsupported public exit code for ${code}: ${exitCode}`);
  }
  const meaning = `${code.replaceAll("_", " ")} condition.`;
  return [
    "  {",
    `    code: ${JSON.stringify(code)},`,
    ...renderGeneratedStringProperty(
      "meaning",
      meaning[0].toUpperCase() + meaning.slice(1),
    ),
    `    stability: ${JSON.stringify(stableCodes.has(code) ? "stable" : "provisional")},`,
    `    exit_code: ${exitCode},`,
    `    class: ${JSON.stringify(errorClass)},`,
    "    recovery:",
    '      "Inspect the structured error guidance and retry the suggested command.",',
    ...renderGeneratedStringArray("sources", [...entry.sources]),
    ...renderGeneratedStringArray(
      "emitting_commands",
      inferEmittingCommands(entry.sources),
    ),
    "  },",
  ].join("\n");
}

/** Generate or verify the exhaustive error vocabulary for one repository root. */
export async function main(
  root = repositoryRoot,
  args = process.argv.slice(2),
) {
  const sourceRoot = path.join(root, "src");
  const outputPath = path.join(
    sourceRoot,
    "sdk",
    "generated-error-code-catalog.ts",
  );
  const stabilityPath = path.join(root, "scripts", "error-code-stability.json");
  const sourcesByCode = new Map();
  for (const absolute of await discoverSourceFiles(sourceRoot, outputPath)) {
    const content = await readFile(absolute, "utf8");
    collectSourceDeclarations(
      ts.createSourceFile(absolute, content, ts.ScriptTarget.Latest, true),
      path.relative(sourceRoot, absolute).replaceAll(path.sep, "/"),
      sourcesByCode,
    );
  }

  const discoveredCodes = [...sourcesByCode.keys()].sort();
  let stableCodes = await readStabilityLedger(stabilityPath);
  const shouldCreateStabilityLedger = stableCodes === null;
  if (stableCodes === null) {
    if (args.includes("--check")) {
      throw new Error("Error-code stability ledger is missing.");
    }
    stableCodes = new Set(discoveredCodes);
  }
  const removedStableCodes = [...stableCodes].filter(
    (code) => !sourcesByCode.has(code),
  );
  if (removedStableCodes.length > 0) {
    throw new Error(
      `Stable error codes cannot be removed without an explicit compatibility-ledger change: ${removedStableCodes.join(", ")}`,
    );
  }

  const rows = [...sourcesByCode.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, entry]) => renderCatalogRow(code, entry, stableCodes));

  if (shouldCreateStabilityLedger) {
    await mkdir(path.dirname(stabilityPath), { recursive: true });
    await writeFile(
      stabilityPath,
      `${JSON.stringify({ schema_version: 1, stable_codes: discoveredCodes }, null, 2)}\n`,
      "utf8",
    );
  }

  const generated = `/**
 * @module sdk/generated-error-code-catalog
 *
 * Generated by scripts/generate-error-code-catalog.mjs. Do not edit manually.
 */
import { definePmErrorCodeCatalog } from "./error-code-catalog.js";

/** Exhaustive catalog generated from literal error guidance declarations. */
export const PM_ERROR_CODE_CATALOG = definePmErrorCodeCatalog([
${rows.join("\n")}
]);
`;

  if (args.includes("--check")) {
    const existing = await readFile(outputPath, "utf8").catch(() => "");
    if (existing !== generated) {
      throw new Error(
        "Generated error-code catalog is stale. Run pnpm contracts:errors:update.",
      );
    }
    return;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated, "utf8");
}

/* c8 ignore start -- CLI auto-run guard; logic is covered through main(). */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
/* c8 ignore stop */
