import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findPackageSdkContractMirrors,
  loadPackageSdkContractSources,
  main,
  runIfMain,
} from "../../../../scripts/release/package-sdk-contract-parity.mjs";

describe("package SDK contract parity gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("rejects public type redeclarations and hand-written SDK module signatures", () => {
    expect(
      findPackageSdkContractMirrors(
        [
          {
            path: "packages/pm-demo/extensions/demo/runtime.ts",
            text: [
              "interface LocatedItem { id: string }",
              "interface DemoSdkModule {",
              "  listAllItemMetadata(root: string): Promise<unknown[]>;",
              "  (): void;",
              '  "locateItem"(): void;',
              "}",
            ].join("\n"),
          },
        ],
        new Set(["LocatedItem", "listAllItemMetadata", "locateItem"]),
      ),
    ).toEqual([
      {
        path: "packages/pm-demo/extensions/demo/runtime.ts",
        line: 1,
        name: "LocatedItem",
        kind: "public_contract_redeclaration",
      },
      {
        path: "packages/pm-demo/extensions/demo/runtime.ts",
        line: 5,
        name: "locateItem",
        kind: "sdk_module_signature_mirror",
      },
      {
        path: "packages/pm-demo/extensions/demo/runtime.ts",
        line: 3,
        name: "listAllItemMetadata",
        kind: "sdk_module_signature_mirror",
      },
    ].sort((left, right) => left.line - right.line));
  });

  it("permits authoritative imports and typeof-derived module contracts", () => {
    expect(
      findPackageSdkContractMirrors(
        [
          {
            path: "packages/pm-demo/extensions/demo/runtime.ts",
            text: [
              'import * as sdk from "@unbrained/pm-cli/sdk";',
              'import type { LocatedItem } from "@unbrained/pm-cli/sdk";',
              "type DemoSdkModule = typeof sdk;",
              "const located: LocatedItem | null = null;",
            ].join("\n"),
          },
        ],
        new Set(["LocatedItem", "listAllItemMetadata"]),
      ),
    ).toEqual([]);
  });

  it("keeps every shipped package source aligned with the public SDK", () => {
    const loaded = loadPackageSdkContractSources();
    expect(
      findPackageSdkContractMirrors(
        loaded.packageSources,
        loaded.publicSdkExports,
      ),
    ).toEqual([]);
  });

  it("fails closed when the SDK surface snapshot has no symbol array", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pm-sdk-parity-"));
    try {
      mkdirSync(path.join(root, "sdk"));
      writeFileSync(
        path.join(root, "sdk/public-surface.json"),
        JSON.stringify({ entrypoints: { "./sdk": {} } }),
      );
      expect(() => loadPackageSdkContractSources(root)).toThrow(
        "sdk/public-surface.json is missing entrypoints['./sdk'].symbols",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads only named object symbols from the SDK surface snapshot", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pm-sdk-parity-"));
    try {
      mkdirSync(path.join(root, "sdk"));
      writeFileSync(
        path.join(root, "sdk/public-surface.json"),
        JSON.stringify({
          entrypoints: {
            "./sdk": {
              symbols: [null, "invalid", {}, { name: 3 }, { name: "LocatedItem" }],
            },
          },
        }),
      );
      const loaded = loadPackageSdkContractSources(root);
      expect(loaded.packageSources).toEqual([]);
      expect([...loaded.publicSdkExports]).toEqual(["LocatedItem"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports clean and violating gate outcomes", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    main({ packageSources: [], publicSdkExports: new Set() });
    expect(log).toHaveBeenCalledWith(
      "Package SDK contract parity gate passed.",
    );

    main({
      packageSources: [
        {
          path: "packages/pm-demo/extensions/demo/runtime.ts",
          text: "type LocatedItem = unknown;",
        },
      ],
      publicSdkExports: new Set(["LocatedItem"]),
    });
    expect(error).toHaveBeenCalledWith(
      "Package SDK contract mirrors detected:",
    );
    expect(error).toHaveBeenCalledWith(
      "- packages/pm-demo/extensions/demo/runtime.ts:1 public_contract_redeclaration: LocatedItem",
    );
    expect(process.exitCode).toBe(1);
  });

  it("only executes for the invoked entrypoint", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runIfMain("");
    runIfMain("/tmp/not-the-gate.mjs");
    expect(log).not.toHaveBeenCalled();

    runIfMain(
      fileURLToPath(
        new URL(
          "../../../../scripts/release/package-sdk-contract-parity.mjs",
          import.meta.url,
        ),
      ),
    );
    expect(log).toHaveBeenCalledWith(
      "Package SDK contract parity gate passed.",
    );
  });
});
