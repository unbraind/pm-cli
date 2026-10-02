import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runIfMain, verifyDevelopmentBundles } from "../../../scripts/check-development-dependencies.mjs";

const require = createRequire(import.meta.resolve("@codspeed/vitest-plugin"));
const coreRoot = path.dirname(path.dirname(require.resolve("@codspeed/core")));
const policy = JSON.parse(await readFile("config/dependency-bundle-integrity.json", "utf8")) as {
  name: string;
  version: string;
  sha256: Record<string, string>;
};

describe("development dependency bundle admission", () => {
  it("admits the actual installed patch and its preserved native payload", async () => {
    await expect(verifyDevelopmentBundles(coreRoot, policy)).resolves.toBeUndefined();
    await runIfMain(undefined);
    await runIfMain("different-script.mjs");
    await runIfMain(path.resolve("scripts/check-development-dependencies.mjs"));
  });

  it("rejects stale bundles, source maps, native payloads, and missing integrity entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-dependency-admission-"));
    try {
      await cp(coreRoot, root, { recursive: true });
      for (const file of Object.keys(policy.sha256)) {
        const target = path.join(root, file);
        const original = await readFile(target);
        await writeFile(target, Buffer.concat([original, Buffer.from("stale embedded dependency")]));
        await expect(verifyDevelopmentBundles(root, policy)).rejects.toThrow(`CodSpeed bundle integrity mismatch: ${file}`);
        await writeFile(target, original);
      }
      const incomplete = { ...policy, sha256: { ...policy.sha256 } };
      delete incomplete.sha256["dist/index.es5.js.map"];
      await expect(verifyDevelopmentBundles(root, incomplete)).rejects.toThrow("Incomplete bundle integrity policy");
      await unlink(path.join(root, "dist/index.cjs.js"));
      await expect(verifyDevelopmentBundles(root, policy)).rejects.toThrow("ENOENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects renamed or upgraded packages before admitting their bundles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-dependency-identity-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "unrelated", version: policy.version }));
      await expect(verifyDevelopmentBundles(root, policy)).rejects.toThrow("Unexpected CodSpeed package identity");
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: policy.name, version: "6.0.0" }));
      await expect(verifyDevelopmentBundles(root, policy)).rejects.toThrow("CodSpeed upgrade requires a reviewed patch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
