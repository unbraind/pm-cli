/**
 * @module sdk/context-usage
 *
 * Privacy-minimal, derived context-usage feedback primitives. The JSONL ledger
 * contains only item ids, timestamps, authors, ranks, profiles, and command
 * intents; it never enters item history and is safe to delete or rebuild.
 */
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { acquireLock } from "../core/lock/lock.js";
import type { ContextRelevanceSurface } from "./context-relevance.js";

/** One propensity row disclosed when context or next serves a candidate. */
export interface ContextUsageServingRow {
  /** Served item identifier. */
  id: string;
  /** One-based scorer rank. */
  rank: number;
  /** Whether the packer included the item. */
  included: boolean;
}

/** Correlation receipt joining a pre-egress serve to its final delivery. */
export interface ContextUsageServingReceipt {
  /** Versioned immutable serve identifier. */
  serve_id: string;
  /** Caller whose feedback model owns the event. */
  author: string;
  /** Read surface that assembled the candidates. */
  surface: ContextRelevanceSurface;
  /** Propensity-complete ranked rows assembled before egress. */
  rows: readonly ContextUsageServingRow[];
}

/** Append-only serving or subsequent-touch event. */
export type ContextUsageEvent =
  | {
      kind: "serve";
      schema_version?: 2;
      serve_id?: string;
      at: string;
      author: string;
      surface: ContextRelevanceSurface;
      profile: string;
      rows: ContextUsageServingRow[];
      result_omitted?: boolean;
      packed_item_ids?: string[];
      /** Legacy pre-egress field ignored by the v2 affinity fold. */
      delivered_item_ids?: string[];
    }
  | {
      kind: "delivery";
      schema_version: 2;
      serve_id: string;
      at: string;
      author: string;
      surface: ContextRelevanceSurface;
      result_omitted: boolean;
      delivered_item_ids: string[];
    }
  | {
      kind: "touch";
      at: string;
      author: string;
      item_id: string;
      intent: string;
    };

/** Runtime controls for the bounded derived ledger. */
export interface ContextUsageLedgerOptions {
  /** Tracker root containing the runtime directory. */
  pmRoot: string;
  /** Disable all reads and writes with zero filesystem work. */
  enabled?: boolean;
  /** Maximum retained event rows. */
  maxEvents?: number;
  /** Retention horizon in days. */
  retentionDays?: number;
  /** Deterministic timestamp override. */
  now?: string;
}

/** Decayed per-item affinity derived for one author. */
export interface ContextUsageAffinity {
  /** Normalized affinity by item id. */
  affinity: Record<string, number>;
  /** Number of eligible served-then-touched judgments. */
  positive_judgments: number;
  /** Number of retained serving events inspected. */
  serving_events: number;
  /** Legacy serving events ignored because their inclusion cannot be trusted. */
  untrusted_serving_events: number;
}

const DEFAULT_MAX_EVENTS = 2_048;
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const DEFAULT_COMPACTION_BYTES = 262_144;
const CONTEXT_USAGE_LOCK_ID = "context-usage-ledger";
const CONTEXT_USAGE_SERVING_RECEIPT = Symbol.for(
  "@unbrained/pm-cli/context-usage-serving-receipt",
);

type ContextUsageReceiptCarrier = {
  [CONTEXT_USAGE_SERVING_RECEIPT]?: ContextUsageServingReceipt;
};

function asObjectRecord(value: unknown): Record<PropertyKey, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<PropertyKey, unknown>)
    : null;
}

/** Attach a JSON-invisible serving receipt to a result for later egress. */
export function attachContextUsageServingReceipt(
  result: unknown,
  receipt: ContextUsageServingReceipt | null,
): void {
  const record = asObjectRecord(result) as ContextUsageReceiptCarrier | null;
  if (record !== null && receipt !== null) {
    record[CONTEXT_USAGE_SERVING_RECEIPT] = receipt;
  }
}

/** Copy an attached serving receipt across a result projection boundary. */
export function propagateContextUsageServingReceipt(
  source: unknown,
  target: unknown,
): void {
  const sourceRecord = asObjectRecord(
    source,
  ) as ContextUsageReceiptCarrier | null;
  const targetRecord = asObjectRecord(
    target,
  ) as ContextUsageReceiptCarrier | null;
  const receipt = sourceRecord?.[CONTEXT_USAGE_SERVING_RECEIPT];
  if (targetRecord !== null && receipt !== undefined) {
    targetRecord[CONTEXT_USAGE_SERVING_RECEIPT] = receipt;
  }
}

function receiptFromResult(result: unknown): ContextUsageServingReceipt | null {
  return (
    (asObjectRecord(result) as ContextUsageReceiptCarrier | null)?.[
      CONTEXT_USAGE_SERVING_RECEIPT
    ] ?? null
  );
}

