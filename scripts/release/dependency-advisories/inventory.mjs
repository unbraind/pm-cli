/** Complete npm package inventory for the repository advisory gate (pm-eqxjzl). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

/** Hash exact inputs rather than trusting counts in an old receipt. */
export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Refuse unsupported lockfile entries instead of silently reducing coverage. */
export function inventoryLock(text) {
  const document = parseDocument(text);
  assert.equal(document.errors.length, 0, "Invalid dependency lockfile");
  const lock = document.toJS();
  if (lock === null || typeof lock !== "object") throw new Error("Invalid dependency lockfile object");
  assert.equal(lock.lockfileVersion, "9.0", "Unsupported dependency lockfile version");
  assert.ok(lock.packages && typeof lock.packages === "object" && !Array.isArray(lock.packages), "Missing lockfile package inventory");
  const packages = Object.entries(lock.packages).map(([key, entry]) => {
    const match = /^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u.exec(key);
    assert.ok(match && entry?.resolution?.integrity && !entry.resolution.tarball, "Unsupported package identity or resolution");
    return { name: match[1], version: match[2] };
  }).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  assert.ok(packages.length > 0 && packages.length <= 5000, "Dependency population outside bounded coverage");
  return packages;
}

/** Include manifests that can alter registry audit resolution as well as the lock. */
export async function readInputs(root) {
  const names = ["pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml"];
  const texts = await Promise.all(names.map((name) => readFile(path.join(root, name), "utf8")));
  return {
    inputs: Object.fromEntries(names.map((name, index) => [name, digest(texts[index])])),
    packages: inventoryLock(texts[0]),
  };
}
