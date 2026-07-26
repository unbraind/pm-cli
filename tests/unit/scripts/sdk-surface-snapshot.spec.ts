import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { runEntrypoint } from "../../../scripts/sdk-surface-snapshot.mjs";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness(["typescript"]);
const temporaryRoots: string[] = [];

interface SurfaceSymbol {
  name: string;
  kind: string;
  classification: string;
  signature: string;
}

interface SurfaceSnapshot {
  schema_version: number;
  package: string;
  entrypoints: Record<
    string,
    { classification: string; types: string; symbols: SurfaceSymbol[] }
  >;
  error_codes: string[];
  aggregate_completeness?: {
    covered_symbols: number;
    required_symbols: number;
    missing: Array<{ name: string; entrypoints: string[] }>;
    excluded: Array<{ name: string; reason: string }>;
  };
  breaking_acknowledgements?: Array<{
    package_version: string;
    reason: string;
    changes: string[];
  }>;
}

interface SurfaceModule {
  stableJson(value: unknown): string;
  normalizeLiteralUnionOrder(signature: string): string;
  collectDeclaredErrorCodes(root?: string): Promise<string[]>;
  classifySymbolKind(symbol: { flags: number }): string;
  collectEntrypointSymbols(
    program: {
      getTypeChecker(): unknown;
      getSourceFile(path: string): unknown;
    },
    declarationPath: string,
    classification: string,
  ): SurfaceSymbol[];
  analyzeAggregateSdkCompleteness(
    entrypoints: SurfaceSnapshot["entrypoints"],
    exclusions?: Record<string, string>,
  ): NonNullable<SurfaceSnapshot["aggregate_completeness"]>;
  buildSdkSurfaceSnapshot(options?: {
    repoRoot?: string;
  }): Promise<SurfaceSnapshot>;
  classifySdkSurfaceChanges(
    previous: SurfaceSnapshot | undefined,
    next: SurfaceSnapshot,
  ): Array<{ classification: string; subject: string }>;
  main(
    argv: string[],
    options?: {
      snapshotPath?: string;
      buildSnapshot?: () => Promise<SurfaceSnapshot>;
    },
  ): Promise<{
    mode: string;
    changed: boolean;
    changes: Array<{ classification: string; subject: string }>;
  }>;
}

async function loadModule(): Promise<SurfaceModule> {
  return harness.importModuleStable<SurfaceModule>(
    "scripts/sdk-surface-snapshot.mjs",
  );
}

