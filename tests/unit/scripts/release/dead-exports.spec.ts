import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("private export gate", () => {
  it("declares every published TypeScript entrypoint and remains mandatory", () => {
    const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as { exports: Record<string, unknown>; scripts: Record<string, string> };
    const config = JSON.parse(readFileSync(path.join(repositoryRoot, "knip.json"), "utf8")) as { entry: string[]; include: string[]; ignoreIssues?: unknown; ignore?: unknown };
    for (const value of Object.values(manifest.exports)) {
      if (typeof value !== "object" || value === null || !("types" in value)) continue;
      expect(config.entry).toContain(String(value.types).replace(/^\.\/dist\//u, "src/").replace(/\.d\.ts$/u, ".ts"));
    }
    expect(config.include).toEqual(["exports", "types"]);
    expect(config.ignoreIssues).toBeUndefined();
    expect(config.ignore).toBeUndefined();
    expect(manifest.scripts["quality:static"]).toContain("pnpm quality:exports &&");
    expect(manifest.scripts["quality:exports"]).toBe("knip --no-config-hints && node scripts/run-tests.mjs test -- tests/unit/scripts/release/dead-exports.spec.ts");
  });

  it("accepts external SDK contracts but rejects unused private values and types", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pm-dead-exports-"));
    try {
      mkdirSync(path.join(root, "src/sdk"), { recursive: true });
      writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
      writeFileSync(path.join(root, "knip.json"), readFileSync(path.join(repositoryRoot, "knip.json")));
      writeFileSync(path.join(root, "src/sdk/index.ts"), 'export { publishedValue } from "./contract.js";\nexport type { PublishedType } from "./contract.js";\n');
      writeFileSync(path.join(root, "src/sdk/contract.ts"), 'export const publishedValue = 1;\nexport interface PublishedType { id: string }\n');
      writeFileSync(path.join(root, "src/cli.ts"), 'import { used } from "./private.js";\nconsole.log(used);\n');
      const modulePath = path.join(root, "src/private.ts");
      writeFileSync(modulePath, "export const used = 1;\n");
      const executable = path.join(repositoryRoot, "node_modules/knip/bin/knip.js");
      const options = { cwd: root, encoding: "utf8" as const, timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "" } };
      const clean = spawnSync(process.execPath, [executable, "--reporter", "json", "--no-progress", "--no-config-hints"], options);
      expect(clean.error).toBeUndefined();
      expect(clean.status, clean.stdout + clean.stderr).toBe(0);
      writeFileSync(modulePath, "export const used = 1;\nexport const unusedPrivateValue = 2;\nexport interface UnusedPrivateType { value: number }\n");
      const refused = spawnSync(process.execPath, [executable, "--reporter", "json", "--no-progress", "--no-config-hints"], options);
      expect(refused.error).toBeUndefined();
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain("unusedPrivateValue");
      expect(refused.stdout).toContain("UnusedPrivateType");
      expect(refused.stdout).not.toContain("publishedValue");
      expect(refused.stdout).not.toContain("PublishedType");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 70_000);
});
