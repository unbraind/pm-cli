/**
 * @module sdk/governance/defect-recurrence-coverage
 *
 * Measures policy coverage against all recorded recurrence components and pages
 * the uncovered evidence without allowing pagination to weaken the verdict.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "../../core/shared/serialization.js";
import type { AssuranceItemRecord } from "./assurance.js";
import {
  DEFECT_ESCAPE_CLASSES,
  parseDefectRecurrencePolicy,
  parseDefectChangeRiskRequest,
  type DefectEscapeClass,
  type DefectRecurrencePolicy,
} from "./defect-recurrence.js";
import {
  buildDefectRecurrenceGraph,
  readDefectRecurrenceRecord,
  type DefectRecurrenceRecord,
  type DefectRecurrenceGraph,
} from "./defect-recurrence-graph.js";

/** Bounded recurrence-evidence selection shared by SDK and transport hosts. */
export interface DefectRecurrenceCoverageOptions {
  /** Maximum item rows returned, from 1 through 100; defaults to 25. */
  limit?: number;
  /** Continuation tied to the policy, complete recurrence evidence, and filter. */
  cursor?: string;
  /** Return only unregistered or missing items; totals always describe the full graph. */
  uncoveredOnly?: boolean;
}

/** Serialized request for the shared assurance lineages action. */
export interface DefectRecurrenceCoverageRequest extends DefectRecurrenceCoverageOptions {
  /** Project- or package-owned versioned family policy. */
  policy: DefectRecurrencePolicy;
}

/** Validate lineage-policy and paging input at the untrusted transport boundary. */
export function parseDefectRecurrenceCoverageRequest(
  value: unknown,
): DefectRecurrenceCoverageRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("recurrence coverage request must be an object");
  }
  const input = value as Record<string, unknown>;
  if (
    input.uncoveredOnly !== undefined &&
    typeof input.uncoveredOnly !== "boolean"
  ) {
    throw new TypeError(
      "recurrence coverage request.uncoveredOnly must be a boolean",
    );
  }
  const { policy, cursor, limit } = parseDefectChangeRiskRequest({
    ...input,
    change: {},
  });
  return {
    policy,
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
    ...(input.uncoveredOnly === undefined
      ? {}
      : { uncoveredOnly: input.uncoveredOnly }),
  };
}

/** One registered, unregistered, or missing member of a recorded recurrence lineage. */
export interface DefectRecurrenceCoverageRow {
  /** Recorded item id or missing local reference. */
  item_id: string;
  /** Current component identity, derived from its lexically first item id. */
  lineage_id: string;
  /** Full component size, independent of the returned page. */
  lineage_item_count: number;
  /** Explicitly registered families covering this component. */
  family_ids: string[];
  /** Whether the local item exists in the supplied authoritative corpus. */
  present: boolean;
  /** Stable named finding when registration or the target record is absent. */
  finding?: "unregistered_recurrence_item" | "missing_recurrence_item";
}

/** Complete population counts and bounded recurrence-policy evidence. */
export interface DefectRecurrenceCoverageReport {
  /** False if any recorded recurrence member is unregistered or missing. */
  ok: boolean;
  /** Identity of policy, recurrence evidence, and selected filter. */
  fingerprint: string;
  /** Current page; every row remains connected to its complete lineage. */
  items: DefectRecurrenceCoverageRow[];
  /** Selected row count before pagination. */
  total: number;
  /** Whether another page remains. */
  has_more: boolean;
  /** Cursor for the next page when has_more is true. */
  next_cursor?: string;
  /** Independent denominator including covered, uncovered, and absent local references. */
  population: {
    /** Explicit statement that the denominator is not the family registry. */
    scope: "all_recorded_recurrence_items";
    /** Unique participating local ids, including missing references. */
    item_count: number;
    /** Connected recurrence components. */
    lineage_count: number;
    /** Unique directed local recurrence edges. */
    edge_count: number;
    /** Existing members with an explicitly seeded registered family. */
    covered_item_count: number;
    /** Existing or missing members without a seeded registered family. */
    uncovered_item_count: number;
    /** Referenced ids missing from the authoritative item corpus. */
    missing_item_count: number;
    /** Members with an explicit recognized escape classification. */
    classified_item_count: number;
    /** Members without a recognized classification; never counted as non-escapes. */
    unclassified_item_count: number;
    /** Recorded classification counts over the entire population. */
    class_counts: Record<DefectEscapeClass, number>;
    /** Production-defect fraction only when every participant is classified; null otherwise. */
    escape_rate: number | null;
    /** Known production defects divided by the entire population, explicitly a lower bound. */
    escape_rate_lower_bound: number | null;
  };
  /** Budgets on the policy's families cannot certify uncovered or unclassified members. */
  budget_scope: "registered_families_only";
  /** Declared performance accounting; connectivity never uses a depth cutoff. */
  cost: {
    /** Input item records inspected. */
    items_scanned: number;
    /** Recurrence edges traversed. */
    edges_scanned: number;
    /** Maximum emitted item rows. */
    row_limit: number;
  };
  /** Stable machine selector. */
  row_contract: { row_keys: ["items"]; jq_selector: ".items[]" };
}

