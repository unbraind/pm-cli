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

const FALLBACK_EXIT_CODES_BY_CODE = new Map([
  ["unknown_error", 1],
  ["collection_transposed_subcommand", 2],
  ["history_author_acknowledge_selector_conflict", 2],
  ["history_author_acknowledge_target_not_actionable", 2],
  ["history_author_acknowledge_target_unreadable", 2],
]);

const ADDITIONAL_EMITTING_COMMANDS_BY_CODE = new Map([
  ["acceptance_criteria_mutation_conflict", ["update-many"]],
]);

const QUERY_EMITTING_COMMAND_BY_MODULE = new Map([
  ["search-contracts", "search"],
]);

const GENERATED_CATALOG_PART_COUNT = 2;

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
  return oneLine.length <= 100
    ? [oneLine]
    : [
        `    ${name}: [`,
        ...literals.map((literal) => `      ${literal},`),
        "    ],",
      ];
}

function renderOwnedStates(states) {
  if (states.length === 0) return [];
  return [
    "    owned_states: [",
    ...states.map(
      (state) =>
        `      { state: ${JSON.stringify(state.state)}, probe_id: ${JSON.stringify(state.probe_id)}, entrypoints: [${state.entrypoints.map((entrypoint) => JSON.stringify(entrypoint)).join(", ")}], expected_exit_class: ${JSON.stringify(state.expected_exit_class)} },`,
    ),
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
        absolute !== outputPath &&
        !/^generated-error-code-catalog-part-\d+\.ts$/u.test(entry.name)
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

function inferEmittingCommands(code, sources) {
  const commands = new Set();
  let hasCrossCuttingSource = false;
  for (const source of sources) {
    const commandMatch = source.match(/^cli\/commands\/([^/]+)\.ts$/u);
    const lifecycleMatch = source.match(/^sdk\/lifecycle\/([^/]+)\.ts$/u);
    const queryMatch = source.match(/^sdk\/query\/([^/]+)\.ts$/u);
    const matched = commandMatch ?? lifecycleMatch ?? queryMatch;
    if (matched?.[1]) {
      commands.add(
        queryMatch
          ? (QUERY_EMITTING_COMMAND_BY_MODULE.get(matched[1]) ?? matched[1])
          : matched[1],
      );
    } else {
      hasCrossCuttingSource = true;
    }
  }
  for (const command of ADDITIONAL_EMITTING_COMMANDS_BY_CODE.get(code) ?? []) {
    commands.add(command);
  }
  if (hasCrossCuttingSource) commands.add("*");
  return [...commands].sort();
}

function isValidatedRecord(value, validateEntry) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, entry]) => validateEntry(key, entry))
  );
}

function isReachabilityStateDeclaration(state) {
  return (
    typeof state === "object" &&
    state !== null &&
    /^[a-z][a-z0-9_]*$/.test(state.state) &&
    /^[a-z][a-z0-9-]*$/.test(state.probe_id) &&
    Array.isArray(state.entrypoints) &&
    state.entrypoints.length > 0 &&
    state.entrypoints.every(
      (entrypoint) =>
        typeof entrypoint === "string" && entrypoint.trim().length > 0,
    ) &&
    [...EXIT_CODE_CLASSES.values()].includes(state.expected_exit_class)
  );
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
    (parsed?.schema_version !== 1 && parsed?.schema_version !== 2) ||
    !Array.isArray(parsed.stable_codes) ||
    parsed.stable_codes.some((code) => typeof code !== "string")
  ) {
    throw new Error("Invalid error-code stability ledger.");
  }
  if (parsed.schema_version === 1) {
    return {
      stableCodes: new Set(parsed.stable_codes),
      aliases: new Map(),
      exitCodes: new Map(),
      needsMigration: true,
    };
  }
  if (
    !isValidatedRecord(
      parsed.aliases,
      (alias, canonical) =>
        /^[a-z][a-z0-9_]*$/.test(alias) &&
        typeof canonical === "string" &&
        /^[a-z][a-z0-9_]*$/.test(canonical),
    ) ||
    !isValidatedRecord(
      parsed.exit_codes,
      (code, exitCode) =>
        /^[a-z][a-z0-9_]*$/.test(code) && Number.isInteger(exitCode),
    )
  ) {
    throw new Error("Invalid error-code stability ledger.");
  }
  return {
    stableCodes: new Set(parsed.stable_codes),
    aliases: new Map(Object.entries(parsed.aliases)),
    exitCodes: new Map(Object.entries(parsed.exit_codes)),
    needsMigration: false,
  };
}

