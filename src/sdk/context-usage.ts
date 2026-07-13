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

/** Append-only serving or subsequent-touch event. */
export type ContextUsageEvent =
  | {
      kind: "serve";
      at: string;
      author: string;
      surface: ContextRelevanceSurface;
      profile: string;
      rows: ContextUsageServingRow[];
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
}

const DEFAULT_MAX_EVENTS = 2_048;
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const DEFAULT_COMPACTION_BYTES = 262_144;
const CONTEXT_USAGE_LOCK_ID = "context-usage-ledger";

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
    throw new TypeError("Context usage now must be a valid timestamp");
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
): Promise<void> {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (
    !Number.isInteger(maxEvents) ||
    maxEvents < 1 ||
    !Number.isFinite(retentionDays) ||
    retentionDays <= 0
  ) {
    throw new TypeError(
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
    await appendFile(target, events.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
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
): Promise<void> {
  if (process.env.PM_CONTEXT_USAGE_DISABLED === "1" || options.enabled === false) return;
  if (
    !options.author.trim() ||
    options.rows.some(
      (row) => !row.id.trim() || !Number.isInteger(row.rank) || row.rank < 1,
    )
  ) {
    throw new TypeError(
      "Context usage serving requires an author and valid ranked rows",
    );
  }
  await appendEvent(options, {
    kind: "serve",
    at: resolveNow(options).iso,
    author: options.author.trim(),
    surface: options.surface,
    profile: options.profile.trim() || "balanced",
    rows: options.rows,
  });
}

/** Records one subsequent item read or mutation outcome. */
export async function recordContextUsageTouch(
  options: ContextUsageLedgerOptions & {
    author: string;
    itemId: string;
    intent: string;
  },
): Promise<void> {
  if (process.env.PM_CONTEXT_USAGE_DISABLED === "1" || options.enabled === false) return;
  if (
    !options.author.trim() ||
    !options.itemId.trim() ||
    !options.intent.trim()
  ) {
    throw new TypeError(
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
  if (process.env.PM_CONTEXT_USAGE_DISABLED === "1" || options.enabled === false || options.itemIds.length === 0) return;
  const author = options.author.trim();
  const intent = options.intent.trim();
  if (!author || !intent) {
    throw new TypeError("Context usage touch requires author and intent");
  }
  const at = resolveNow(options).iso;
  const events = options.itemIds.map((itemId): ContextUsageEvent => {
    const trimmedId = itemId.trim();
    if (!trimmedId) throw new TypeError("Context usage touch requires non-empty itemId");
    return { kind: "touch", at, author, item_id: trimmedId, intent };
  });
  await appendEvents(options, events);
}

function findTouchTimeInHorizon(
  touches: readonly { entry: Extract<ContextUsageEvent, { kind: "touch" }>; time: number }[],
  itemId: string,
  servedAt: number,
  horizonMs: number,
): number | undefined {
  return touches.find(({ entry, time }) =>
    entry.item_id === itemId && time >= servedAt && time - servedAt <= horizonMs
  )?.time;
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
  if (process.env.PM_CONTEXT_USAGE_DISABLED === "1" || options.enabled === false)
    return { affinity: {}, positive_judgments: 0, serving_events: 0 };
  const events = await readEvents(options);
  const now = resolveNow(options).ms;
  const horizonMs = (options.horizonHours ?? 24) * 3_600_000;
  if (!Number.isFinite(horizonMs) || horizonMs <= 0)
    throw new TypeError("Context usage horizonHours must be positive");
  const author = options.author.trim();
  const touches = events
    .filter(
      (event): event is Extract<ContextUsageEvent, { kind: "touch" }> =>
        event.kind === "touch" && event.author === author,
    )
    .map((entry) => ({ entry, time: Date.parse(entry.at) }));
  const scores = new Map<string, number>();
  let servingEvents = 0;
  let positiveJudgments = 0;
  for (const event of events) {
    if (event.kind !== "serve" || event.author !== author) continue;
    servingEvents += 1;
    const servedAt = Date.parse(event.at);
    for (const row of event.rows) {
      if (!row.included) continue;
      const touchTime = findTouchTimeInHorizon(touches, row.id, servedAt, horizonMs);
      if (touchTime === undefined) continue;
      positiveJudgments += 1;
      const ageDays = Math.max(0, (now - touchTime) / DAY_MS);
      scores.set(row.id, (scores.get(row.id) ?? 0) + Math.exp(-ageDays / 14));
    }
  }
  const maximum = Math.max(0, ...scores.values());
  const affinity = Object.fromEntries(
    [...scores.entries()].map(([id, score]) => [
      id,
      0.05 + 0.95 * (maximum > 0 ? score / maximum : 0),
    ]),
  );
  return {
    affinity,
    positive_judgments: positiveJudgments,
    serving_events: servingEvents,
  };
}