function resultReceiptSaysOmitted(result: unknown): boolean {
  const record = asObjectRecord(result);
  for (const key of ["read_output", "context_intent"]) {
    const receipt = asObjectRecord(record?.[key]);
    if (receipt?.result_omitted === true) return true;
  }
  return false;
}

function emittedItemIds(
  result: unknown,
  surface: ContextRelevanceSurface,
): string[] {
  const record = asObjectRecord(result);
  if (record === null || resultReceiptSaysOmitted(result)) return [];
  const rows =
    surface === "context"
      ? ["high_level", "low_level", "blocked_fallback"].flatMap((key) =>
          Array.isArray(record[key]) ? record[key] : [],
        )
      : [
          ...(asObjectRecord(record.recommended) === null
            ? []
            : [record.recommended]),
          ...(Array.isArray(record.ready) ? record.ready : []),
          ...(Array.isArray(record.decision_needed)
            ? record.decision_needed
            : []),
          ...(Array.isArray(record.blocked) ? record.blocked : []),
          ...(Array.isArray(record.held_by_others)
            ? record.held_by_others
            : []),
        ];
  return [
    ...new Set(
      rows.flatMap((row) => {
        const id = asObjectRecord(row)?.id;
        return typeof id === "string" && id.trim().length > 0
          ? [id.trim()]
          : [];
      }),
    ),
  ];
}

/** Resolve and append one post-egress decision carried by a context result. */
export async function finalizeContextUsageDelivery(options: {
  /** Tracker root owning the derived ledger. */
  pmRoot: string;
  /** Final projected response returned or rendered to the caller. */
  result: unknown;
}): Promise<boolean> {
  const receipt = receiptFromResult(options.result);
  if (receipt === null) return false;
  const resultOmitted = resultReceiptSaysOmitted(options.result);
  await recordContextUsageDelivery({
    pmRoot: options.pmRoot,
    receipt,
    deliveredItemIds: emittedItemIds(options.result, receipt.surface),
    resultOmitted,
  });
  return true;
}

/** Named validation failure emitted by context-usage SDK inputs. */
export class ContextUsageValidationError extends TypeError {
  /** Stable machine-readable error code for package and CLI hosts. */
  readonly code = "context_usage_validation_failed";

  /** Creates a typed validation error without exposing derived ledger contents. */
  constructor(message: string) {
    super(message);
    this.name = "ContextUsageValidationError";
  }
}

function ledgerPath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", "context-usage.jsonl");
}

function resolveNow(options: ContextUsageLedgerOptions): {
  iso: string;
  ms: number;
} {
  const iso = options.now ?? new Date().toISOString();
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms))
    throw new ContextUsageValidationError(
      "Context usage now must be a valid timestamp",
    );
  return { iso: new Date(ms).toISOString(), ms };
}

async function readEvents(
  options: ContextUsageLedgerOptions,
): Promise<ContextUsageEvent[]> {
  try {
    const text = await readFile(ledgerPath(options.pmRoot), "utf8");
    const events = text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ContextUsageEvent];
        } catch {
          return [];
        }
      });
    const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const cutoff = resolveNow(options).ms - retentionDays * DAY_MS;
    return events
      .filter((entry) => Date.parse(entry.at) >= cutoff)
      .slice(-maxEvents);
  } catch {
    return [];
  }
}

async function appendEvents(
  options: ContextUsageLedgerOptions,
  events: readonly ContextUsageEvent[],
  deliveryServeId?: string,
): Promise<void> {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (
    !Number.isInteger(maxEvents) ||
    maxEvents < 1 ||
    !Number.isFinite(retentionDays) ||
    retentionDays <= 0
  ) {
    throw new ContextUsageValidationError(
      "Context usage retention requires positive maxEvents and retentionDays",
    );
  }
  const target = ledgerPath(options.pmRoot);
  const runtimeDirectory = path.dirname(target);
  const releaseLock = await acquireLock(
    options.pmRoot,
    CONTEXT_USAGE_LOCK_ID,
    30,
    `context-usage:${process.pid}`,
    false,
    false,
    3_000,
  );
  try {
    await mkdir(runtimeDirectory, { recursive: true });
    if (
      deliveryServeId !== undefined &&
      (await readEvents(options)).some(
        (event) =>
          event.kind === "delivery" && event.serve_id === deliveryServeId,
      )
    ) {
      return;
    }
    await appendFile(
      target,
      events.map((event) => `${JSON.stringify(event)}\n`).join(""),
      "utf8",
    );
    const customBounds =
      options.maxEvents !== undefined || options.retentionDays !== undefined;
    if (!customBounds && (await stat(target)).size <= DEFAULT_COMPACTION_BYTES)
      return;
    const retained = await readEvents(options);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    await rename(temporary, target);
  } finally {
    await releaseLock();
  }
}

