/** Bounded registry and OSV evidence adapters; no severity suppressions (pm-eqxjzl). */
import assert from "node:assert/strict";
import { runCommand } from "../utils.mjs";

export const OSV_ENDPOINT = "https://api.osv.dev/v1/querybatch";
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

/** Preserve pnpm's all-dependency, all-severity policy and reject unknown outcomes. */
export function queryRegistry(root) {
  // Fixed arguments only: native Windows cannot spawn a .cmd file directly.
  const windows = process.platform === "win32";
  const result = runCommand(windows ? "cmd.exe" : "pnpm", windows ? ["/d", "/s", "/c", "pnpm.cmd audit --json"] : ["audit", "--json"], {
    cwd: root, capture: true, allowFailure: true, timeout: 60000,
  });
  const report = JSON.parse(result.stdout);
  const counts = report.metadata?.vulnerabilities;
  assert.ok(counts && SEVERITIES.every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0), "Incomplete registry audit counts");
  const count = SEVERITIES.reduce((sum, key) => sum + counts[key], 0);
  assert.ok(!result.error_code && !result.signal && result.status === (count === 0 ? 0 : 1), "Registry audit command did not complete");
  assert.ok(report.advisories && typeof report.advisories === "object" && !Array.isArray(report.advisories), "Missing registry advisories");
  const ids = Object.keys(report.advisories).sort();
  assert.equal(ids.length === 0, count === 0, "Contradictory registry audit counts");
  return { status: "complete", counts, ids, observed_at: new Date().toISOString(), database_updated_at: null };
}

/** Query every locked npm version once; incomplete pages or failures cannot pass. */
export async function queryOsv(packages) {
  const rows = [];
  const deadline = AbortSignal.timeout(120000);
  for (let offset = 0; offset < packages.length; offset += 100) {
    const batch = packages.slice(offset, offset + 100);
    const response = await fetch(OSV_ENDPOINT, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: batch.map(({ name, version }) => ({ package: { name, ecosystem: "npm" }, version })) }),
      signal: AbortSignal.any([deadline, AbortSignal.timeout(15000)]),
    });
    assert.ok(response.ok, "OSV request unavailable");
    const body = await response.json();
    assert.ok(Array.isArray(body.results) && body.results.length === batch.length, "Incomplete OSV coverage");
    body.results.forEach((result, index) => {
      assert.ok(result && typeof result === "object" && !Array.isArray(result) && Object.keys(result).every((key) => key === "vulns"), "Incomplete or paginated OSV result");
      const vulns = result.vulns === undefined ? [] : result.vulns;
      assert.ok(Array.isArray(vulns), "Invalid OSV advisories");
      const ids = vulns.map((vuln) => {
        assert.ok(typeof vuln?.id === "string" && /^[A-Za-z0-9._-]{1,160}$/u.test(vuln.id), "Invalid OSV advisory identity");
        return vuln.id;
      });
      rows.push({ ...batch[index], ids: [...new Set(ids)].sort() });
    });
  }
  return { status: "complete", endpoint: OSV_ENDPOINT, rows, observed_at: new Date().toISOString(), database_updated_at: null };
}