/** Decode a cursor only when its evidence identity and safe integer offset match. */
function coverageOffset(
  cursor: string | undefined,
  fingerprint: string,
): number {
  if (cursor === undefined) return 0;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("recurrence coverage cursor is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("recurrence coverage cursor is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.fingerprint !== fingerprint ||
    typeof record.offset !== "number" ||
    !Number.isSafeInteger(record.offset) ||
    record.offset < 0
  ) {
    throw new TypeError(
      "recurrence coverage cursor does not match this evidence and filter",
    );
  }
  return record.offset;
}

/** Count the complete graph and hash its evidence before selecting any page. */
function summarizeCoverage(
  graph: DefectRecurrenceGraph,
  records: ReadonlyMap<string, DefectRecurrenceRecord>,
  knownIds: ReadonlySet<string>,
  ids: string[],
  identity: string,
  uncoveredOnly: boolean,
) {
  const classCounts = Object.fromEntries(
    DEFECT_ESCAPE_CLASSES.map((key) => [key, 0]),
  ) as Record<DefectEscapeClass, number>;
  let coveredCount = 0;
  let uncoveredCount = 0;
  let missingCount = 0;
  let classifiedCount = 0;
  const selected: string[] = [];
  const hash = createHash("sha256").update(identity);
  for (const id of ids) {
    const lineage = graph.membership.get(id)!;
    const present = knownIds.has(id);
    const covered = lineage.family_ids.length > 0;
    if (covered && present) coveredCount += 1;
    if (!covered) uncoveredCount += 1;
    if (!present) missingCount += 1;
    const classification = records.get(id)?.escape_class;
    if (
      classification !== undefined &&
      DEFECT_ESCAPE_CLASSES.includes(classification as DefectEscapeClass)
    ) {
      classCounts[classification as DefectEscapeClass] += 1;
      classifiedCount += 1;
    }
    hash.update(
      stableStringify([
        id,
        present,
        records.get(id) ?? null,
        lineage.id,
        lineage.family_ids,
      ]),
    );
    if (!uncoveredOnly || !covered || !present) selected.push(id);
  }
  return {
    classCounts,
    coveredCount,
    uncoveredCount,
    missingCount,
    classifiedCount,
    selected,
    fingerprint: hash.digest("hex"),
  };
}

/** Evaluate all local recurs_from lineages before applying any result-row limit. */
export function analyzeDefectRecurrenceCoverage(
  policy: DefectRecurrencePolicy,
  items: readonly AssuranceItemRecord[],
  options: DefectRecurrenceCoverageOptions = {},
): DefectRecurrenceCoverageReport {
  parseDefectRecurrencePolicy(policy);
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError(
      "recurrence coverage limit must be an integer from 1 through 100",
    );
  }
  const knownIds = new Set<string>();
  const records = new Map<string, DefectRecurrenceRecord>();
  for (const item of items) {
    if (knownIds.has(item.id))
      throw new TypeError(`Duplicate recurrence item ${item.id}`);
    knownIds.add(item.id);
    const record = readDefectRecurrenceRecord(item);
    if (record !== undefined) records.set(item.id, record);
  }
  const graph = buildDefectRecurrenceGraph(policy.families, records);
  const ids = [...graph.membership.keys()].sort();
  const identity = stableStringify({
    policy,
    uncoveredOnly: options.uncoveredOnly === true,
  });
  const {
    classCounts,
    coveredCount,
    uncoveredCount,
    missingCount,
    classifiedCount,
    selected,
    fingerprint,
  } = summarizeCoverage(
    graph,
    records,
    knownIds,
    ids,
    identity,
    options.uncoveredOnly === true,
  );
  const offset = coverageOffset(options.cursor, fingerprint);
  if (offset > selected.length)
    throw new TypeError(
      "recurrence coverage cursor offset exceeds the selected population",
    );
  const page = selected
    .slice(offset, offset + limit)
    .map((id): DefectRecurrenceCoverageRow => {
      const lineage = graph.membership.get(id)!;
      const present = knownIds.has(id);
      return {
        item_id: id,
        lineage_id: lineage.id,
        lineage_item_count: lineage.item_ids.length,
        family_ids: lineage.family_ids,
        present,
        ...(!present
          ? { finding: "missing_recurrence_item" as const }
          : lineage.family_ids.length === 0
            ? { finding: "unregistered_recurrence_item" as const }
            : {}),
      };
    });
  const nextOffset = offset + page.length;
  const lowerBound =
    ids.length === 0 ? null : classCounts.production_defect / ids.length;
  return {
    ok: uncoveredCount === 0 && missingCount === 0,
    fingerprint,
    items: page,
    total: selected.length,
    has_more: nextOffset < selected.length,
    ...(nextOffset < selected.length
      ? {
          next_cursor: Buffer.from(
            JSON.stringify({ fingerprint, offset: nextOffset }),
          ).toString("base64url"),
        }
      : {}),
    population: {
      scope: "all_recorded_recurrence_items",
      item_count: ids.length,
      lineage_count: graph.lineages.length,
      edge_count: graph.edge_count,
      covered_item_count: coveredCount,
      uncovered_item_count: uncoveredCount,
      missing_item_count: missingCount,
      classified_item_count: classifiedCount,
      unclassified_item_count: ids.length - classifiedCount,
      class_counts: classCounts,
      escape_rate: classifiedCount === ids.length ? lowerBound : null,
      escape_rate_lower_bound: lowerBound,
    },
    budget_scope: "registered_families_only",
    cost: {
      items_scanned: items.length,
      edges_scanned: graph.edge_count,
      row_limit: limit,
    },
    row_contract: { row_keys: ["items"], jq_selector: ".items[]" },
  };
}