async function appendEvent(
  options: ContextUsageLedgerOptions,
  event: ContextUsageEvent,
): Promise<void> {
  await appendEvents(options, [event]);
}

/** Records a propensity-complete context/next serving event. */
export async function recordContextUsageServing(
  options: ContextUsageLedgerOptions & {
    author: string;
    surface: ContextRelevanceSurface;
    profile: string;
    rows: ContextUsageServingRow[];
  },
): Promise<ContextUsageServingReceipt | null> {
  if (
    [
      process.env.PM_CONTEXT_USAGE_DISABLED === "1",
      options.enabled === false,
    ].includes(true)
  )
    return null;
  if (
    !options.author.trim() ||
    options.rows.some(
      (row) => !row.id.trim() || !Number.isInteger(row.rank) || row.rank < 1,
    )
  ) {
    throw new ContextUsageValidationError(
      "Context usage serving requires an author and valid ranked rows",
    );
  }
  const normalizedRows = options.rows.map((row) => ({
    ...row,
    id: row.id.trim(),
  }));
  if (
    new Set(normalizedRows.map((row) => row.id)).size !== normalizedRows.length
  ) {
    throw new ContextUsageValidationError(
      "Context usage serving requires unique normalized row ids",
    );
  }
  const receipt: ContextUsageServingReceipt = {
    serve_id: randomUUID(),
    author: options.author.trim(),
    surface: options.surface,
    rows: normalizedRows,
  };
  await appendEvent(options, {
    kind: "serve",
    schema_version: 2,
    serve_id: receipt.serve_id,
    at: resolveNow(options).iso,
    author: options.author.trim(),
    surface: options.surface,
    profile: options.profile.trim() || "balanced",
    rows: receipt.rows.map((row) => ({ ...row })),
    result_omitted: false,
    packed_item_ids: receipt.rows
      .filter((row) => row.included)
      .map((row) => row.id),
  });
  return receipt;
}

/** Append the exact post-egress delivery decision for one serving receipt. */
export async function recordContextUsageDelivery(
  options: ContextUsageLedgerOptions & {
    /** Correlation receipt returned by {@link recordContextUsageServing}. */
    receipt: ContextUsageServingReceipt | null;
    /** Item ids present in the final response payload. */
    deliveredItemIds: readonly string[];
    /** Whether the result was suppressed by the final output budget. */
    resultOmitted: boolean;
  },
): Promise<void> {
  if (
    options.receipt === null ||
    process.env.PM_CONTEXT_USAGE_DISABLED === "1" ||
    options.enabled === false
  ) {
    return;
  }
  const rankedIds = new Set(options.receipt.rows.map((row) => row.id));
  const deliveredItemIds = [
    ...new Set(options.deliveredItemIds.map((id) => id.trim())),
  ];
  if (
    deliveredItemIds.some((id) => id.length === 0 || !rankedIds.has(id)) ||
    (options.resultOmitted && deliveredItemIds.length > 0)
  ) {
    throw new ContextUsageValidationError(
      "Context usage delivery requires emitted ranked ids and zero ids for an omitted result",
    );
  }
  const delivery: ContextUsageEvent = {
    kind: "delivery",
    schema_version: 2,
    serve_id: options.receipt.serve_id,
    at: resolveNow(options).iso,
    author: options.receipt.author,
    surface: options.receipt.surface,
    result_omitted: options.resultOmitted,
    delivered_item_ids: deliveredItemIds,
  };
  await appendEvents(options, [delivery], delivery.serve_id);
}

/** Records one subsequent item read or mutation outcome. */
export async function recordContextUsageTouch(
  options: ContextUsageLedgerOptions & {
    author: string;
    itemId: string;
    intent: string;
  },
): Promise<void> {
  if (
    process.env.PM_CONTEXT_USAGE_DISABLED === "1" ||
    options.enabled === false
  )
    return;
  if (
    !options.author.trim() ||
    !options.itemId.trim() ||
    !options.intent.trim()
  ) {
    throw new ContextUsageValidationError(
      "Context usage touch requires author, itemId, and intent",
    );
  }
  await appendEvent(options, {
    kind: "touch",
    at: resolveNow(options).iso,
    author: options.author.trim(),
    item_id: options.itemId.trim(),
    intent: options.intent.trim(),
  });
}

/**
 * Records mutation outcomes as one append and one optional compaction pass.
 */
