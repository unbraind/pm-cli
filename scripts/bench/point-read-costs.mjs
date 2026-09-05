/**
 * Point-read corpus scaling proof for pm-ydshl9. The existing SDK-backed fixture
 * generator creates valid item/history files; each tier reads the same Epic id.
 * Run after build: node scripts/bench/point-read-costs.mjs 100 10000 100000.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PmClient } from "@unbrained/pm-cli/sdk/runtime";
import { generateSyntheticWorkspace } from "./scale-workspace.mjs";

/** Hold the addressed item constant while varying the unrelated corpus and requested facets. */
export async function measurePointReadCosts(sizes = [100], iterations = 10) {
  for (const value of [...sizes, iterations]) assert(Number.isSafeInteger(value) && value > 0, "Sizes and iterations must be positive integers");
  const reports = [];
  let identity;
  for (const itemCount of sizes) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-point-read-costs-"));
    try {
      const manifest = await generateSyntheticWorkspace({ workspaceRoot: path.join(root, "workspace"), itemCount });
      const client = new PmClient({ pmRoot: manifest.pm_root, noExtensions: true });
      const projection = await client.get(manifest.sample_ids.get, { fields: "id,title,type" });
      identity ??= projection.item;
      assert.deepEqual(projection.item, identity, "The measured item changed between corpus sizes");
      const timings = {};
      for (const [mode, options] of Object.entries({ standard: {}, brief: { depth: "brief" }, fields: { fields: "id,title" } })) {
        const samples = [];
        for (let index = 0; index < iterations; index += 1) {
          const started = performance.now();
          const result = await client.get(manifest.sample_ids.get, options);
          samples.push(performance.now() - started);
          assert.equal(result.children, undefined, "An unrequested child scan was reintroduced");
        }
        samples.sort((left, right) => left - right);
        timings[mode] = { minimum_ms: samples[0], p95_ms: samples[Math.ceil(samples.length * 0.95) - 1] };
      }
      const started = performance.now();
      const explicit = await client.get(manifest.sample_ids.get, { fields: "id,children" });
      assert.equal(explicit.children.scanned, itemCount, "The explicit scan negative control did not see the complete corpus");
      reports.push({ item_count: itemCount, item_id: manifest.sample_ids.get, iterations, timings, explicit_children_ms: performance.now() - started, explicit_children_scanned: explicit.children.scanned });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  return reports;
}

/** Execute standalone measurements while preserving import-only test use. */
export async function runEntrypoint(argv = process.argv) {
  if (argv[1] === undefined || path.resolve(argv[1]) !== fileURLToPath(import.meta.url)) return false;
  const sizes = argv.slice(2).map(Number);
  console.log(JSON.stringify(await measurePointReadCosts(sizes.length === 0 ? undefined : sizes), null, 2));
  return true;
}

await runEntrypoint();
