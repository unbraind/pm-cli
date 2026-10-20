/** Local-only SDK provider receipt validation (pm-eqxjzl). */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { OSV_ENDPOINT } from "./feeds.mjs";
import { readInputs } from "./inventory.mjs";

export const RECEIPT_VERSION = 1;
export const MAX_AGE_MS = 15 * 60 * 1000;

/** A fresh query is evidence of retrieval, never proof of database freshness. */
export async function verifyReceipt(root, receiptPath) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const current = await readInputs(root);
  assert.equal(receipt.version, RECEIPT_VERSION, "Unsupported advisory receipt");
  assert.equal(receipt.status, "complete", "Dependency evidence unavailable");
  assert.deepEqual(receipt.inputs, current.inputs, "Dependency inputs changed");
  assert.equal(receipt.scope, "all-pnpm-lock-packages-including-dev-optional", "Incomplete dependency scope");
  const started = Date.parse(receipt.started_at);
  const completed = Date.parse(receipt.completed_at);
  assert.ok(Number.isFinite(started) && Number.isFinite(completed) && started <= completed && completed <= Date.now() && Date.now() - started <= MAX_AGE_MS, "Stale or invalid advisory receipt");
  const { registry, osv } = receipt.feeds;
  for (const feed of [registry, osv]) {
    const observed = Date.parse(feed.observed_at);
    assert.ok(feed.status === "complete" && observed >= started && observed <= completed && feed.database_updated_at === null, "Unavailable or invalid advisory source");
  }
  assert.equal(osv.endpoint, OSV_ENDPOINT, "Unexpected advisory source");
  assert.deepEqual(osv.rows.map(({ name, version }) => ({ name, version })), current.packages, "Incomplete independent advisory coverage");
  assert.ok(osv.rows.every((row) => Array.isArray(row.ids) && row.ids.length === 0), "Independent source reports vulnerable dependencies");
  assert.deepEqual(registry.counts, { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }, "Registry reports vulnerable dependencies");
  assert.deepEqual(registry.ids, [], "Registry reports vulnerable dependencies");
  return { verdict: "pass", packages: current.packages.length, inputs: current.inputs, started_at: receipt.started_at, completed_at: receipt.completed_at, database_freshness: "unknown" };
}
