import { describe, expect, it } from "vitest";
import { assessMutationReport, mutationIdentity } from "../../../../scripts/release/mutation-score.mjs";

const filename = "src/sdk/example.ts";
const source = "export const value = true;";
const mutant = { mutatorName: "BooleanLiteral", replacement: "false", location: { start: { line: 1, column: 22 }, end: { line: 1, column: 26 } }, status: "Killed" };
const sources = { [filename]: source };
const policy = { minimumScore: 100, equivalentMutants: [] };

describe("SDK mutation evidence", () => {
  it("requires killed mutants and rejects surviving, uncovered, ignored and errored mutants", () => {
    const report = { files: { [filename]: { source, mutants: [mutant] } } };
    expect(assessMutationReport(report, policy, sources)).toEqual({ total: 1, killed: 1, equivalent: 0, score: 100, failures: [] });
    for (const status of ["Survived", "NoCoverage", "Ignored", "Timeout", "CompileError", "RuntimeError", "unknown"]) {
      const result = assessMutationReport({ files: { [filename]: { source, mutants: [{ ...mutant, status }] } } }, policy, sources);
      expect(result.failures).toContainEqual(expect.stringContaining(status));
      expect(result.failures).toContainEqual(expect.stringContaining("below floor"));
    }
  });

  it("accepts only exact owned equivalents, and forces stale waivers to be removed", () => {
    const identity = mutationIdentity(filename, mutant);
    const waived = { minimumScore: 0, equivalentMutants: [{ identity, reason: "Both expressions serialize to the same JSON bytes", owner: "pm-zclzll" }] };
    const report = { files: { [filename]: { source, mutants: [{ ...mutant, status: "Survived" }] } } };
    expect(assessMutationReport(report, waived, sources).failures).toEqual([]);
    report.files[filename].mutants[0].status = "Killed";
    expect(assessMutationReport(report, waived, sources).failures).toContain(`${filename}: remove stale waiver ${identity}`);
    expect(assessMutationReport(report, { ...waived, equivalentMutants: [{ ...waived.equivalentMutants[0], identity: "a".repeat(64) }] }, sources).failures).toContain(`remove absent waiver ${"a".repeat(64)}`);
    for (const bad of [
      { ...waived.equivalentMutants[0], reason: " " },
      { ...waived.equivalentMutants[0], owner: "" },
      { ...waived.equivalentMutants[0], identity: "bad" },
      { identity },
    ]) expect(() => assessMutationReport(report, { ...waived, equivalentMutants: [bad] }, sources)).toThrow(/Invalid/);
    expect(() => assessMutationReport(report, { ...waived, equivalentMutants: [...waived.equivalentMutants, ...waived.equivalentMutants] }, sources)).toThrow(/duplicate/);
  });

  it("fails closed for missing scope, stale bytes, empty reports and duplicate evidence", () => {
    const report = { files: { [filename]: { source, mutants: [mutant] } } };
    expect(() => assessMutationReport(report, policy, {})).toThrow(/scope/);
    expect(() => assessMutationReport(report, policy, { [filename]: "changed" })).toThrow(/stale/);
    expect(() => assessMutationReport({ files: { [filename]: { source, mutants: [] } } }, policy, sources)).toThrow(/missing mutants/);
    expect(() => assessMutationReport({ files: { [filename]: { source, mutants: [mutant, mutant] } } }, policy, sources)).toThrow(/duplicate/);
    expect(assessMutationReport({ files: {} }, policy, {}).failures).not.toEqual([]);
    for (const minimumScore of [-1, 101, Number.NaN]) expect(() => assessMutationReport(report, { ...policy, minimumScore }, sources)).toThrow(/floor/);
  });
});
