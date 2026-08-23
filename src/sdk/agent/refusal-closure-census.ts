/**
 * @module sdk/agent/refusal-closure-census
 *
 * Joins the complete emitted error vocabulary to every executable refusal
 * corpus. Missing proof remains an explicit row; no catalog code disappears
 * merely because it has not yet received a probe.
 */
import type { PmErrorCodeContract } from "../error-code-catalog.js";
import type { PmClosedDomainContract } from "./closed-domain-contracts.js";
import type { PmGrammarRefusalContract } from "./refusal-corpus-contracts.js";

/** Evidence family that makes an error code executable. */
export type PmRefusalEvidenceKind = "owned_state" | "closed_domain" | "grammar";

/** One complete-catalog closure row. */
export interface PmRefusalClosureCensusRow {
  /** Declared machine-readable error code. */
  code: string;
  /** Canonical compatibility-group code. */
  canonical_code: string;
  /** Whether at least one executable probe reaches the compatibility group. */
  disposition: "executable" | "uncovered";
  /** Evidence families contributing executable probes. */
  evidence_kinds: PmRefusalEvidenceKind[];
  /** Stable executable probe identities. */
  probe_ids: string[];
}

/** Full emitted-vocabulary refusal closure receipt. */
export interface PmRefusalClosureCensusReport {
  /** True only when every catalog code belongs to a probed compatibility group. */
  ok: boolean;
  /** Number of emitted codes in the catalog. */
  catalog_error_code_count: number;
  /** Number of codes backed by executable evidence. */
  executable_error_code_count: number;
  /** Number of codes still lacking executable evidence. */
  uncovered_error_code_count: number;
  /** Executable codes divided by all catalog codes. */
  coverage_fraction: number;
  /** Number of closed-domain probes joined into the census. */
  closed_domain_probe_count: number;
  /** Number of grammar-derived probes joined into the census. */
  grammar_probe_count: number;
  /** Stable complete list of codes without executable evidence. */
  uncovered_error_codes: string[];
  /** Exactly one row for every catalog code. */
  rows: PmRefusalClosureCensusRow[];
}

/** Reviewed floor of 16 catalog rows; includes one alias across 15 canonical groups. */
export const PM_REFUSAL_CLOSURE_EXECUTABLE_CODE_BASELINE = 16;

/** Fifteen canonical compatibility groups that must retain executable evidence. */
export const PM_REFUSAL_CLOSURE_EXECUTABLE_CANONICAL_CODE_BASELINE =
  Object.freeze([
    "bulk_ids_input_empty",
    "bulk_ids_input_missing_path",
    "bulk_ids_input_unreadable",
    "invalid_argument_value",
    "missing_lifecycle_target",
    "missing_required_argument",
    "projection_options_mutually_exclusive",
    "tracker_not_initialized",
    "tracker_root_missing",
    "tracker_root_not_directory",
    "tracker_root_unreadable",
    "unknown_context_intent",
    "unknown_field_projection",
    "unknown_option",
    "unknown_subcommand",
  ] as const);

/** Ratchet receipt that prevents catalog growth from erasing proven closure. */
export function verifyPmRefusalClosureRatchet(
  report: PmRefusalClosureCensusReport,
  baseline = PM_REFUSAL_CLOSURE_EXECUTABLE_CODE_BASELINE,
): { ok: boolean; baseline: number; actual: number } {
  return {
    ok: report.executable_error_code_count >= baseline,
    baseline,
    actual: report.executable_error_code_count,
  };
}

/** Ratchet canonical compatibility-group identities independently from counts. */
export function verifyPmRefusalClosureIdentityRatchet(
  report: PmRefusalClosureCensusReport,
  requiredCanonicalCodes: readonly string[] = PM_REFUSAL_CLOSURE_EXECUTABLE_CANONICAL_CODE_BASELINE,
): {
  ok: boolean;
  required_canonical_codes: string[];
  missing_required_canonical_codes: string[];
} {
  const executableCanonicalCodes = new Set(
    report.rows
      .filter(({ disposition }) => disposition === "executable")
      .map(({ canonical_code: canonicalCode }) => canonicalCode),
  );
  const missingRequiredCanonicalCodes = requiredCanonicalCodes.filter(
    (code) => !executableCanonicalCodes.has(code),
  );
  return {
    ok: missingRequiredCanonicalCodes.length === 0,
    required_canonical_codes: [...requiredCanonicalCodes],
    missing_required_canonical_codes: missingRequiredCanonicalCodes,
  };
}

interface MutableEvidence {
  kinds: Set<PmRefusalEvidenceKind>;
  probeIds: Set<string>;
}