function snapshot(symbols: SurfaceSymbol[] = []): SurfaceSnapshot {
  return {
    schema_version: 1,
    package: "@unbrained/pm-cli",
    entrypoints: {
      "./sdk/core": {
        classification: "supported",
        types: "dist/sdk/core.d.ts",
        symbols,
      },
    },
    error_codes: ["item_not_found"],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SDK surface snapshot semantics", () => {
  it("fails closed when a non-testing subpath export is absent from the aggregate", async () => {
    const mod = await loadModule();
    expect(mod.analyzeAggregateSdkCompleteness({})).toMatchObject({
      covered_symbols: 0,
      required_symbols: 0,
      missing: [],
    });
    expect(
      mod.analyzeAggregateSdkCompleteness({
        "./sdk": {
          classification: "advanced_export",
          types: "sdk.d.ts",
        },
        "./sdk/query": {
          classification: "supported",
          types: "query.d.ts",
        },
      } as SurfaceSnapshot["entrypoints"]),
    ).toMatchObject({ required_symbols: 0, missing: [] });
    const entrypoints = {
      "./sdk": {
        classification: "advanced_export",
        types: "sdk.d.ts",
        symbols: [],
      },
      "./sdk/query": {
        classification: "supported",
        types: "query.d.ts",
        symbols: [
          {
            name: "alphaQuery",
            kind: "function",
            classification: "supported",
            signature: "() => void",
          },
          {
            name: "queryItems",
            kind: "function",
            classification: "supported",
            signature: "() => void",
          },
        ],
      },
    };
    expect(mod.analyzeAggregateSdkCompleteness(entrypoints)).toMatchObject({
      covered_symbols: 0,
      required_symbols: 2,
      missing: [
        { name: "alphaQuery", entrypoints: ["./sdk/query"] },
        { name: "queryItems", entrypoints: ["./sdk/query"] },
      ],
    });
    expect(
      mod.analyzeAggregateSdkCompleteness(entrypoints, {
        alphaQuery: "second narrow-only fixture",
        queryItems: "intentionally narrow-only fixture",
      }),
    ).toMatchObject({
      missing: [],
      excluded: [
        { name: "alphaQuery", reason: "second narrow-only fixture" },
        { name: "queryItems", reason: "intentionally narrow-only fixture" },
      ],
    });
    entrypoints["./sdk"]!.symbols = [
      {
        name: "alphaQuery",
        kind: "function",
        classification: "advanced_export",
        signature: "() => void",
      },
    ];
    expect(
      mod.analyzeAggregateSdkCompleteness(entrypoints, {
        alphaQuery: "stale exclusion for a now-covered export",
        queryItems: "intentionally narrow-only fixture",
      }),
    ).toMatchObject({
      covered_symbols: 1,
      missing: [],
      excluded: [
        { name: "queryItems", reason: "intentionally narrow-only fixture" },
      ],
    });
    entrypoints["./sdk/query"]!.symbols.push({
      name: "constructor",
      kind: "function",
      classification: "supported",
      signature: "() => void",
    });
    expect(
      mod.analyzeAggregateSdkCompleteness(entrypoints, {}),
    ).toMatchObject({
      missing: expect.arrayContaining([
        { name: "constructor", entrypoints: ["./sdk/query"] },
      ]),
    });
  });
  it("sorts object keys recursively while preserving array order", async () => {
    const mod = await loadModule();
    expect(mod.stableJson({ z: [{ b: 2, a: 1 }], a: 1 })).toBe(
      '{\n  "a": 1,\n  "z": [\n    {\n      "a": 1,\n      "b": 2\n    }\n  ]\n}\n',
    );
    expect(
      mod.normalizeLiteralUnionOrder(
        'Readonly<{ capabilities: ("schema" | "commands" | "hooks")[]; }>',
      ),
    ).toBe(
      'Readonly<{ capabilities: ("commands" | "hooks" | "schema")[]; }>',
    );
  });

  it("classifies additive, compatible, and breaking changes", async () => {
    const mod = await loadModule();
    const previous = snapshot([
      {
        name: "create",
        kind: "function",
        classification: "advanced_export",
        signature: "(title: string) => void",
      },
      {
        name: "removed",
        kind: "function",
        classification: "supported",
        signature: "() => void",
      },
    ]);
    const next = snapshot([
      {
        name: "create",
        kind: "function",
        classification: "supported",
        signature: "(title: string) => void",
      },
      {
        name: "added",
        kind: "function",
        classification: "supported",
        signature: "() => void",
      },
    ]);
    next.error_codes.push("invalid_title");
    const changes = mod.classifySdkSurfaceChanges(previous, next);
    expect(changes.map((change) => change.classification)).toEqual(
      expect.arrayContaining(["additive", "compatible", "breaking"]),
    );
    expect(changes.some((change) => change.subject.includes("removed"))).toBe(
      true,
    );
    const initial = mod.classifySdkSurfaceChanges(undefined, next);
    expect(initial).toEqual([
      { classification: "additive", subject: "initial SDK baseline" },
    ]);
    const changedEntrypoint = structuredClone(next);
    changedEntrypoint.entrypoints["./sdk/query"] =
      changedEntrypoint.entrypoints["./sdk/core"];
    delete changedEntrypoint.entrypoints["./sdk/core"];
    changedEntrypoint.error_codes = [];
    changedEntrypoint.entrypoints["./sdk/query"].symbols[0] = {
      ...changedEntrypoint.entrypoints["./sdk/query"].symbols[0],
      classification: "advanced_export",
      signature: "(title: number) => void",
    };
    const structural = mod.classifySdkSurfaceChanges(next, changedEntrypoint);
    expect(structural.map((change) => change.subject)).toEqual(
      expect.arrayContaining([
        "entrypoint ./sdk/core removed",
        "entrypoint ./sdk/query",
        "error code item_not_found removed",
      ]),
    );
    const reclassified = structuredClone(next);
    reclassified.entrypoints["./sdk/core"].symbols[0] = {
      ...reclassified.entrypoints["./sdk/core"].symbols[0],
      classification: "advanced_export",
      signature: "(title: number) => void",
    };
    expect(
      mod
        .classifySdkSurfaceChanges(next, reclassified)
        .map((change) => change.subject),
    ).toEqual(expect.arrayContaining(["signature ./sdk/core:create"]));
    expect(
      mod.classifySdkSurfaceChanges(
        { schema_version: 1, package: "fixture" } as SurfaceSnapshot,
        { schema_version: 1, package: "fixture" } as SurfaceSnapshot,
      ),
    ).toEqual([]);
    expect(
      mod.classifySdkSurfaceChanges(
        {
          schema_version: 1,
          package: "fixture",
          entrypoints: {
            "./sdk/core": {
              classification: "supported",
              types: "core.d.ts",
            },
          },
          error_codes: [],
        } as SurfaceSnapshot,
        {
          schema_version: 1,
          package: "fixture",
          entrypoints: {
            "./sdk/core": {
              classification: "supported",
              types: "core.d.ts",
            },
          },
          error_codes: [],
        } as SurfaceSnapshot,
      ),
    ).toEqual([]);
    const downgraded = structuredClone(next);
    downgraded.entrypoints["./sdk/core"].symbols[0] = {
      ...downgraded.entrypoints["./sdk/core"].symbols[0],
      classification: "advanced_export",
    };
    expect(mod.classifySdkSurfaceChanges(next, downgraded)).toContainEqual({
      classification: "breaking",
      subject: "classification ./sdk/core:create: supported -> advanced_export",
    });
  });

  it("classifies every TypeScript symbol kind and defensive module boundary", async () => {
    const mod = await loadModule();
    expect(mod.classifySymbolKind({ flags: ts.SymbolFlags.Enum })).toBe("enum");
    expect(
      mod.classifySymbolKind({ flags: ts.SymbolFlags.NamespaceModule }),
    ).toBe("namespace");
    expect(mod.classifySymbolKind({ flags: 0 })).toBe("value");
    const checker = {
      getSymbolAtLocation: () => ({ name: "module" }),
      getExportsOfModule: () => [
        { name: "unknown", flags: 0, declarations: [] },
      ],
      getTypeOfSymbolAtLocation: () => ({}),
      typeToString: () => "unknown",
      getSignaturesOfType: () => [],
    };
    expect(
      mod.collectEntrypointSymbols(
        {
          getTypeChecker: () => checker,
          getSourceFile: () => ({}),
        },
        "entry.d.ts",
        "supported",
      ),
    ).toEqual([
      {
        name: "unknown",
        kind: "value",
        classification: "supported",
        signature: "unknown",
      },
    ]);
    const declarationSource = ts.createSourceFile(
      "merged.d.ts",
      "export interface Merged { b: string }\nexport interface Merged { a: string }\n",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const declarations = [...declarationSource.statements];
    expect(
      mod.collectEntrypointSymbols(
        {
          getTypeChecker: () => ({
            ...checker,
            getExportsOfModule: () => [
              {
                name: "Merged",
                flags: ts.SymbolFlags.Interface,
                declarations,
                valueDeclaration: declarations[0],
              },
            ],
          }),
          getSourceFile: () => declarationSource,
        },
        "merged.d.ts",
        "supported",
      )[0]?.signature,
    ).toContain("interface Merged");
    expect(
      mod.collectEntrypointSymbols(
        {
          getTypeChecker: () => ({
            ...checker,
            getExportsOfModule: () => [{ name: "unknown", flags: 0 }],
          }),
          getSourceFile: () => ({}),
        },
        "unknown.d.ts",
        "supported",
      )[0]?.signature,
    ).toBe("unknown");
    const literalUnionChecker = {
      ...checker,
      getExportsOfModule: () => [
        {
          name: "contract",
          flags: 0,
          declarations: [{}],
          valueDeclaration: {},
        },
      ],
      typeToString: () =>
        'Readonly<{ capabilities: ("schema" | "commands" | "hooks")[]; }>',
    };
    expect(
      mod.collectEntrypointSymbols(
        {
          getTypeChecker: () => literalUnionChecker,
          getSourceFile: () => ({}),
        },
        "literal-union.d.ts",
        "supported",
      )[0]?.signature,
    ).toBe(
      'Readonly<{ capabilities: ("commands" | "hooks" | "schema")[]; }>',
    );
    expect(() =>
      mod.collectEntrypointSymbols(
        {
          getTypeChecker: () => checker,
          getSourceFile: () => undefined,
        },
        "missing.d.ts",
        "supported",
      ),
    ).toThrow("was not loaded");
    expect(() =>
      mod.collectEntrypointSymbols(
        {
          getTypeChecker: () => ({
            ...checker,
            getSymbolAtLocation: () => undefined,
          }),
          getSourceFile: () => ({}),
        },
        "symbol-less.d.ts",
        "supported",
      ),
    ).toThrow("no module symbol");
  });

  it("extracts the declared SDK error-code vocabulary from nested source files", async () => {
    const mod = await loadModule();
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-sdk-error-codes-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "src", "sdk", "nested"), { recursive: true });
    await writeFile(
      path.join(root, "src", "sdk", "one.ts"),
      'throw new Error(JSON.stringify({ code: "zeta" }));\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "sdk", "nested", "two.ts"),
      'export const finding = { "code": "alpha" };\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "sdk", "ignored.d.ts"),
      'export type Ignored = { code: "ignored" };\n',
      "utf8",
    );
    await expect(mod.collectDeclaredErrorCodes(root)).resolves.toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it(
    "reads every declared package entrypoint through the TypeScript checker",
    async () => {
      const mod = await loadModule();
      const result = await mod.buildSdkSurfaceSnapshot();
      expect(Object.keys(result.entrypoints)).toContain("./sdk/authoring");
      expect(
        result.entrypoints["./sdk/contracts"]?.symbols.some(
          (symbol) =>
            symbol.name === "PM_TOOL_ACTIONS" &&
            symbol.classification === "contract_data",
        ),
      ).toBe(true);
      expect(
        result.entrypoints["./sdk/core"]?.symbols.some(
          (symbol) =>
            symbol.name === "PmClient" && symbol.signature.includes("class"),
        ),
      ).toBe(true);
      expect(result.error_codes).toContain("invalid_query_cursor");
    },
    120_000,
  );

  it("fails closed for missing package exports, declarations, and declaration diagnostics", async () => {
    const mod = await loadModule();
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-sdk-invalid-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "src", "sdk"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture", exports: {} }),
    );
    await expect(
      mod.buildSdkSurfaceSnapshot({ repoRoot: root }),
    ).rejects.toThrow("must declare a types path");
    const exportNames = [
      "./sdk",
      "./sdk/authoring",
      "./sdk/contracts",
      "./sdk/core",
      "./sdk/governance",
      "./sdk/graph",
      "./sdk/merge",
      "./sdk/query",
      "./sdk/runtime",
      "./sdk/testing",
    ];
    const packageJson = {
      name: "fixture",
      exports: Object.fromEntries(
        exportNames.map((name) => [name, { types: "./missing.d.ts" }]),
      ),
    };
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(packageJson),
    );
    await expect(
      mod.buildSdkSurfaceSnapshot({ repoRoot: root }),
    ).rejects.toThrow("Missing SDK declarations");
    await writeFile(
      path.join(root, "missing.d.ts"),
      "export interface Broken {",
    );
    await expect(
      mod.buildSdkSurfaceSnapshot({ repoRoot: root }),
    ).rejects.toThrow();
    await writeFile(path.join(root, "aggregate.d.ts"), "export {};\n");
    await writeFile(
      path.join(root, "narrow.d.ts"),
      "export declare const onlyNarrow: string;\n",
    );
    packageJson.exports = Object.fromEntries(
      exportNames.map((name) => [
        name,
        {
          types: name === "./sdk" ? "./aggregate.d.ts" : "./narrow.d.ts",
        },
      ]),
    );
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(packageJson),
    );
    await expect(
      mod.buildSdkSurfaceSnapshot({ repoRoot: root }),
    ).rejects.toThrow(
      "onlyNarrow (exported by ./sdk/authoring, ./sdk/contracts",
    );
  });
});

