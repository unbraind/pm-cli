/** @module sdk/governance/artifact-ledgers
 * Reconciles complete artifact identity inventories without concealing historical discrepancies.
 */

/** One authoritative inventory; callers must establish completeness before evaluation. */
export interface ArtifactLedgerSnapshot {
  /** Unique ledger name, such as declared, tagged or delivered. */
  name: string;
  /** Exact artifact identities; duplicates indicate an invalid inventory. */
  identities: readonly string[];
  /** Explicit completeness acknowledgement; partial evidence is refused. */
  complete: boolean;
}

/** A reviewed historical exception scoped to one exact missing-ledger signature. */
export interface ArtifactLedgerException {
  /** Exact artifact identity whose discrepancy is retained. */
  identity: string;
  /** Exact ledgers lacking this identity; a new omission invalidates settlement. */
  missing_from: readonly string[];
  /** Recorded rationale for retaining this historical discrepancy. */
  reason: string;
  /** Caller-owned decision, item or immutable evidence reference. */
  evidence: string;
}

/** One discrepancy, including its observed membership and explicit disposition. */
export interface ArtifactLedgerFinding {
  /** Artifact identity missing from at least one complete ledger. */
  identity: string;
  /** Sorted ledgers containing the artifact. */
  present_in: string[];
  /** Sorted ledgers missing the artifact. */
  missing_from: string[];
  /** Exact historical disposition; null denotes unsettled drift. */
  disposition: { reason: string; evidence: string } | null;
}

/** Deterministic full-history result suitable for any project's artifact governance. */
export interface ArtifactLedgerReport {
  /** Versioned receipt schema. */
  schema: "pm-artifact-ledgers/1";
  /** True only when every finding is settled and no exception has become stale. */
  ok: boolean;
  /** Complete per-ledger population counts, including empty individual ledgers. */
  counts: Record<string, number>;
  /** Every discrepancy remains visible, including accepted historical exceptions. */
  findings: ArtifactLedgerFinding[];
  /** Exceptions whose artifact or exact missing signature no longer matches. */
  stale_exceptions: string[];
}

/** Require nonempty exact identities without silently trimming caller data. */
function validIdentity(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/** Admit complete, unambiguous inventories before computing any reconciliation verdict. */
function inventory(snapshots: readonly ArtifactLedgerSnapshot[]): Map<string, Set<string>> {
  if (!Array.isArray(snapshots as unknown) || snapshots.length < 2) throw new TypeError("Expected at least two artifact ledgers.");
  const ledgers = new Map<string, Set<string>>();
  for (const snapshot of snapshots) {
    if (snapshot === null || typeof snapshot !== "object" || !validIdentity(snapshot.name) || ledgers.has(snapshot.name) || snapshot.complete !== true) throw new TypeError("Expected unique complete artifact ledgers.");
    if (!Array.isArray(snapshot.identities as unknown)) throw new TypeError("Invalid or duplicate artifact identity.");
    const identities = new Set(snapshot.identities);
    if (identities.size !== snapshot.identities.length || snapshot.identities.some((id) => !validIdentity(id))) throw new TypeError("Invalid or duplicate artifact identity.");
    ledgers.set(snapshot.name, identities);
  }
  if ([...ledgers.values()].every((identities) => identities.size === 0)) throw new TypeError("Empty inventories cannot establish artifact reconciliation.");
  return ledgers;
}

/** Reject blanket, duplicate or evidence-free exceptions; retain exact signatures for comparison. */
function settlements(exceptions: readonly ArtifactLedgerException[], names: readonly string[]): Map<string, ArtifactLedgerException> {
  if (!Array.isArray(exceptions as unknown)) throw new TypeError("Expected unique evidence-backed artifact exceptions.");
  const accepted = new Map<string, ArtifactLedgerException>();
  for (const exception of exceptions) {
    if (exception === null || typeof exception !== "object" || !validIdentity(exception.identity) || accepted.has(exception.identity) || !validIdentity(exception.reason) || !validIdentity(exception.evidence)) throw new TypeError("Expected unique evidence-backed artifact exceptions.");
    const missing = exception.missing_from;
    if (!Array.isArray(missing as unknown) || missing.length === 0 || missing.length >= names.length || new Set(missing).size !== missing.length || missing.some((name) => !names.includes(name))) throw new TypeError("Invalid artifact exception ledger signature.");
    accepted.set(exception.identity, exception);
  }
  return accepted;
}

/**
 * Compare caller-defined complete inventories by exact artifact identity.
 * Preserve all discrepancies and apply a historical exception only when its
 * missing-ledger signature still matches. Reject incomplete/vacuous populations;
 * input order, a recovery or a stale exception cannot hide newly introduced drift.
 * Validate JavaScript collection and record shapes before property access, so
 * malformed inventories and exceptions retain field-specific TypeError diagnostics.
 */
export function reconcileArtifactLedgers(snapshots: readonly ArtifactLedgerSnapshot[], exceptions: readonly ArtifactLedgerException[] = []): ArtifactLedgerReport {
  const ledgers = inventory(snapshots);
  const names = [...ledgers.keys()].sort();
  const accepted = settlements(exceptions, names);
  const identities = [...new Set([...ledgers.values()].flatMap((set) => [...set]))].sort();
  const findings: ArtifactLedgerFinding[] = [];
  const matched = new Set<string>();
  for (const identity of identities) {
    const missing = names.filter((name) => !ledgers.get(name)!.has(identity));
    if (missing.length === 0) continue;
    const exception = accepted.get(identity);
    const settled = exception !== undefined && JSON.stringify([...exception.missing_from].sort()) === JSON.stringify(missing);
    if (settled) matched.add(identity);
    findings.push({ identity, present_in: names.filter((name) => ledgers.get(name)!.has(identity)), missing_from: missing, disposition: settled ? { reason: exception.reason, evidence: exception.evidence } : null });
  }
  const stale = [...accepted.keys()].filter((identity) => !matched.has(identity)).sort();
  return { schema: "pm-artifact-ledgers/1", ok: findings.every((finding) => finding.disposition !== null) && stale.length === 0, counts: Object.fromEntries(names.map((name) => [name, ledgers.get(name)!.size])), findings, stale_exceptions: stale };
}
