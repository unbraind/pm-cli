/** Prove complete-set reconciliation and evidence-scoped historical settlement. */
import { describe, expect, it } from "vitest";
import { reconcileArtifactLedgers, type ArtifactLedgerSnapshot, type ArtifactLedgerException } from "../../../../src/sdk/governance/artifact-ledgers.js";

const snapshots: ArtifactLedgerSnapshot[] = [
  { name: "documented", complete: true, identities: ["one", "two"] },
  { name: "tagged", complete: true, identities: ["one", "three"] },
  { name: "delivered", complete: true, identities: ["one", "four"] },
];
const exception: ArtifactLedgerException = { identity: "two", missing_from: ["tagged", "delivered"], reason: "Historical declaration was never delivered.", evidence: "decision:historical-two" };

describe("artifact ledger reconciliation", () => {
  it("preserves every discrepancy and sorts independently of input order", () => {
    const report = reconcileArtifactLedgers(snapshots);
    expect(report).toEqual({ schema: "pm-artifact-ledgers/1", ok: false, counts: { documented: 2, tagged: 2, delivered: 2 }, findings: [
      { identity: "four", present_in: ["delivered"], missing_from: ["documented", "tagged"], disposition: null },
      { identity: "three", present_in: ["tagged"], missing_from: ["delivered", "documented"], disposition: null },
      { identity: "two", present_in: ["documented"], missing_from: ["delivered", "tagged"], disposition: null },
    ], stale_exceptions: [] });
    expect(reconcileArtifactLedgers([...snapshots].reverse().map((row) => ({ ...row, identities: [...row.identities].reverse() })))).toEqual(report);
  });

  it("settles only the exact recorded discrepancy and exposes stale settlement", () => {
    const pair = snapshots.slice(0, 2);
    const exceptions = [exception, { ...exception, identity: "three", missing_from: ["documented"] }];
    const report = reconcileArtifactLedgers(snapshots, [exception]);
    expect(report.findings.find((row) => row.identity === "two")?.disposition).toEqual({ reason: exception.reason, evidence: exception.evidence });
    expect(report.ok).toBe(false);
    expect(reconcileArtifactLedgers(pair, [{ ...exception, missing_from: ["tagged"] }, exceptions[1]!]).ok).toBe(true);
    expect(reconcileArtifactLedgers(pair, [{ ...exception, missing_from: ["documented"] }]).stale_exceptions).toEqual(["two"]);
    expect(reconcileArtifactLedgers(snapshots, [{ ...exception, identity: "one" }]).stale_exceptions).toEqual(["one"]);
  });

  it("never allows an exception to cover new drift or disappear from the receipt", () => {
    const rows = snapshots.map((row) => ({ ...row, identities: ["one"] }));
    expect(reconcileArtifactLedgers(rows).ok).toBe(true);
    rows[0]!.identities.push("new");
    expect(reconcileArtifactLedgers(rows, [exception])).toMatchObject({ ok: false, stale_exceptions: ["two"], findings: [{ identity: "new", disposition: null }] });
  });

  it.each([
    [], [snapshots[0]!], snapshots.map((row) => ({ ...row, identities: [] })),
    [snapshots[0]!, snapshots[0]!], [{ ...snapshots[0]!, name: " " }, snapshots[1]!],
    [{ ...snapshots[0]!, complete: false }, snapshots[1]!],
    [{ ...snapshots[0]!, identities: ["one", "one"] }, snapshots[1]!],
    [{ ...snapshots[0]!, identities: [""] }, snapshots[1]!],
    [{ ...snapshots[0]!, identities: [42 as unknown as string] }, snapshots[1]!],
  ])("refuses incomplete or vacuous evidence %j", (...rows) => {
    expect(() => reconcileArtifactLedgers(rows)).toThrow(TypeError);
  });

  it.each([
    { rows: null, message: "Expected at least two artifact ledgers." },
    { rows: {}, message: "Expected at least two artifact ledgers." },
    { rows: [null, snapshots[1]!], message: "Expected unique complete artifact ledgers." },
    { rows: [42, snapshots[1]!], message: "Expected unique complete artifact ledgers." },
    { rows: [{ ...snapshots[0]!, identities: null }, snapshots[1]!], message: "Invalid or duplicate artifact identity." },
    { rows: [{ ...snapshots[0]!, identities: "one" }, snapshots[1]!], message: "Invalid or duplicate artifact identity." },
  ])("identifies malformed JavaScript inventory inputs %j", ({ rows, message }) => {
    expect(() => reconcileArtifactLedgers(rows as unknown as ArtifactLedgerSnapshot[])).toThrow(new TypeError(message));
  });

  it.each([
    { reason: " " }, { evidence: "" }, { identity: "" }, { missing_from: [] },
    { missing_from: ["unknown"] }, { missing_from: ["tagged", "tagged"] },
    { missing_from: ["tagged", "delivered", "documented"] },
  ])("refuses unsupported settlement %j", (change) => {
    expect(() => reconcileArtifactLedgers(snapshots, [{ ...exception, ...change }])).toThrow(TypeError);
  });

  it.each([
    { exceptions: null, message: "Expected unique evidence-backed artifact exceptions." },
    { exceptions: {}, message: "Expected unique evidence-backed artifact exceptions." },
    { exceptions: [null], message: "Expected unique evidence-backed artifact exceptions." },
    { exceptions: [42], message: "Expected unique evidence-backed artifact exceptions." },
    { exceptions: [{ ...exception, missing_from: undefined }], message: "Invalid artifact exception ledger signature." },
    { exceptions: [{ ...exception, missing_from: null }], message: "Invalid artifact exception ledger signature." },
    { exceptions: [{ ...exception, missing_from: "tagged" }], message: "Invalid artifact exception ledger signature." },
    { exceptions: [{ ...exception, missing_from: {} }], message: "Invalid artifact exception ledger signature." },
  ])("identifies malformed JavaScript exception inputs %j", ({ exceptions, message }) => {
    expect(() => reconcileArtifactLedgers(snapshots, exceptions as unknown as ArtifactLedgerException[])).toThrow(new TypeError(message));
  });

  it("refuses duplicate exception identities and does not mutate caller data", () => {
    expect(() => reconcileArtifactLedgers(snapshots, [exception, exception])).toThrow(TypeError);
    const before = JSON.stringify({ snapshots, exception });
    reconcileArtifactLedgers(snapshots, [exception]);
    expect(JSON.stringify({ snapshots, exception })).toBe(before);
  });
});
