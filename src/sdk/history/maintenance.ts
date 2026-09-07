/**
 * @module sdk/history/maintenance
 *
 * Runs history transforms through one snapshot, verification, ownership, lock,
 * persistence and reporting pipeline. Operation-specific transforms retain
 * their replay, reconciliation, privacy and checkpoint policies.
 */
import { runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { readHistorySnapshot } from "../../core/history/read.js";
import {
  executeHistoryRewrite,
  writeHistoryRawWithRollback,
  type VerifiedHistoryRewriteState,
} from "../../core/history/history-rewrite.js";
import {
  historyEntriesToRaw,
  verifyHistoryChain,
} from "../../core/history/replay.js";
import type { ItemTypeRegistry } from "../../core/item/type-registry.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { readLocatedItem } from "../../core/store/item-store.js";
import type { HistoryEntry, PmSettings } from "../../types/index.js";
import type { HistorySubject } from "./subject.js";

/** Built-in maintenance policies; each keeps its established diagnostics and hook names. */
export type HistoryMaintenanceOperation =
  | "history-redact"
  | "history-repair"
  | "history-compact";

/** Shared execution controls for a preview or audited stream rewrite. */
export interface HistoryMaintenanceOptions {
  /** Compute and verify the plan without acquiring a write lock or persisting it. */
  dryRun?: boolean;
  /** Explicit principal override; otherwise use the workspace identity policy. */
  author?: string;
  /** Explicit ownership or stale-lock override passed through the existing governance checks. */
  force?: boolean;
}

/** Inputs captured before a transform, bound to the later under-lock drift checks. */
export interface HistoryMaintenanceSnapshot {
  /** Original bytes used to decode `entries`, never a second independent read. */
  raw: string;
  /** Original stream, including historical anchors and immutable record evidence. */
  entries: HistoryEntry[];
  /** Chain verdict for the original entries; repair may deliberately accept drift. */
  verification: ReturnType<typeof verifyHistoryChain>;
  /** Current item bytes and document, or null for a deleted item's retained history. */
  loadedItem: Awaited<ReturnType<typeof readLocatedItem>> | null;
  /** Resolved identity shared by audit entry construction and lock ownership. */
  author: string;
}

/** Verified outcome supplied to the operation's existing public result renderer. */
export interface HistoryMaintenanceOutcome {
  /** Verification of the exact planned entries before persistence. */
  verification: ReturnType<typeof verifyHistoryChain>;
  /** Governance and write-hook warnings, empty for a preview or unchanged plan. */
  warnings: string[];
}

/** Operation-owned transform with optional transactional item changes and receipt checks. */
export interface HistoryMaintenancePlan<Result> {
  /** Whether the transformation warrants persistence when not previewing. */
  changed: boolean;
  /** Final stream including any operation-specific baseline or audit marker. */
  rewrittenEntries: HistoryEntry[];
  /** Additional evidence check executed under the lock before any write. */
  beforeWrite?: () => Promise<void>;
  /** Override only when history and item bytes must share a rollback transaction. */
  applyRewrite?: (verified: VerifiedHistoryRewriteState) => Promise<void>;
  /** Override when the operation must also dispatch item hooks or derived-index warnings. */
  afterWrite?: () => Promise<string[]>;
  /** Preserve the operation's public report shape after preview or application completes. */
  report: (outcome: HistoryMaintenanceOutcome) => Result;
}

/** Resolved workspace and transform supplied by built-ins or SDK integrations. */
export interface HistoryMaintenanceParams<Result> {
  /** Initialized tracker root whose settings and subject were resolved by the caller. */
  pmRoot: string;
  /** Live item or retained deleted-item history selected for maintenance. */
  subject: HistorySubject;
  /** Workspace policy used consistently for the snapshot and locked write. */
  settings: PmSettings;
  /** Active item-folder mapping, including package-provided types. */
  typeRegistry: ItemTypeRegistry;
  /** Maintenance policy whose diagnostic and hook compatibility must be preserved. */
  operation: HistoryMaintenanceOperation;
  /** Preview and ownership controls. */
  options: HistoryMaintenanceOptions;
  /** Pure planning or evidence reads; persistence belongs in the returned transaction callbacks. */
  transform: (
    snapshot: HistoryMaintenanceSnapshot,
  ) =>
    | HistoryMaintenancePlan<Result>
    | Promise<HistoryMaintenancePlan<Result>>;
}

/** Verify every transform before writing and reject concurrent item or stream changes under the lock. */
export async function runHistoryMaintenance<Result>(
  params: HistoryMaintenanceParams<Result>,
): Promise<Result> {
  const { subject, settings, operation, options } = params;
  const snapshot = await readHistorySnapshot(
    subject.historyPath,
    subject.id,
  );
  if (snapshot.raw === null) {
    throw new PmCliError(
      `No history stream exists for ${subject.id}.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  if (snapshot.entries.length === 0) {
    throw new PmCliError(
      `No history entries exist for ${subject.id}; nothing to ${operation.slice("history-".length)}.`,
      EXIT_CODE.USAGE,
    );
  }
  const loadedItem = subject.located
    ? await readLocatedItem(subject.located, { schema: settings.schema })
    : null;
  const author = resolveAuthor(options.author, settings.author_default);
  const plan = await params.transform({
    raw: snapshot.raw,
    entries: snapshot.entries,
    verification: verifyHistoryChain(snapshot.entries),
    loadedItem,
    author,
  });
  const verification = verifyHistoryChain(plan.rewrittenEntries);
  if (!verification.ok) {
    throw new PmCliError(
      `${operation} produced an invalid rewritten chain (${verification.errors.join(", ")}).`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const warnings =
    plan.changed && !options.dryRun
      ? await executeHistoryRewrite({
          pmRoot: params.pmRoot,
          subject,
          settings,
          typeRegistry: params.typeRegistry,
          historyRawBeforeLock: snapshot.raw,
          currentItemRawBeforeLock: loadedItem?.raw ?? null,
          operation,
          author,
          force: options.force,
          itemDocument: loadedItem?.document ?? null,
          applyRewrite: async (verified) => {
            await plan.beforeWrite?.();
            if (plan.applyRewrite) {
              await plan.applyRewrite(verified);
            } else {
              await writeHistoryRawWithRollback({
                historyPath: subject.historyPath,
                nextHistoryRaw: historyEntriesToRaw(plan.rewrittenEntries),
                historyRawUnderLock: verified.historyRawUnderLock,
              });
            }
          },
          applyPostRewrite:
            plan.afterWrite ??
            (async () =>
              runActiveOnWriteHooks({
                path: subject.historyPath,
                scope: "project",
                op: `${operation.replace("-", "_")}:history`,
              })),
        })
      : [];
  return plan.report({ verification, warnings });
}
