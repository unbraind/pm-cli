/**
 * Remedy selection for history drift (pm-3os5p6): which preview refusals turn
 * a chain mismatch into an unbridgeable or unrepairable stream, and when a
 * bulk repair may stand in for the per-item remedies.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import type { HealthCheck } from "../../../../src/sdk/governance/health.js";

const runHistoryRepair = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/sdk/history-repair.js", () => ({ runHistoryRepair }));

const {
  applyUnbridgeableChainMismatches,
  findUnbridgeableChainMismatches,
  rewriteBulkHistoryDriftRemediation,
} = await import("../../../../src/sdk/governance/health/history-drift-remedies.js");

function driftCheck(details: Record<string, unknown>, warnings: string[] = []) {
  return {
    check: { name: "history_drift", status: "warn", ok: false, details } as HealthCheck,
    warnings,
  };
}

/** Answer each preview by item id and mode with a refusal or success. */
function previews(answers: Record<string, unknown>): void {
  runHistoryRepair.mockImplementation(async (id: string, options: { appendOnly: boolean }) => {
    const answer = answers[`${id}:${options.appendOnly ? "append" : "rewrite"}`];
    if (answer !== undefined) throw answer;
    return { changed: true };
  });
}

describe("history drift remedies", () => {
  beforeEach(() => {
    runHistoryRepair.mockReset();
  });

  it("keeps bridgeable streams and records each refusal with its reason", async () => {
    previews({
      "pm-reason:append": new PmCliError("no bridge", 4, { code: "history_append_only_repair_unavailable", reason: "patch_does_not_replay" }),
      "pm-code:append": new PmCliError("no bridge", 4, { code: "history_record_invalid" }),
      "pm-code:rewrite": new PmCliError("no rewrite", 4, { code: "history_record_integrity_invalid", reason: "record_hash_mismatch" }),
      "pm-bare:append": new PmCliError("no bridge", 4),
      "pm-bare:rewrite": new Error("boom"),
    });
    const check = driftCheck({
      chain_mismatches: ["pm-bare", "pm-bridge", "pm-code", "pm-reason", "pm-skew", 7],
      version_skews: ["pm-skew"],
    });
    await expect(findUnbridgeableChainMismatches(check, { path: "/tracker" })).resolves.toEqual([
      { id: "pm-bare", reason: "append_only_preview_failed", rewrite_refusal: "rewrite_preview_failed" },
      { id: "pm-code", reason: "history_record_invalid", rewrite_refusal: "record_hash_mismatch" },
      { id: "pm-reason", reason: "patch_does_not_replay" },
    ]);
    // A version-skewed stream is never previewed, and malformed details are ignored.
    expect(runHistoryRepair.mock.calls.map(([id]) => id)).not.toContain("pm-skew");
    await expect(findUnbridgeableChainMismatches(driftCheck({ chain_mismatches: "pm-x" }), {})).resolves.toEqual([]);
  });

  it("re-codes refused chain mismatches and drops the redundant warning of a skewed stream", () => {
    const check = driftCheck({ chain_mismatches: ["pm-a", "pm-b", "pm-c", "pm-skew"], version_skews: ["pm-skew"] }, [
      "history_drift_chain_mismatch:pm-c",
      "history_drift_chain_mismatch:pm-b",
      "history_drift_chain_mismatch:pm-a",
      "history_drift_chain_mismatch:pm-skew",
      "history_drift_version_skew:pm-skew",
    ]);
    check.warnings.push(
      "history_drift_hash_mismatch:pm-a",
      "history_drift_hash_mismatch:pm-b",
      "history_drift_hash_mismatch:pm-skew",
      "history_drift_workspace_state_mismatch:a:b.json",
    );
    applyUnbridgeableChainMismatches(check, [
      { id: "pm-a", reason: "patch_does_not_replay" },
      { id: "pm-b", reason: "chain_failure_not_a_break", rewrite_refusal: "record_hash_mismatch" },
    ]);
    // An unrepairable or skewed stream keeps only its verdict; a rewritable one keeps its hash advice.
    expect(check.warnings).toEqual([
      "history_drift_chain_mismatch:pm-c",
      "history_drift_chain_unbridgeable:pm-a",
      "history_drift_chain_unrepairable:pm-b",
      "history_drift_hash_mismatch:pm-a",
      "history_drift_version_skew:pm-skew",
      "history_drift_workspace_state_mismatch:a:b.json",
    ]);
    expect(check.check.details.chain_unbridgeable).toHaveLength(2);
    // With nothing refused, the details stay as the scan wrote them.
    const clean = driftCheck({ chain_mismatches: ["pm-c"] }, ["history_drift_chain_mismatch:pm-c"]);
    applyUnbridgeableChainMismatches(clean, []);
    expect(clean.warnings).toEqual(["history_drift_chain_mismatch:pm-c"]);
    expect(clean.check.details).not.toHaveProperty("chain_unbridgeable");
  });

  it("chooses a bulk remedy only when it repairs every stream it runs on", () => {
    const bulk = (codes: Record<string, string>) => {
      const map = { ...codes };
      rewriteBulkHistoryDriftRemediation(map);
      return map;
    };
    expect(bulk({
      history_drift_chain_mismatch: "pm history-repair <id> --append-only",
      history_drift_missing_stream: "pm history-repair <id>",
    })).toEqual({
      history_drift_chain_mismatch: "pm history-repair --all --append-only",
      history_drift_missing_stream: "pm history-repair --all --append-only",
    });
    expect(bulk({
      history_drift_chain_mismatch: "pm history-repair <id> --append-only",
      history_drift_hash_mismatch: "pm history-repair <id>",
      history_drift_chain_unbridgeable: "pm history-repair <id>",
    })).toEqual({
      history_drift_chain_mismatch: "pm history-repair <id> --append-only",
      history_drift_hash_mismatch: "pm history-repair --all",
      history_drift_chain_unbridgeable: "pm history-repair --all",
    });
    for (const blocking of [
      "history_drift_unreadable_stream",
      "history_drift_chain_unrepairable",
      "history_drift_version_skew",
      "history_drift_merge_receipt",
    ]) {
      const codes = { history_drift_hash_mismatch: "pm history-repair <id>", [blocking]: "per item" };
      expect(bulk(codes)).toEqual(codes);
    }
  });
});
