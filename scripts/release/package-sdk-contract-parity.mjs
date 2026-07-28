#!/usr/bin/env node

/**
 * Reject package-owned type mirrors of contracts already exported by the SDK.
 *
 * First-party package sources ship inside the npm artifact. This gate scans
 * those exact sources so a stale hand-written signature cannot pass local
 * typechecking and then become immutable consumer code in a published package.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function declarationLine(sourceFile, node) {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

/**
 * Find package declarations that copy a public SDK contract instead of
 * importing it or deriving a module shape with `typeof`.
 */
export function findPackageSdkContractMirrors(
  packageSources,
  publicSdkExports,
) {
  const violations = [];
  for (const source of packageSources) {
    const sourceFile = ts.createSourceFile(
      source.path,
      source.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        publicSdkExports.has(node.name.text)
      ) {
        violations.push({
          path: source.path,
          line: declarationLine(sourceFile, node),
          name: node.name.text,
          kind: "public_contract_redeclaration",
        });
      }
      if (
        ts.isInterfaceDeclaration(node) &&
        /SdkModule$/u.test(node.name.text)
      ) {
        for (const member of node.members) {
          const name =
            member.name &&
            (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
              ? member.name.text
              : undefined;
          if (name && publicSdkExports.has(name)) {
            violations.push({
              path: source.path,
              line: declarationLine(sourceFile, member),
              name,
              kind: "sdk_module_signature_mirror",
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

/** Load shipped package sources and the current checked-in SDK surface. */
export function loadPackageSdkContractSources(root = repoRoot) {
  const packagePaths = fg.sync("packages/pm-*/extensions/**/*.ts", {
    cwd: root,
    onlyFiles: true,
    unique: true,
  });
  const surface = JSON.parse(
    readFileSync(path.join(root, "sdk/public-surface.json"), "utf8"),
  );
  const sdkSymbols = surface.entrypoints?.["./sdk"]?.symbols;
  if (!Array.isArray(sdkSymbols)) {
    throw new TypeError(
      "sdk/public-surface.json is missing entrypoints['./sdk'].symbols",
    );
  }
  return {
    packageSources: packagePaths.map((sourcePath) => ({
      path: sourcePath,
      text: readFileSync(path.join(root, sourcePath), "utf8"),
    })),
    publicSdkExports: new Set(
      sdkSymbols
        .map((symbol) =>
          typeof symbol === "object" &&
          symbol !== null &&
          typeof symbol.name === "string"
            ? symbol.name
            : undefined,
        )
        .filter((name) => name !== undefined),
    ),
  };
}

/** Execute the package SDK parity gate and report actionable source locations. */
export function main(loaded = loadPackageSdkContractSources()) {
  const violations = findPackageSdkContractMirrors(
    loaded.packageSources,
    loaded.publicSdkExports,
  );
  if (violations.length === 0) {
    console.log("Package SDK contract parity gate passed.");
    return;
  }
  console.error("Package SDK contract mirrors detected:");
  for (const violation of violations) {
    console.error(
      `- ${violation.path}:${violation.line} ${violation.kind}: ${violation.name}`,
    );
  }
  process.exitCode = 1;
}

/** Run the gate only when this module is the invoked Node entrypoint. */
export function runIfMain(candidate = process.argv[1]) {
  if (candidate && path.resolve(candidate) === fileURLToPath(import.meta.url)) {
    main();
  }
}

runIfMain();
