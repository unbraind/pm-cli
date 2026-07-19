/**
 * @module sdk/item-transaction
 *
 * Provides the bulk item-mutation convenience layer over
 * `commitWorkspaceTransaction`: atomic, resumable create/update/close batches
 * with correct-by-construction inspection and compensation wiring.
 */
import path from "node:path";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { readHistoryEntries } from "./history-read.js";
import {
  close,
  create,
  deleteItem,
  get,
  restore,
  update,
  type PmClientFullMutationOptions,
} from "./runtime.js";
import {
  commitWorkspaceTransaction,
  type CommitWorkspaceTransactionOptions,
  type WorkspaceTransactionJsonValue,
  type WorkspaceTransactionStep,
  type WorkspaceTransactionStepInspection,
} from "./workspace-transaction.js";

/**
 * One atomic item creation inside a bulk mutation batch. The explicit `id`
 * doubles as the idempotency key: recovery treats an existing item with this id
 * as the already-applied result, so ids must be stable and transaction-owned.
 */
export interface BulkItemCreateMutation {
  /** Discriminates the creation operation. */
  op: "create";
  /** Explicit stable item id (normalized with the configured id_prefix). */
  id: string;
  /** Creation options forwarded to the public `create` runtime primitive. */
  options: PmClientFullMutationOptions;
}

/** One atomic item update inside a bulk mutation batch. */
export interface BulkItemUpdateMutation {
  /** Discriminates the update operation. */
  op: "update";
  /** Target item id. */
  id: string;
  /** Update options forwarded to the public `update` runtime primitive. */
  options: PmClientFullMutationOptions;
}

/** One atomic item closure inside a bulk mutation batch. */
export interface BulkItemCloseMutation {
  /** Discriminates the close operation. */
  op: "close";
  /** Target item id. */
  id: string;
  /** Close reason recorded on the item. */
  reason: string;
  /** Close options forwarded to the public `close` runtime primitive. */
  options?: PmClientFullMutationOptions;
}

/** Union of the item mutations a bulk transaction batch can carry. */
export type BulkItemMutation =
  | BulkItemCreateMutation
  | BulkItemUpdateMutation
  | BulkItemCloseMutation;

/** Options accepted by the bulk item-mutation transaction helper. */
export interface CommitItemMutationsOptions {
  /** Tracker root that owns the journal and workspace-wide writer lock. */
  pmRoot: string;
  /** Stable idempotency key reused to recover an interrupted batch. */
  transactionId: string;
  /** Attributable actor recorded in the journal and forwarded to mutations. */
  author: string;
  /** Ordered item mutations; compensations run in reverse order. */
  mutations: readonly BulkItemMutation[];
  /**
   * Compensation strategy for created items: `close` (default) preserves the
   * item and its history with an explanatory close reason, `delete` removes
   * the item document (its history stream is retained by `pm delete`).
   */
  createCompensation?: "close" | "delete";
  /** Lock lifetime in seconds; size this above the longest expected attempt. */
  lockTtlSeconds?: number;
  /** Maximum time to wait for the workspace writer lock. */
  lockWaitMs?: number;
  /** Optional transition observer used by telemetry and deterministic crash tests. */
  onTransition?: CommitWorkspaceTransactionOptions["onTransition"];
}

/** Journal-safe outcome recorded for one committed bulk item mutation. */
export interface BulkItemMutationOutcome {
  /** Canonical id of the mutated item. */
  id: string;
  /** Operation the batch applied for this item. */
  op: BulkItemMutation["op"];
}

/** Successful durable result of a bulk item-mutation transaction. */
export interface CommitItemMutationsResult {
  /** Stable transaction identifier. */
  transactionId: string;
  /** Final durable state. */
  status: "committed";
  /** Whether an interrupted journal was resumed. */
  recovered: boolean;
  /** One outcome per mutation, keyed by the derived transaction step id. */
  results: Record<string, BulkItemMutationOutcome>;
}

interface LocatedItemSnapshot {
  id: string;
  closedAt: string | undefined;
  updatedAt: string;
}