export async function recordContextUsageTouches(
  options: ContextUsageLedgerOptions & {
    /** Stable caller identity used to isolate affinity. */
    author: string;
    /** Item identifiers affected by the completed command. */
    itemIds: readonly string[];
    /** Command or workflow intent associated with the touches. */
    intent: string;
  },
): Promise<void> {
  if (
    process.env.PM_CONTEXT_USAGE_DISABLED === "1" ||
    options.enabled === false ||
    options.itemIds.length === 0
  )
    return;
  const author = options.author.trim();
  const intent = options.intent.trim();
  if (!author || !intent) {
    throw new ContextUsageValidationError(
      "Context usage touch requires author and intent",
    );
  }
  const itemIds = new Set<string>();
  for (const itemId of options.itemIds) {
    if (typeof itemId !== "string") {
      throw new ContextUsageValidationError(
        "Context usage touch requires string itemIds",
      );
    }
    const trimmedId = itemId.trim();
    if (!trimmedId)
      throw new ContextUsageValidationError(
        "Context usage touch requires non-empty itemId",
      );
    itemIds.add(trimmedId);
  }
  const at = resolveNow(options).iso;
  const events = [...itemIds].map(
    (itemId): ContextUsageEvent => ({
      kind: "touch",
      at,
      author,
      item_id: itemId,
      intent,
    }),
  );
  await appendEvents(options, events);
}

function findTouchTimeInHorizon(
  touches: readonly {
    entry: Extract<ContextUsageEvent, { kind: "touch" }>;
    time: number;
  }[],
  itemId: string,
  servedAt: number,
  horizonMs: number,
): number | undefined {
  return touches.find(
    ({ entry, time }) =>
      entry.item_id === itemId &&
      time >= servedAt &&
      time - servedAt <= horizonMs,
  )?.time;
}

function firstDeliveriesByServeId(
  events: readonly ContextUsageEvent[],
  author: string,
): Map<string, Extract<ContextUsageEvent, { kind: "delivery" }>> {
  const deliveries = new Map<
    string,
    Extract<ContextUsageEvent, { kind: "delivery" }>
  >();
  for (const event of events) {
    if (
      event.kind === "delivery" &&
      event.schema_version === 2 &&
      event.author === author &&
      !deliveries.has(event.serve_id)
    ) {
      deliveries.set(event.serve_id, event);
    }
  }
  return deliveries;
}

/**
 * Derives decayed served-then-touched affinity. A small exploration floor keeps
 * ignored and unseen items eligible, preventing a popularity feedback lock-in.
 */
export async function readContextUsageAffinity(
  options: ContextUsageLedgerOptions & {
    author: string;
    horizonHours?: number;
  },
): Promise<ContextUsageAffinity> {
  if (
    process.env.PM_CONTEXT_USAGE_DISABLED === "1" ||
    options.enabled === false
  )
    return {
      affinity: {},
      positive_judgments: 0,
      serving_events: 0,
      untrusted_serving_events: 0,
    };
  const events = await readEvents(options);
  const now = resolveNow(options).ms;
  const horizonMs = (options.horizonHours ?? 24) * 3_600_000;
  if (![Number.isFinite(horizonMs), horizonMs > 0].every(Boolean))
    throw new ContextUsageValidationError(
      "Context usage horizonHours must be positive",
    );
  const author = options.author.trim();
  const touches = events
    .filter(
      (event): event is Extract<ContextUsageEvent, { kind: "touch" }> =>
        event.kind === "touch",
    )
    .filter((event) => event.author === author)
    .map((entry) => ({ entry, time: Date.parse(entry.at) }));
  const scores = new Map<string, number>();
  let servingEvents = 0;
  let untrustedServingEvents = 0;
  let positiveJudgments = 0;
  const deliveries = firstDeliveriesByServeId(events, author);
  events
    .filter(
      (event): event is Extract<ContextUsageEvent, { kind: "serve" }> =>
        event.kind === "serve",
    )
    .filter((event) => event.author === author)
    .forEach((event) => {
      if (
        ![event.schema_version === 2, Boolean(event.serve_id)].every(Boolean)
      ) {
        untrustedServingEvents += 1;
        return;
      }
      servingEvents += 1;
      const servedAt = Date.parse(event.at);
      const delivery = deliveries.get(event.serve_id as string);
      const deliveredIds = new Set(delivery?.delivered_item_ids ?? []);
      for (const row of event.rows) {
        if (!deliveredIds.has(row.id)) continue;
        const touchTime = findTouchTimeInHorizon(
          touches,
          row.id,
          servedAt,
          horizonMs,
        );
        if (touchTime === undefined) continue;
        positiveJudgments += 1;
        const ageDays = Math.max(0, (now - touchTime) / DAY_MS);
        scores.set(row.id, (scores.get(row.id) ?? 0) + Math.exp(-ageDays / 14));
      }
    });
  const maximum = Math.max(0, ...scores.values());
  const affinity = Object.fromEntries(
    [...scores.entries()].map(([id, score]) => [
      id,
      maximum === 0 ? 0.05 : 0.05 + (0.95 * score) / maximum,
    ]),
  );
  return {
    affinity,
    positive_judgments: positiveJudgments,
    serving_events: servingEvents,
    untrusted_serving_events: untrustedServingEvents,
  };
}
