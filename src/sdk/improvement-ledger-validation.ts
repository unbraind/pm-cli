/**
 * @module sdk/improvement-ledger-validation
 *
 * Validates the persisted improvement-ledger envelope and observations at the
 * storage boundary so malformed workspace state never reaches analytics.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import type {
  ImprovementLedgerDocument,
  ImprovementObservation,
} from "./improvement-ledger.js";

const IMPROVEMENT_LEDGER_FORMAT_VERSION = 1;

function isValidLedgerObservation(observation: unknown): boolean {
  if (typeof observation !== "object" || observation === null) return false;
  const candidate = observation as Partial<ImprovementObservation>;
  const hasRequiredFields =
    typeof candidate.id === "string" &&
    typeof candidate.metric === "string" &&
    typeof candidate.value === "number" &&
    Number.isFinite(candidate.value) &&
    ["higher", "lower", "target"].includes(String(candidate.direction)) &&
    typeof candidate.observed_at === "string" &&
    typeof candidate.revision === "string" &&
    ["caller", "git", "unversioned"].includes(
      String(candidate.revision_source),
    ) &&
    typeof candidate.author === "string";
  if (!hasRequiredFields) return false;
  return (
    candidate.direction !== "target" ||
    (typeof candidate.threshold === "number" &&
      Number.isFinite(candidate.threshold))
  );
}

/** Parse and validate a serialized improvement-ledger singleton. */
export function parseImprovementLedgerDocument(
  raw: string | null,
): ImprovementLedgerDocument {
  if (raw === null) {
    return {
      format_version: IMPROVEMENT_LEDGER_FORMAT_VERSION,
      observations: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new PmCliError(
      "Improvement ledger contains invalid JSON.",
      EXIT_CODE.GENERIC_FAILURE,
      { code: "invalid_improvement_ledger" },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { format_version?: unknown }).format_version !==
      IMPROVEMENT_LEDGER_FORMAT_VERSION ||
    !Array.isArray((parsed as { observations?: unknown }).observations)
  ) {
    throw new PmCliError(
      "Improvement ledger has an unsupported shape or format version.",
      EXIT_CODE.GENERIC_FAILURE,
      { code: "invalid_improvement_ledger" },
    );
  }
  const observations = (parsed as { observations: unknown[] }).observations;
  for (const observation of observations) {
    if (!isValidLedgerObservation(observation)) {
      throw new PmCliError(
        "Improvement ledger contains an invalid observation.",
        EXIT_CODE.GENERIC_FAILURE,
        { code: "invalid_improvement_ledger" },
      );
    }
  }
  return parsed as ImprovementLedgerDocument;
}
