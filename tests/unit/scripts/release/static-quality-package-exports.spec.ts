import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectPackageExportSourceEntries } from "../../../../scripts/release/static-quality-gate.mts";

describe("static quality package export entrypoints", () => {
  it("maps nested type conditions back to their TypeScript source modules", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-static-quality-package-exports-"),
    );
    const packageJsonPath = path.join(tempRoot, "package.json");
    try {
      await writeFile(
        packageJsonPath,
        JSON.stringify({
          exports: {
            "./sdk/contracts": {
              types: "./dist/sdk/contracts.d.ts",
              import: "./dist/cli-bundle/sdk-contracts.js",
            },
            "./sdk/query": [
              { types: "./dist/sdk/query.d.mts" },
              "./dist/ignored.js",
            ],
            ignored: [null, false, 42],
          },
        }),
        "utf8",
      );

      expect(
        [...collectPackageExportSourceEntries(packageJsonPath)].sort(),
      ).toEqual(["src/sdk/contracts.ts", "src/sdk/query.ts"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns no entrypoints when package metadata is unreadable", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-static-quality-package-exports-invalid-"),
    );
    const packageJsonPath = path.join(tempRoot, "package.json");
    try {
      await writeFile(packageJsonPath, "{not-json", "utf8");
      expect([...collectPackageExportSourceEntries(packageJsonPath)]).toEqual(
        [],
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
