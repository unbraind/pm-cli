#!/usr/bin/env node

/**
 * Generates and verifies the semantic public SDK compatibility snapshot.
 *
 * Tracker: pm-e6tm5c. The snapshot is built from emitted declaration files so
 * it records the package consumers actually compile against, not source-only
 * implementation details.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packagePath = path.join(repoRoot, "package.json");
const snapshotPath = path.join(
  repoRoot,
  "sdk",
  "public-surface.json",
);
const ENTRYPOINT_CLASSIFICATIONS = Object.freeze({
  "./sdk": "advanced_export",
  "./sdk/authoring": "supported",
  "./sdk/contracts": "contract_data",
  "./sdk/core": "supported",
  "./sdk/governance": "supported",
  "./sdk/graph": "supported",
  "./sdk/merge": "supported",
  "./sdk/query": "supported",
  "./sdk/runtime": "advanced_export",
  "./sdk/testing": "supported",
});
const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
  ts.TypeFormatFlags.WriteArrowStyleSignature;
const AGGREGATE_EXCLUDED_ENTRYPOINTS = new Set(["./sdk", "./sdk/testing"]);
const AGGREGATE_EXPORT_EXCLUSIONS = Object.freeze(
  Object.assign(Object.create(null), {
    _testOnlyCliContracts:
      "Deliberately scoped to the contracts subpath for pm's own contract tests.",
  }),
);

/** Return a stable JSON representation with recursively sorted object keys. */
export function stableJson(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return entry;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

/** Classify one TypeScript symbol into a compact public API kind. */
export function classifySymbolKind(symbol) {
  const flags = symbol.flags;
  if ((flags & ts.SymbolFlags.Class) !== 0) return "class";
  if ((flags & ts.SymbolFlags.Interface) !== 0) return "interface";
  if ((flags & ts.SymbolFlags.TypeAlias) !== 0) return "type";
  if ((flags & ts.SymbolFlags.Function) !== 0) return "function";
  if ((flags & ts.SymbolFlags.Enum) !== 0) return "enum";
  if ((flags & ts.SymbolFlags.NamespaceModule) !== 0) return "namespace";
  return "value";
}

/** Canonicalize parenthesized string-literal unions because TypeScript may emit their members in declaration-discovery order. */
export function normalizeLiteralUnionOrder(signature) {
  return signature.replaceAll(
    /"(?:[^"\\]|\\.)+"(?: \| "(?:[^"\\]|\\.)+")+/gu,
    (literalUnion) =>
      literalUnion
        .split(" | ")
        .sort((left, right) => left.localeCompare(right))
        .join(" | "),
  );
}

function signatureForSymbol(checker, symbol) {
  const declarations = symbol.declarations ?? [];
  const location = symbol.valueDeclaration ?? declarations[0];
  if (!location) return "unknown";
  if (
    (symbol.flags &
      (ts.SymbolFlags.Class |
        ts.SymbolFlags.Interface |
        ts.SymbolFlags.TypeAlias |
        ts.SymbolFlags.Enum)) !==
    0
  ) {
    const printer = ts.createPrinter({
      newLine: ts.NewLineKind.LineFeed,
      removeComments: true,
    });
    return declarations
      .map((declaration) =>
        printer
          .printNode(
            ts.EmitHint.Unspecified,
            declaration,
            declaration.getSourceFile(),
          )
          .replaceAll(/\s+/gu, " ")
          .trim(),
      )
      .sort((left, right) => left.localeCompare(right))
      .join(" | ");
  }
  const type = checker.getTypeOfSymbolAtLocation(symbol, location);
  const renderedType = normalizeLiteralUnionOrder(
    checker.typeToString(type, location, TYPE_FORMAT_FLAGS),
  );
  const callSignatures = checker
    .getSignaturesOfType(type, ts.SignatureKind.Call)
    .map((signature) =>
      checker.signatureToString(
        signature,
        location,
        TYPE_FORMAT_FLAGS,
        ts.SignatureKind.Call,
      ),
    );
  return callSignatures.length === 0
    ? renderedType
    : `${renderedType} | calls: ${callSignatures.join(" ; ")}`;
}

