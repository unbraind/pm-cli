import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { requireHistoryOperation } from "../../../../src/core/history/operation-contract.js";

const nonHistoryCalls = new Set([
  "runActiveOnWriteHooks",
  "runActiveServiceOverride",
  "recordAfterCommandAffectedItem",
  "tryApplySingleOp",
  "Sentry.startInactiveSpan",
]);

/** Exclude structurally identified hook, remediation, span and JSON Patch vocabularies. */
function isNonHistoryField(
  node: ts.PropertyAssignment,
  source: ts.SourceFile,
  file: string,
): boolean {
  let caller: ts.Node | undefined = node.parent;
  while (caller && !ts.isCallExpression(caller)) caller = caller.parent;
  const name =
    caller && ts.isCallExpression(caller)
      ? caller.expression.getText(source)
      : "";
  if (nonHistoryCalls.has(name)) return true;
  if (
    ts.isObjectLiteralExpression(node.parent) &&
    node.parent.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(source) === "rationale",
    ) &&
    node.parent.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(source) === "confidence",
    )
  )
    return true;
  return (
    file.endsWith("core/history/history.ts") &&
    ts.isStringLiteral(node.initializer) &&
    node.initializer.text === "add"
  );
}

/** Locate native operation operands in property assignments and settings writes. */
function operationExpressions(
  node: ts.Node,
  source: ts.SourceFile,
  file: string,
): ts.Expression[] {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === "writeSettings"
  )
    return node.arguments[2] === undefined ? [] : [node.arguments[2]];
  if (!ts.isPropertyAssignment(node)) return [];
  const name = ts.isStringLiteral(node.name)
    ? node.name.text
    : node.name.getText(source);
  if (
    !["op", "editOp", "deleteOp"].includes(name) ||
    isNonHistoryField(node, source, file)
  )
    return [];
  return [node.initializer];
}

/** Unwrap literal branches and TypeScript wrappers without guessing dynamic values. */
function operationLiterals(expression: ts.Expression): string[] {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  )
    return [expression.text];
  if (ts.isConditionalExpression(expression))
    return [
      ...operationLiterals(expression.whenTrue),
      ...operationLiterals(expression.whenFalse),
    ];
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  )
    return operationLiterals(expression.expression);
  return [];
}

/** Report source positions whose native operation literals lack a declared identity. */
function undeclaredOperations(text: string, file: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  /** Traverse each syntax node and validate only identified operation operands. */
  function visit(node: ts.Node): void {
    for (const expression of operationExpressions(node, source, file)) {
      for (const value of operationLiterals(expression)) {
        try {
          requireHistoryOperation(value);
        } catch {
          errors.push(
            `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${value}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}

describe("native operation write-site contract", () => {
  it("rejects new undeclared native literals without confusing hook or patch vocabularies", () => {
    expect(
      undeclaredOperations(
        'writeSettings(root, settings, "updaet");',
        "fixture.ts",
      ),
    ).toEqual(["fixture.ts:1:updaet"]);
    expect(
      undeclaredOperations(
        'mutateItem({ "op": (`updaet` as const) });',
        "fixture.ts",
      ),
    ).toEqual(["fixture.ts:1:updaet"]);
    expect(
      undeclaredOperations(
        'mutateItem({ op: "updaet" });',
        "sdk/graph/remediation.ts",
      ),
    ).toEqual(["sdk/graph/remediation.ts:1:updaet"]);
    expect(
      undeclaredOperations('mutateItem({ op: "updaet" });', "fixture.ts"),
    ).toEqual(["fixture.ts:1:updaet"]);
    expect(
      undeclaredOperations(
        'runActiveOnWriteHooks({ op: "create:history" });',
        "fixture.ts",
      ),
    ).toEqual([]);
    expect(
      undeclaredOperations(
        'mutateItem({ op: ok ? "update" : "updaet" });',
        "fixture.ts",
      ),
    ).toEqual(["fixture.ts:1:updaet"]);
  });

  it("enumerates every source file and fails on a native operation absent from the public contract", async () => {
    const root = path.resolve("src");
    const files = (await readdir(root, { recursive: true })).filter((file) =>
      file.endsWith(".ts"),
    );
    const findings = await Promise.all(
      files.map(async (file) =>
        undeclaredOperations(
          await readFile(path.join(root, file), "utf8"),
          file.replaceAll("\\", "/"),
        ),
      ),
    );
    expect(findings.flat()).toEqual([]);
  });
});