describe("SDK surface snapshot command", () => {
  it("updates and checks an initial baseline", async () => {
    const mod = await loadModule();
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-sdk-snapshot-"));
    temporaryRoots.push(root);
    const target = path.join(root, "nested", "surface.json");
    const baseline = snapshot();
    await expect(
      mod.main(["--update"], {
        snapshotPath: target,
        buildSnapshot: async () => structuredClone(baseline),
      }),
    ).resolves.toMatchObject({ mode: "update", changed: true });
    await expect(
      mod.main(["--check"], {
        snapshotPath: target,
        buildSnapshot: async () => structuredClone(baseline),
      }),
    ).resolves.toMatchObject({ mode: "check", changed: false });
  });

  it("prints classified stale changes and refuses unacknowledged breakage", async () => {
    const mod = await loadModule();
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-sdk-breaking-"));
    temporaryRoots.push(root);
    const target = path.join(root, "surface.json");
    const previous = snapshot([
      {
        name: "create",
        kind: "function",
        classification: "supported",
        signature: "(title: string) => void",
      },
    ]);
    await writeFile(target, mod.stableJson(previous), "utf8");
    const next = snapshot([]);
    await expect(
      mod.main(["--check"], {
        snapshotPath: target,
        buildSnapshot: async () => structuredClone(next),
      }),
    ).rejects.toThrow("breaking: symbol ./sdk/core:create removed");
    await expect(
      mod.main(["--update"], {
        snapshotPath: target,
        buildSnapshot: async () => structuredClone(next),
      }),
    ).rejects.toThrow("require --acknowledge-breaking");
  });

  it("records an explicit breaking-change acknowledgement in the snapshot", async () => {
    const mod = await loadModule();
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-sdk-ack-"));
    temporaryRoots.push(root);
    const target = path.join(root, "surface.json");
    const previous = snapshot([
      {
        name: "create",
        kind: "function",
        classification: "supported",
        signature: "() => void",
      },
    ]);
    await writeFile(target, mod.stableJson(previous), "utf8");
    await mod.main(
      ["--update", "--acknowledge-breaking", "documented migration"],
      {
        snapshotPath: target,
        buildSnapshot: async () => snapshot(),
      },
    );
    const written = JSON.parse(
      await readFile(target, "utf8"),
    ) as SurfaceSnapshot;
    expect(written.breaking_acknowledgements).toEqual([
      expect.objectContaining({
        reason: "documented migration",
        changes: ["symbol ./sdk/core:create removed"],
      }),
    ]);
  });

  it(
    "requires exactly one command mode",
    async () => {
      const mod = await loadModule();
      await expect(mod.main([])).rejects.toThrow("Usage:");
      await expect(mod.main(["--check", "--update"])).rejects.toThrow("Usage:");
      await expect(mod.main(["--check"])).resolves.toMatchObject({
        mode: "check",
        changed: false,
      });
    },
    120_000,
  );

  it("executes, skips, and reports failures through the script entrypoint", async () => {
    const scriptPath = path.resolve("scripts/sdk-surface-snapshot.mjs");
    await expect(runEntrypoint(["node"])).resolves.toBe(false);
    await expect(
      runEntrypoint(["node", scriptPath], {
        runMain: async () => ({
          changed: true,
          snapshotPath: "surface.json",
          changes: [{ classification: "additive", subject: "symbol x" }],
        }),
      }),
    ).resolves.toBe(true);
    await expect(
      runEntrypoint(["node", scriptPath], {
        runMain: async () => ({
          changed: false,
          snapshotPath: "surface.json",
          changes: [],
        }),
      }),
    ).resolves.toBe(true);
    const previousExitCode = process.exitCode;
    await expect(
      runEntrypoint(["node", scriptPath], {
        runMain: async () => {
          throw "entrypoint failure";
        },
      }),
    ).resolves.toBe(false);
    await expect(
      runEntrypoint(["node", scriptPath], {
        runMain: async () => {
          throw new Error("entrypoint failure");
        },
      }),
    ).resolves.toBe(false);
    await expect(runEntrypoint(["node", scriptPath])).resolves.toBe(false);
    process.exitCode = previousExitCode;
  });
});