/** Read one item's transaction-relevant fields, mapping not-found to undefined. */
async function readItemSnapshot(
  pmRoot: string,
  id: string,
): Promise<LocatedItemSnapshot | undefined> {
  try {
    const located = await get(id, {}, { pmRoot });
    const item = located.item as {
      id: string;
      closed_at?: string;
      updated_at: string;
    };
    return {
      id: item.id,
      closedAt: item.closed_at,
      updatedAt: item.updated_at,
    };
  } catch (error) {
    if (
      error instanceof PmCliError &&
      error.exitCode === EXIT_CODE.NOT_FOUND
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Derive a journal-safe step id from one mutation's position and target. */
function deriveStepId(mutation: BulkItemMutation, index: number): string {
  const sanitizedTarget = mutation.id.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
  return `${index + 1}-${mutation.op}-${sanitizedTarget}`;
}

/** Build the durable history-message marker for one bulk mutation phase. */
function bulkHistoryMarker(
  transactionId: string,
  stepId: string,
  phase: "apply" | "compensate",
): string {
  return `bulk-item-transaction ${transactionId} ${stepId} ${phase}`;
}

/**
 * Report whether an update step's forward mutation is durably applied. Updates
 * cannot be inferred from field values (a moving target), so the applied apply
 * marker in the item's immutable history is the source of truth; a later
 * compensate marker means the mutation was rolled back and must re-apply.
 */
async function isUpdateMarkerApplied(
  pmRoot: string,
  canonicalId: string,
  transactionId: string,
  stepId: string,
): Promise<boolean> {
  const entries = await readHistoryEntries(
    path.join(pmRoot, "history", `${canonicalId}.jsonl`),
    canonicalId,
  );
  const applyMarker = bulkHistoryMarker(transactionId, stepId, "apply");
  const compensateMarker = bulkHistoryMarker(transactionId, stepId, "compensate");
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index].message;
    if (message === applyMarker) {
      return true;
    }
    if (message === compensateMarker) {
      return false;
    }
  }
  return false;
}

/** Capture the restore target used to compensate an update or close mutation. */
async function prepareRestoreCompensation(
  pmRoot: string,
  mutation: BulkItemMutation,
): Promise<WorkspaceTransactionJsonValue> {
  const snapshot = await readItemSnapshot(pmRoot, mutation.id);
  if (snapshot?.updatedAt === undefined) {
    throw new PmCliError(
      `Bulk ${mutation.op} target ${mutation.id} does not exist or has no restorable version`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  return { target_updated_at: snapshot.updatedAt };
}

/** Idempotently restore an item to its captured pre-mutation version. */
async function compensateByRestore(
  config: { pmRoot: string; author: string; transactionId: string },
  itemId: string,
  stepId: string,
  data: WorkspaceTransactionJsonValue | undefined,
): Promise<void> {
  const target =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? data.target_updated_at
      : undefined;
  if (typeof target !== "string") {
    return;
  }
  if ((await readItemSnapshot(config.pmRoot, itemId)) === undefined) {
    return;
  }
  await restore(
    itemId,
    target,
    {
      force: true,
      author: config.author,
      message: bulkHistoryMarker(config.transactionId, stepId, "compensate"),
    },
    { pmRoot: config.pmRoot },
  );
}

/** Build the workspace-transaction step for one item creation. */
function buildCreateStep(
  config: {
    pmRoot: string;
    author: string;
    transactionId: string;
    createCompensation: "close" | "delete";
  },
  mutation: BulkItemCreateMutation,
  stepId: string,
): WorkspaceTransactionStep {
  return {
    id: stepId,
    async inspect(): Promise<WorkspaceTransactionStepInspection> {
      const snapshot = await readItemSnapshot(config.pmRoot, mutation.id);
      if (snapshot === undefined) {
        return { state: "pending" };
      }
      return { state: "applied", result: { id: snapshot.id, op: "create" } };
    },
    async apply(): Promise<WorkspaceTransactionJsonValue> {
      const created = await create(
        { ...mutation.options, author: config.author, id: mutation.id },
        { pmRoot: config.pmRoot },
      );
      const createdItem = created.item as Record<string, unknown>;
      return { id: String(createdItem.id), op: "create" };
    },
    async compensate(): Promise<void> {
      const snapshot = await readItemSnapshot(config.pmRoot, mutation.id);
      if (snapshot === undefined) {
        return;
      }
      if (config.createCompensation === "delete") {
        await deleteItem(
          mutation.id,
          {
            force: true,
            author: config.author,
            message: `Compensate interrupted bulk transaction ${config.transactionId}`,
          },
          { pmRoot: config.pmRoot },
        );
        return;
      }
      if (snapshot.closedAt !== undefined) {
        return;
      }
      await close(
        mutation.id,
        `Compensated: interrupted bulk transaction ${config.transactionId}`,
        { force: true, author: config.author },
        { pmRoot: config.pmRoot },
      );
    },
  };
}

/** Build the workspace-transaction step for one item update. */
function buildUpdateStep(
  config: { pmRoot: string; author: string; transactionId: string },
  mutation: BulkItemUpdateMutation,
  stepId: string,
): WorkspaceTransactionStep {
  return {
    id: stepId,
    async inspect(): Promise<WorkspaceTransactionStepInspection> {
      const snapshot = await readItemSnapshot(config.pmRoot, mutation.id);
      if (snapshot === undefined) {
        return { state: "pending" };
      }
      const applied = await isUpdateMarkerApplied(
        config.pmRoot,
        snapshot.id,
        config.transactionId,
        stepId,
      );
      if (!applied) {
        return { state: "pending" };
      }
      return { state: "applied", result: { id: snapshot.id, op: "update" } };
    },
    async prepareCompensation(): Promise<WorkspaceTransactionJsonValue> {
      return prepareRestoreCompensation(config.pmRoot, mutation);
    },
    async apply(): Promise<WorkspaceTransactionJsonValue> {
      const updated = await update(
        mutation.id,
        {
          ...mutation.options,
          author: config.author,
          message: bulkHistoryMarker(config.transactionId, stepId, "apply"),
        },
        { pmRoot: config.pmRoot },
      );
      const updatedItem = updated.item as Record<string, unknown>;
      return { id: String(updatedItem.id), op: "update" };
    },
    async compensate(
      data?: WorkspaceTransactionJsonValue,
    ): Promise<void> {
      await compensateByRestore(config, mutation.id, stepId, data);
    },
  };
}

/** Build the workspace-transaction step for one item closure. */
function buildCloseStep(
  config: { pmRoot: string; author: string; transactionId: string },
  mutation: BulkItemCloseMutation,
  stepId: string,
): WorkspaceTransactionStep {
  return {
    id: stepId,
    // An already-terminal target counts as applied: closing it again would
    // fight legitimate prior closure, and recovery must adopt completed work.
    async inspect(): Promise<WorkspaceTransactionStepInspection> {
      const snapshot = await readItemSnapshot(config.pmRoot, mutation.id);
      if (snapshot?.closedAt === undefined) {
        return { state: "pending" };
      }
      return { state: "applied", result: { id: snapshot.id, op: "close" } };
    },
    async prepareCompensation(): Promise<WorkspaceTransactionJsonValue> {
      return prepareRestoreCompensation(config.pmRoot, mutation);
    },
    async apply(): Promise<WorkspaceTransactionJsonValue> {
      const closed = await close(
        mutation.id,
        mutation.reason,
        { ...mutation.options, author: config.author },
        { pmRoot: config.pmRoot },
      );
      const closedItem = closed.item as Record<string, unknown>;
      return { id: String(closedItem.id), op: "close" };
    },
    async compensate(
      data?: WorkspaceTransactionJsonValue,
    ): Promise<void> {
      await compensateByRestore(config, mutation.id, stepId, data);
    },
  };
}

/** Convert one validated bulk mutation into its workspace-transaction step. */
function buildStepForMutation(
  config: {
    pmRoot: string;
    author: string;
    transactionId: string;
    createCompensation: "close" | "delete";
  },
  mutation: BulkItemMutation,
  index: number,
): WorkspaceTransactionStep {
  const stepId = deriveStepId(mutation, index);
  if (mutation.op === "create") {
    return buildCreateStep(config, mutation, stepId);
  }
  if (mutation.op === "update") {
    return buildUpdateStep(config, mutation, stepId);
  }
  return buildCloseStep(config, mutation, stepId);
}

/** Reject malformed bulk mutation rows before any journal or lock work. */
function assertValidBulkMutation(
  mutation: BulkItemMutation,
  index: number,
): void {
  if (!["create", "update", "close"].includes(mutation.op)) {
    throw new TypeError(
      `Bulk mutation ${index + 1} op must be create, update, or close`,
    );
  }
  if (typeof mutation.id !== "string" || mutation.id.trim().length === 0) {
    throw new TypeError(`Bulk mutation ${index + 1} requires a non-empty id`);
  }
  if (
    mutation.op === "close" &&
    (typeof mutation.reason !== "string" || mutation.reason.trim().length === 0)
  ) {
    throw new TypeError(
      `Bulk close mutation ${index + 1} requires a non-empty reason`,
    );
  }
}

/**
 * Commit an ordered batch of item create/update/close mutations atomically
 * (all-or-nothing) in one durable workspace transaction. This is the
 * high-level companion to `commitWorkspaceTransaction`: instead of
 * hand-writing `inspect`/`prepareCompensation`/`apply`/`compensate` for the
 * ubiquitous bulk import/sync case, callers describe the mutations and the
 * helper wires the crash-consistency contract — exists-by-id inspection for
 * creates, version-restore compensation for updates and closes, and
 * close-or-delete compensation for creates. A stable `transactionId` makes
 * interrupted batches resumable across processes and agents.
 */
export async function commitItemMutations(
  options: CommitItemMutationsOptions,
): Promise<CommitItemMutationsResult> {
  const mutations = [...options.mutations];
  if (mutations.length === 0) {
    throw new TypeError("Bulk item transaction requires at least one mutation");
  }
  for (const [index, mutation] of mutations.entries()) {
    assertValidBulkMutation(mutation, index);
  }
  const createCompensation = options.createCompensation ?? "close";
  if (!["close", "delete"].includes(createCompensation)) {
    throw new TypeError(
      "Bulk item transaction createCompensation must be close or delete",
    );
  }
  const stepConfig = {
    pmRoot: options.pmRoot,
    author: options.author,
    transactionId: options.transactionId,
    createCompensation,
  };
  const committed = await commitWorkspaceTransaction({
    pmRoot: options.pmRoot,
    transactionId: options.transactionId,
    author: options.author,
    steps: mutations.map((mutation, index) =>
      buildStepForMutation(stepConfig, mutation, index),
    ),
    ...(options.lockTtlSeconds === undefined
      ? {}
      : { lockTtlSeconds: options.lockTtlSeconds }),
    ...(options.lockWaitMs === undefined
      ? {}
      : { lockWaitMs: options.lockWaitMs }),
    ...(options.onTransition === undefined
      ? {}
      : { onTransition: options.onTransition }),
  });
  const results: Record<string, BulkItemMutationOutcome> = {};
  for (const [stepId, value] of Object.entries(committed.results)) {
    // Journal values round-trip this module's own step outputs, which are
    // always {id, op} objects — the cast restores the concrete outcome shape.
    results[stepId] = value as unknown as BulkItemMutationOutcome;
  }
  return {
    transactionId: committed.transactionId,
    status: "committed",
    recovered: committed.recovered,
    results,
  };
}

/** Public contract for test only item transaction internals, shared with white-box specs. */
export const _testOnlyItemTransaction = {
  buildCreateStep,
  bulkHistoryMarker,
  compensateByRestore,
  deriveStepId,
  isUpdateMarkerApplied,
  readItemSnapshot,
};