/** Collect the exported symbol contract for one emitted declaration entrypoint. */
export function collectEntrypointSymbols(
  program,
  declarationPath,
  classification,
) {
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(declarationPath);
  if (!sourceFile) {
    throw new Error(
      `SDK declaration entrypoint was not loaded: ${declarationPath}`,
    );
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error(
      `SDK declaration entrypoint has no module symbol: ${declarationPath}`,
    );
  }
  return checker
    .getExportsOfModule(moduleSymbol)
    .map((exportedSymbol) => {
      const symbol =
        (exportedSymbol.flags & ts.SymbolFlags.Alias) !== 0
          ? checker.getAliasedSymbol(exportedSymbol)
          : exportedSymbol;
      return {
        name: exportedSymbol.name,
        kind: classifySymbolKind(symbol),
        classification,
        signature: signatureForSymbol(checker, symbol),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Prove the compatibility aggregate contains every non-testing subpath export. */
export function analyzeAggregateSdkCompleteness(
  entrypoints,
  exclusions = AGGREGATE_EXPORT_EXCLUSIONS,
) {
  const aggregateNames = new Set(
    entrypoints["./sdk"]?.symbols?.map((symbol) => symbol.name) ?? [],
  );
  const required = new Map();
  for (const [entrypoint, contract] of Object.entries(entrypoints)) {
    if (AGGREGATE_EXCLUDED_ENTRYPOINTS.has(entrypoint)) continue;
    for (const symbol of contract.symbols ?? []) {
      const owners = required.get(symbol.name) ?? [];
      owners.push(entrypoint);
      required.set(symbol.name, owners);
    }
  }
  const missing = [...required]
    .filter(
      ([name]) => !aggregateNames.has(name) && !Object.hasOwn(exclusions, name),
    )
    .map(([name, entrypoints]) => ({ name, entrypoints }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const excluded = Object.entries(exclusions)
    .filter(([name]) => required.has(name) && !aggregateNames.has(name))
    .map(([name, reason]) => ({ name, reason }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    covered_symbols: required.size - missing.length - excluded.length,
    required_symbols: required.size,
    missing,
    excluded,
  };
}

/** Extract string-literal `code` declarations from public SDK source modules. */
export async function collectDeclaredErrorCodes(root = repoRoot) {
  const sdkRoot = path.join(root, "src", "sdk");
  const sourcePaths = [];
  const visitDirectory = async (directory) => {
    const entries = await ts.sys.readDirectory(
      directory,
      [".ts"],
      undefined,
      undefined,
    );
    sourcePaths.push(...entries.filter((entry) => !entry.endsWith(".d.ts")));
  };
  await visitDirectory(sdkRoot);
  const codes = new Set();
  for (const sourcePath of sourcePaths) {
    const source = ts.createSourceFile(
      sourcePath,
      await readFile(sourcePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ((ts.isIdentifier(node.name) && node.name.text === "code") ||
          (ts.isStringLiteral(node.name) && node.name.text === "code")) &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        codes.add(node.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...codes].sort((left, right) => left.localeCompare(right));
}

/** Build the package-level SDK surface from package exports and declaration files. */
export async function buildSdkSurfaceSnapshot(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const entrypoints = Object.entries(ENTRYPOINT_CLASSIFICATIONS).map(
    ([exportPath, classification]) => {
      const packageExport = packageJson.exports?.[exportPath];
      if (!packageExport || typeof packageExport.types !== "string") {
        throw new Error(
          `Package export ${exportPath} must declare a types path`,
        );
      }
      return {
        exportPath,
        classification,
        declarationPath: path.resolve(root, packageExport.types),
      };
    },
  );
  const missing = entrypoints
    .map((entry) => entry.declarationPath)
    .filter((declarationPath) => !existsSync(declarationPath));
  if (missing.length > 0) {
    throw new Error(
      `Missing SDK declarations; run pnpm build first:\n${missing.join("\n")}`,
    );
  }
  const program = ts.createProgram(
    entrypoints.map((entry) => entry.declarationPath),
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
    },
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }),
    );
  }
  const rawEntrypoints = Object.fromEntries(
    entrypoints.map((entry) => [
      entry.exportPath,
      {
        classification: entry.classification,
        types: path
          .relative(root, entry.declarationPath)
          .replaceAll(path.sep, "/"),
        symbols: collectEntrypointSymbols(
          program,
          entry.declarationPath,
          entry.classification,
        ),
      },
    ]),
  );
  const supportedNames = new Set(
    Object.values(rawEntrypoints)
      .filter((entry) => entry.classification === "supported")
      .flatMap((entry) => entry.symbols.map((symbol) => symbol.name)),
  );
  const contractNames = new Set(
    Object.values(rawEntrypoints)
      .filter((entry) => entry.classification === "contract_data")
      .flatMap((entry) => entry.symbols.map((symbol) => symbol.name)),
  );
  const classifiedEntrypoints = Object.fromEntries(
    Object.entries(rawEntrypoints).map(([exportPath, entry]) => [
      exportPath,
      {
        ...entry,
        symbols: entry.symbols.map((symbol) => ({
          ...symbol,
          classification:
            entry.classification === "advanced_export"
              ? supportedNames.has(symbol.name)
                ? "supported"
                : contractNames.has(symbol.name)
                  ? "contract_data"
                  : "advanced_export"
              : symbol.classification,
        })),
      },
    ]),
  );
  const aggregateCompleteness =
    analyzeAggregateSdkCompleteness(classifiedEntrypoints);
  if (aggregateCompleteness.missing.length > 0) {
    throw new Error(
      `Aggregate SDK entrypoint is incomplete:\n${aggregateCompleteness.missing
        .map(
          (entry) =>
            `${entry.name} (exported by ${entry.entrypoints.join(", ")})`,
        )
        .join("\n")}`,
    );
  }
  return {
    schema_version: 2,
    package: packageJson.name,
    entrypoints: classifiedEntrypoints,
    aggregate_completeness: aggregateCompleteness,
    error_codes: await collectDeclaredErrorCodes(root),
  };
}

function symbolMap(snapshot) {
  const result = new Map();
  for (const [entrypoint, contract] of Object.entries(
    snapshot?.entrypoints ?? {},
  )) {
    for (const symbol of contract.symbols ?? []) {
      result.set(`${entrypoint}:${symbol.name}`, symbol);
    }
  }
  return result;
}

function classifyEntrypointChanges(previous, next) {
  const changes = [];
  const previousEntrypoints = new Set(Object.keys(previous.entrypoints ?? {}));
  const nextEntrypoints = new Set(Object.keys(next.entrypoints ?? {}));
  for (const entrypoint of nextEntrypoints.difference(previousEntrypoints)) {
    changes.push({
      classification: "additive",
      subject: `entrypoint ${entrypoint}`,
    });
  }
  for (const entrypoint of previousEntrypoints.difference(nextEntrypoints)) {
    changes.push({
      classification: "breaking",
      subject: `entrypoint ${entrypoint} removed`,
    });
  }
  return changes;
}

function classifySymbolChanges(previous, next) {
  const changes = [];
  const previousSymbols = symbolMap(previous);
  const nextSymbols = symbolMap(next);
  for (const [key, symbol] of nextSymbols) {
    const oldSymbol = previousSymbols.get(key);
    if (!oldSymbol) {
      changes.push({ classification: "additive", subject: `symbol ${key}` });
    } else if (
      normalizeLiteralUnionOrder(oldSymbol.signature) !==
        normalizeLiteralUnionOrder(symbol.signature) ||
      oldSymbol.kind !== symbol.kind
    ) {
      changes.push({ classification: "breaking", subject: `signature ${key}` });
    } else if (oldSymbol.classification !== symbol.classification) {
      changes.push({
        classification:
          oldSymbol.classification === "supported" ? "breaking" : "compatible",
        subject: `classification ${key}: ${oldSymbol.classification} -> ${symbol.classification}`,
      });
    }
  }
  for (const key of previousSymbols.keys()) {
    if (!nextSymbols.has(key)) {
      changes.push({
        classification: "breaking",
        subject: `symbol ${key} removed`,
      });
    }
  }
  return changes;
}

function classifyErrorCodeChanges(previous, next) {
  const changes = [];
  const previousCodes = new Set(previous.error_codes ?? []);
  const nextCodes = new Set(next.error_codes ?? []);
  for (const code of nextCodes.difference(previousCodes)) {
    changes.push({ classification: "additive", subject: `error code ${code}` });
  }
  for (const code of previousCodes.difference(nextCodes)) {
    changes.push({
      classification: "breaking",
      subject: `error code ${code} removed`,
    });
  }
  return changes;
}

/** Classify all semantic changes between two SDK surface snapshots. */
export function classifySdkSurfaceChanges(previous, next) {
  if (!previous)
    return [{ classification: "additive", subject: "initial SDK baseline" }];
  const changes = [
    ...classifyEntrypointChanges(previous, next),
    ...classifySymbolChanges(previous, next),
    ...classifyErrorCodeChanges(previous, next),
  ];
  return changes.sort((left, right) =>
    left.subject.localeCompare(right.subject),
  );
}

function parseMode(argv) {
  const update = argv.includes("--update");
  const check = argv.includes("--check");
  if (update === check) {
    throw new Error(
      "Usage: node scripts/sdk-surface-snapshot.mjs --update|--check [--acknowledge-breaking <reason>]",
    );
  }
  const acknowledgementIndex = argv.indexOf("--acknowledge-breaking");
  return {
    mode: update ? "update" : "check",
    acknowledgement:
      acknowledgementIndex === -1
        ? undefined
        : argv[acknowledgementIndex + 1]?.trim(),
  };
}

/** Run the SDK surface snapshot command. */
export async function main(argv = process.argv.slice(2), options = {}) {
  const { mode, acknowledgement } = parseMode(argv);
  const targetPath = options.snapshotPath ?? snapshotPath;
  let previous;
  try {
    previous = JSON.parse(await readFile(targetPath, "utf8"));
  } catch {
    previous = undefined;
  }
  const next = await (options.buildSnapshot ?? buildSdkSurfaceSnapshot)();
  next.breaking_acknowledgements = previous?.breaking_acknowledgements ?? [];
  const changes = classifySdkSurfaceChanges(previous, next);
  let stale =
    previous === undefined || stableJson(previous) !== stableJson(next);
  if (mode === "check") {
    if (stale) {
      const details = changes.map(
        (change) => `${change.classification}: ${change.subject}`,
      );
      throw new Error(
        `SDK surface snapshot is stale at ${targetPath}.\n${details.join("\n")}\nRun pnpm sdk:surface:update.`,
      );
    }
    return { mode, changed: false, changes, snapshotPath: targetPath };
  }
  const breaking = changes.filter(
    (change) => change.classification === "breaking",
  );
  if (breaking.length > 0 && !acknowledgement) {
    throw new Error(
      `Refusing to update ${targetPath}: ${breaking.length} breaking SDK change(s) require --acknowledge-breaking <reason>.\n${breaking.map((change) => change.subject).join("\n")}`,
    );
  }
  if (breaking.length > 0) {
    next.breaking_acknowledgements.push({
      package_version: JSON.parse(await readFile(packagePath, "utf8")).version,
      reason: acknowledgement,
      changes: breaking.map((change) => change.subject),
    });
    stale = true;
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stableJson(next), "utf8");
  return {
    mode,
    changed: stale,
    changes,
    snapshotPath: targetPath,
    acknowledgement,
  };
}

/** Execute the CLI entrypoint while keeping all logic importable for tests. */
export async function runEntrypoint(argv = process.argv, options = {}) {
  if (
    argv[1] === undefined ||
    path.resolve(argv[1]) !== fileURLToPath(import.meta.url)
  ) {
    return false;
  }
  try {
    const result = await (options.runMain ?? main)(argv.slice(2));
    console.log(
      `${result.changed ? "Updated" : "Verified"} ${result.snapshotPath} (${result.changes.length} classified changes)`,
    );
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return false;
  }
}

void runEntrypoint();
