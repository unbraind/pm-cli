/**
 * @module sdk/governance/health-merge-evidence
 *
 * Reports shared Git attribute and merge receipt evidence for tracker health.
 */
import type { PmSettings } from "../../types/index.js";
import {
  auditMergeAttributeFence,
  resolveProjectMergeTypeFolders,
} from "../merge/install.js";

/** Audit the active tracker's shared attribute fence and report strict merge protection findings. */
export async function resolveMergeFenceHealthEvidence(
  pmRoot: string,
  gitWorkspaceRoot: string | null,
  settings: PmSettings,
  required: boolean,
): Promise<{
  audit: Awaited<ReturnType<typeof auditMergeAttributeFence>> | null;
  count: number;
  warnings: string[];
}> {
  if (gitWorkspaceRoot === null) {
    return { audit: null, count: 0, warnings: [] };
  }
  const audit = await auditMergeAttributeFence(
    pmRoot,
    resolveProjectMergeTypeFolders(settings),
  );
  if (audit.status === "ok") {
    return { audit, count: 0, warnings: [] };
  }
  const count = Math.max(
    1,
    audit.missing_patterns.length + audit.stale_patterns.length,
  );
  return {
    audit,
    count,
    warnings: required
      ? [`merge_fence_${audit.status === "not_installed" ? "missing" : "drift"}:${count}`]
      : [],
  };
}

/** Report unresolved durable merge receipt evidence in compact warning form. */
export function buildMergeReceiptEvidenceWarnings(params: {
  invalidEvidenceCount: number;
  missingHistoryReferenceCount: number;
}): string[] {
  const warnings: string[] = [];
  if (params.invalidEvidenceCount > 0) {
    warnings.push(
      `merge_receipt_evidence_invalid:${params.invalidEvidenceCount}`,
    );
  }
  if (params.missingHistoryReferenceCount > 0) {
    warnings.push(
      `merge_receipt_history_reference_missing:${params.missingHistoryReferenceCount}`,
    );
  }
  return warnings;
}
