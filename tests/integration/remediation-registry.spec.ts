import { describe, expect, it } from "vitest";
import {
  REMEDIATION_REGISTRY,
  buildRemediationCommands,
  buildRemediationMap,
  resolveRemediation,
} from "../../src/core/diagnostics/remediation.js";

describe("shared remediation registry", () => {
  it("exposes a non-empty, internally-consistent registry", () => {
    expect(REMEDIATION_REGISTRY.length).toBeGreaterThan(0);
    for (const entry of REMEDIATION_REGISTRY) {
      expect(entry.code.length).toBeGreaterThan(0);
      expect(entry.command.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  it("keeps every registry code mutually exclusive under colon-boundary matching", () => {
    // First-match resolution is only correct if no code matches another code's
    // sample warning. Guard that invariant so a future overlapping code is caught.
    for (const outer of REMEDIATION_REGISTRY) {
      const sampleWarning = `${outer.code}:sample`;
      expect(resolveRemediation(sampleWarning)?.code).toBe(outer.code);
      expect(resolveRemediation(outer.code)?.code).toBe(outer.code);
    }
  });

  describe("resolveRemediation", () => {
    it("matches an exact warning code", () => {
      expect(resolveRemediation("vectorization_stale_items_remaining")?.command).toBe(
        "pm health --refresh-vectors",
      );
    });

    it("matches a code followed by a colon-delimited suffix", () => {
      expect(resolveRemediation("history_drift_missing_stream:pm-abcd")?.command).toBe(
        "pm history-repair <id>",
      );
    });

    it("trims surrounding whitespace before matching", () => {
      expect(resolveRemediation("  history_drift_missing_stream:pm-abcd  ")?.code).toBe(
        "history_drift_missing_stream",
      );
    });

    it("keeps sibling dependency-cycle codes disjoint at the colon boundary", () => {
      expect(resolveRemediation("validate_lifecycle_dependency_cycles:2")?.code).toBe(
        "validate_lifecycle_dependency_cycles",
      );
      expect(resolveRemediation("validate_lifecycle_dependency_cycles_error:2")?.code).toBe(
        "validate_lifecycle_dependency_cycles_error",
      );
    });

    it("does not match a code when the next character is not a colon", () => {
      // `history_drift_missing_stream` must not match `history_drift_missing_streams`.
      expect(resolveRemediation("validate_history_drift_missing_streams:3")?.code).toBe(
        "validate_history_drift_missing_streams",
      );
    });

    it("returns undefined for an unknown warning code", () => {
      expect(resolveRemediation("totally_unknown_warning:1")).toBeUndefined();
    });

    it("returns undefined for non-string input (defensive for untyped SDK callers)", () => {
      expect(resolveRemediation(undefined as unknown as string)).toBeUndefined();
      expect(resolveRemediation(123 as unknown as string)).toBeUndefined();
    });
  });

  describe("buildRemediationMap", () => {
    it("maps known warnings to their fix commands and skips unknown codes", () => {
      const map = buildRemediationMap([
        "history_drift_missing_stream:pm-a",
        "vectorization_stale_items_remaining:4",
        "totally_unknown_warning:1",
      ]);
      expect(map).toEqual({
        history_drift_missing_stream: "pm history-repair <id>",
        vectorization_stale_items_remaining: "pm health --refresh-vectors",
      });
    });

    it("dedupes multiple warnings that share a code (first wins)", () => {
      const map = buildRemediationMap([
        "history_drift_missing_stream:pm-a",
        "history_drift_missing_stream:pm-b",
      ]);
      expect(Object.keys(map)).toEqual(["history_drift_missing_stream"]);
    });

    it("returns an empty map for no warnings", () => {
      expect(buildRemediationMap([])).toEqual({});
    });
  });

  describe("buildRemediationCommands", () => {
    it("returns a deduped, ordered list of executable commands", () => {
      const commands = buildRemediationCommands([
        "validate_metadata_missing_reviewer:1",
        "validate_metadata_missing_estimate:1",
        "validate_metadata_missing_reviewer:2",
      ]);
      expect(commands).toEqual([
        'pm update <id> --reviewer "<name>"',
        'pm update <id> --estimate "<estimate>"',
      ]);
    });

    it("returns an empty list when nothing matches", () => {
      expect(buildRemediationCommands(["totally_unknown_warning:1"])).toEqual([]);
    });
  });
});