async function readReachabilityLedger(reachabilityPath) {
  const content = await readFile(reachabilityPath, "utf8").catch((error) => {
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
  if (content === null) return new Map();
  const parsed = JSON.parse(content);
  if (
    parsed?.schema_version !== 1 ||
    !isValidatedRecord(
      parsed.codes,
      (code, states) =>
        /^[a-z][a-z0-9_]*$/.test(code) &&
        Array.isArray(states) &&
        states.every(isReachabilityStateDeclaration),
    )
  ) {
    throw new Error("Invalid error-code reachability ledger.");
  }
  return new Map(Object.entries(parsed.codes));
}

function resolveCatalogExitCode(code, entry, ledger, allowMissingStableExit) {
  if (entry.explicitExitCodes.size > 1) {
    throw new Error(
      `Conflicting explicit exit codes for ${code}: ${[...entry.explicitExitCodes].sort((left, right) => left - right).join(", ")}`,
    );
  }
  const explicitExitCode = [...entry.explicitExitCodes][0];
  const reviewedExitCode = ledger.exitCodes.get(code);
  if (
    explicitExitCode !== undefined &&
    reviewedExitCode !== undefined &&
    explicitExitCode !== reviewedExitCode
  ) {
    throw new Error(
      `Reviewed exit code disagrees with executable transport for ${code}: ${reviewedExitCode} != ${explicitExitCode}`,
    );
  }
  if (
    ledger.stableCodes.has(code) &&
    reviewedExitCode === undefined &&
    !allowMissingStableExit
  ) {
    throw new Error(
      `Stable error code is missing a reviewed exit code: ${code}`,
    );
  }
  const exitCode =
    reviewedExitCode ?? explicitExitCode ?? resolveFallbackExitCode(code);
  const errorClass = EXIT_CODE_CLASSES.get(exitCode);
  if (!errorClass) {
    throw new Error(`Unsupported public exit code for ${code}: ${exitCode}`);
  }
  return exitCode;
}

function validateCatalogLedgers(
  ledger,
  sourcesByCode,
  exitCodesByCode,
  reachabilityByCode,
) {
  for (const [alias, canonical] of ledger.aliases) {
    if (
      alias === canonical ||
      !ledger.stableCodes.has(alias) ||
      !ledger.stableCodes.has(canonical) ||
      !sourcesByCode.has(alias) ||
      !sourcesByCode.has(canonical) ||
      ledger.aliases.has(canonical)
    ) {
      throw new Error(`Invalid error-code alias: ${alias} -> ${canonical}`);
    }
    if (exitCodesByCode.get(alias) !== exitCodesByCode.get(canonical)) {
      throw new Error(`Alias transport mismatch: ${alias} -> ${canonical}`);
    }
  }
  const unknownReachabilityCode = [...reachabilityByCode.keys()].find(
    (code) => !sourcesByCode.has(code),
  );
  if (unknownReachabilityCode) {
    throw new Error(
      `Reachability declaration names unknown code: ${unknownReachabilityCode}`,
    );
  }
  const exitClassMismatchCode = [...reachabilityByCode].find(
    ([code, states]) => {
      const expectedClass = EXIT_CODE_CLASSES.get(exitCodesByCode.get(code));
      return states.some(
        (state) => state.expected_exit_class !== expectedClass,
      );
    },
  )?.[0];
  if (exitClassMismatchCode) {
    throw new Error(
      `Reachability exit class mismatch for ${exitClassMismatchCode}`,
    );
  }
}

function renderCatalogRow(
  code,
  entry,
  ledger,
  exitCode,
  errorClass,
  ownedStates,
) {
  const canonicalCode = ledger.aliases.get(code) ?? code;
  const aliases = [...ledger.aliases.entries()]
    .filter(([, canonical]) => canonical === code)
    .map(([alias]) => alias)
    .sort();
  const meaning = `${code.replaceAll("_", " ")} condition.`;
  return [
    "  {",
    `    code: ${JSON.stringify(code)},`,
    ...renderGeneratedStringProperty(
      "meaning",
      meaning[0].toUpperCase() + meaning.slice(1),
    ),
    `    stability: ${JSON.stringify(ledger.stableCodes.has(code) ? "stable" : "provisional")},`,
    `    exit_code: ${exitCode},`,
    `    class: ${JSON.stringify(errorClass)},`,
    "    recovery:",
    '      "Inspect the structured error guidance and retry the suggested command.",',
    ...renderGeneratedStringArray("sources", [...entry.sources]),
    ...renderGeneratedStringArray(
      "emitting_commands",
      inferEmittingCommands(code, entry.sources),
    ),
    `    canonical_code: ${JSON.stringify(canonicalCode)},`,
    ...renderGeneratedStringArray("aliases", aliases),
    ...renderOwnedStates(ownedStates),
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
  const reachabilityPath = path.join(
    root,
    "scripts",
    "error-code-reachability.json",
  );
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
  let ledger = await readStabilityLedger(stabilityPath);
  const shouldCreateStabilityLedger = ledger === null;
  if (ledger === null) {
    if (args.includes("--check")) {
      throw new Error("Error-code stability ledger is missing.");
    }
    ledger = {
      stableCodes: new Set(discoveredCodes),
      aliases: new Map(),
      exitCodes: new Map(),
      needsMigration: true,
    };
  } else if (ledger.needsMigration && args.includes("--check")) {
    throw new Error(
      "Error-code stability ledger requires schema-version migration. Run pnpm contracts:errors:update.",
    );
  }
  const removedStableCodes = [...ledger.stableCodes].filter(
    (code) => !sourcesByCode.has(code),
  );
  if (removedStableCodes.length > 0) {
    throw new Error(
      `Stable error codes cannot be removed without an explicit compatibility-ledger change: ${removedStableCodes.join(", ")}`,
    );
  }

  const unexpectedExitCodes = [...ledger.exitCodes.keys()].filter(
    (code) => !ledger.stableCodes.has(code),
  );
  if (unexpectedExitCodes.length > 0) {
    throw new Error(
      `Reviewed exit codes must name stable codes only: ${unexpectedExitCodes.join(", ")}`,
    );
  }
  const exitCodesByCode = new Map(
    [...sourcesByCode.entries()].map(([code, entry]) => [
      code,
      resolveCatalogExitCode(
        code,
        entry,
        ledger,
        shouldCreateStabilityLedger || ledger.needsMigration,
      ),
    ]),
  );
  const reachabilityByCode = await readReachabilityLedger(reachabilityPath);
  validateCatalogLedgers(
    ledger,
    sourcesByCode,
    exitCodesByCode,
    reachabilityByCode,
  );

  const rows = [...sourcesByCode.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, entry]) => {
      const exitCode = exitCodesByCode.get(code);
      return renderCatalogRow(
        code,
        entry,
        ledger,
        exitCode,
        EXIT_CODE_CLASSES.get(exitCode),
        reachabilityByCode.get(code) ?? [],
      );
    });

  const rowsPerPart = Math.ceil(rows.length / GENERATED_CATALOG_PART_COUNT);
  const generatedParts = Array.from(
    { length: GENERATED_CATALOG_PART_COUNT },
    (_, index) => {
      const partNumber = index + 1;
      const partRows = rows.slice(
        index * rowsPerPart,
        (index + 1) * rowsPerPart,
      );
      const partPath = path.join(
        sourceRoot,
        "sdk",
        "generated",
        `generated-error-code-catalog-part-${partNumber}.ts`,
      );
      const content = `/**
 * @module sdk/generated-error-code-catalog-part-${partNumber}
 *
 * Generated by scripts/generate-error-code-catalog.mjs. Do not edit manually.
 */
import type { PmErrorCodeContract } from "../error-code-catalog.js";

/** Generated partition ${partNumber} of the exhaustive error-code catalog. */
export const PM_ERROR_CODE_CATALOG_PART_${partNumber}: PmErrorCodeContract[] = [
${partRows.join("\n")}
];
`;
      return { partNumber, partPath, content };
    },
  );

  if (shouldCreateStabilityLedger || ledger.needsMigration) {
    await mkdir(path.dirname(stabilityPath), { recursive: true });
    const stableExitCodes = Object.fromEntries(
      [...ledger.stableCodes]
        .sort()
        .map((code) => [code, exitCodesByCode.get(code)]),
    );
    await writeFile(
      stabilityPath,
      `${JSON.stringify(
        {
          schema_version: 2,
          stable_codes: [...ledger.stableCodes].sort(),
          aliases: Object.fromEntries([...ledger.aliases].sort()),
          exit_codes: stableExitCodes,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  const generated = `/**
 * @module sdk/generated-error-code-catalog
 *
 * Generated by scripts/generate-error-code-catalog.mjs. Do not edit manually.
 */
import { definePmErrorCodeCatalog } from "./error-code-catalog.js";
${generatedParts
  .map(
    ({ partNumber }) =>
      `import { PM_ERROR_CODE_CATALOG_PART_${partNumber} } from "./generated/generated-error-code-catalog-part-${partNumber}.js";`,
  )
  .join("\n")}

/** Exhaustive catalog generated from literal error guidance declarations. */
export const PM_ERROR_CODE_CATALOG = definePmErrorCodeCatalog([
${generatedParts
  .map(({ partNumber }) => `  ...PM_ERROR_CODE_CATALOG_PART_${partNumber},`)
  .join("\n")}
]);
`;

  if (args.includes("--check")) {
    const existing = await readFile(outputPath, "utf8").catch(() => "");
    const partsCurrent = await Promise.all(
      generatedParts.map(
        async ({ partPath, content }) =>
          (await readFile(partPath, "utf8").catch(() => "")) === content,
      ),
    );
    if (existing !== generated || partsCurrent.includes(false)) {
      throw new Error(
        "Generated error-code catalog is stale. Run pnpm contracts:errors:update.",
      );
    }
    return;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated, "utf8");
  await Promise.all(
    generatedParts.map(async ({ partPath, content }) => {
      await mkdir(path.dirname(partPath), { recursive: true });
      await writeFile(partPath, content, "utf8");
    }),
  );
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