function evidenceFor(
  evidence: Map<string, MutableEvidence>,
  canonicalCode: string,
): MutableEvidence {
  const existing = evidence.get(canonicalCode);
  if (existing) return existing;
  const created = {
    kinds: new Set<PmRefusalEvidenceKind>(),
    probeIds: new Set<string>(),
  };
  evidence.set(canonicalCode, created);
  return created;
}

/** Build the complete closure join without silently omitting uncovered codes. */
export function buildPmRefusalClosureCensus(
  catalog: readonly PmErrorCodeContract[],
  closedDomains: readonly PmClosedDomainContract[],
  grammar: readonly PmGrammarRefusalContract[],
): PmRefusalClosureCensusReport {
  const canonicalByCode = new Map(
    catalog.map((contract) => [
      contract.code,
      contract.canonical_code ?? contract.code,
    ]),
  );
  const evidence = new Map<string, MutableEvidence>();
  let closedDomainProbeCount = 0;
  let grammarProbeCount = 0;
  for (const contract of catalog) {
    const target = evidenceFor(
      evidence,
      contract.canonical_code ?? contract.code,
    );
    for (const state of contract.owned_states ?? []) {
      target.kinds.add("owned_state");
      target.probeIds.add(state.probe_id);
    }
  }
  for (const contract of closedDomains) {
    const canonical = canonicalByCode.get(contract.error_code);
    if (canonical === undefined) continue;
    closedDomainProbeCount += 1;
    const target = evidenceFor(evidence, canonical);
    target.kinds.add("closed_domain");
    target.probeIds.add(contract.probe_id);
  }
  for (const contract of grammar) {
    const canonical = canonicalByCode.get(contract.error_code);
    if (canonical === undefined) continue;
    grammarProbeCount += 1;
    const target = evidenceFor(evidence, canonical);
    target.kinds.add("grammar");
    target.probeIds.add(contract.probe_id);
  }

  const rows = catalog
    .map((contract): PmRefusalClosureCensusRow => {
      const canonicalCode = contract.canonical_code ?? contract.code;
      const joined = evidence.get(canonicalCode)!;
      const probeIds = [...joined.probeIds].sort();
      return {
        code: contract.code,
        canonical_code: canonicalCode,
        disposition: probeIds.length > 0 ? "executable" : "uncovered",
        evidence_kinds: [...joined.kinds].sort(),
        probe_ids: probeIds,
      };
    })
    .sort((left, right) => (left.code < right.code ? -1 : 1));
  const uncoveredErrorCodes = rows
    .filter(({ disposition }) => disposition === "uncovered")
    .map(({ code }) => code);
  const executableCount = rows.length - uncoveredErrorCodes.length;
  return {
    ok: uncoveredErrorCodes.length === 0,
    catalog_error_code_count: rows.length,
    executable_error_code_count: executableCount,
    uncovered_error_code_count: uncoveredErrorCodes.length,
    coverage_fraction: rows.length === 0 ? 1 : executableCount / rows.length,
    closed_domain_probe_count: closedDomainProbeCount,
    grammar_probe_count: grammarProbeCount,
    uncovered_error_codes: uncoveredErrorCodes,
    rows,
  };
}

/** Render the complete census for generated documentation and review evidence. */
export function renderPmRefusalClosureCensusMarkdown(
  report: PmRefusalClosureCensusReport,
): string {
  const rows = report.rows.map(
    (row) =>
      `| \`${row.code}\` | \`${row.canonical_code}\` | ${row.disposition} | ${row.evidence_kinds.join(", ") || "none"} | ${row.probe_ids.length} |`,
  );
  return [
    "# Generated refusal closure census",
    "",
    "Tracker: `pm-f05lsg`.",
    "",
    "Every catalog code is listed. An `uncovered` row is an explicit closure obligation, never an omission or implied approval.",
    "",
    `- Catalog error codes: ${report.catalog_error_code_count}`,
    `- Executable error codes: ${report.executable_error_code_count}`,
    `- Executable-code ratchet floor: ${PM_REFUSAL_CLOSURE_EXECUTABLE_CODE_BASELINE}`,
    `- Required executable canonical codes: ${PM_REFUSAL_CLOSURE_EXECUTABLE_CANONICAL_CODE_BASELINE.map((code) => `\`${code}\``).join(", ")}`,
    `- Uncovered error codes: ${report.uncovered_error_code_count}`,
    `- Coverage fraction: ${report.coverage_fraction.toFixed(6)}`,
    `- Closed-domain probes: ${report.closed_domain_probe_count}`,
    `- Grammar probes: ${report.grammar_probe_count}`,
    "",
    "| Error code | Canonical code | Disposition | Evidence kinds | Probe count |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
