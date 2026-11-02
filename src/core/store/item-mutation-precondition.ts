/**
 * @module core/store/item-mutation-precondition
 *
 * Carries transaction preconditions into the item store so checks observe the
 * same locked document that will be mutated.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { hashDocument } from "../history/history.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import type { ItemDocument } from "../../types/index.js";

interface ItemMutationPrecondition {
  pmRoot: string;
  id: string;
  validate: (document: ItemDocument) => void;
  /** Advance the guard only after this operation durably commits under the item lock. */
  committed?: (document: ItemDocument) => void;
  /** Immutable attribution for every internal write to this target. */
  historyContext?: Record<string, unknown>;
}

const preconditions = new AsyncLocalStorage<readonly ItemMutationPrecondition[]>();

/** Scope a target-specific precondition to an awaited mutation without affecting concurrent callers. */
export function runWithItemMutationPrecondition<T>(
  condition: ItemMutationPrecondition,
  operation: () => Promise<T>,
): Promise<T> {
  return preconditions.run(
    [...(preconditions.getStore() ?? []), { ...condition, pmRoot: path.resolve(condition.pmRoot) }],
    operation,
  );
}

/** One caller-declared revision of one item, as returned by `item_hash` reads. */
interface ItemRevisionScopeEntry {
  /** Revision the caller decided on. */
  declared: string;
  /** Revision the next locked write must find; advances past this scope's own commits. */
  expected: string;
  /** Whether any locked write evaluated this expectation. */
  checked: boolean;
}

/**
 * Mutable expected-revision scope for one invocation. Hosts open it before the
 * command runs and bind it once the tracker root and canonical ids are known,
 * so expectations reach every locked item write the invocation makes.
 */
export interface ItemRevisionScope {
  /** Resolved tracker root, unset until the host binds the scope. */
  pmRoot?: string;
  /** Canonical item id to declared revision state. */
  entries: Map<string, ItemRevisionScopeEntry>;
}

const revisionScopes = new AsyncLocalStorage<readonly ItemRevisionScope[]>();

/** Create an empty, unbound expected-revision scope. */
export function createItemRevisionScope(): ItemRevisionScope {
  return { entries: new Map() };
}

/** Run an operation with an expected-revision scope visible to every locked item write it makes. */
export function runWithItemRevisionScope<T>(scope: ItemRevisionScope, operation: () => Promise<T>): Promise<T> {
  return revisionScopes.run([...(revisionScopes.getStore() ?? []), scope], operation);
}

/**
 * Bind canonical expectations to a scope. The same id may repeat only with the
 * same revision, because two different revisions of one item cannot both hold.
 */
export function bindItemRevisionScope(
  scope: ItemRevisionScope,
  pmRoot: string,
  expectations: readonly { id: string; itemHash: string }[],
): void {
  const resolvedRoot = path.resolve(pmRoot);
  if (scope.pmRoot !== undefined && scope.pmRoot !== resolvedRoot) {
    throw new PmCliError("An expected-revision scope is already bound to another tracker.", EXIT_CODE.USAGE, {
      code: "expected_revision_scope_conflict",
      required: "Bind expected item revisions for one tracker per scope.",
    });
  }
  scope.pmRoot = resolvedRoot;
  for (const { id, itemHash } of expectations) {
    const existing = scope.entries.get(id);
    if (existing !== undefined && existing.declared !== itemHash) {
      throw new PmCliError(`Item ${id} has two different expected revisions.`, EXIT_CODE.USAGE, {
        code: "expected_revision_duplicate",
        item_id: id,
        required: "Declare at most one expected revision per item.",
      });
    }
    scope.entries.set(id, existing ?? { declared: itemHash, expected: itemHash, checked: false });
  }
}

/** Report which bound expectations a locked write evaluated, in binding order. */
export function itemRevisionScopeReceipt(scope: ItemRevisionScope): { checked: string[]; unchecked: string[] } {
  const entries = [...scope.entries.entries()];
  return {
    checked: entries.filter(([, entry]) => entry.checked).map(([id]) => id),
    unchecked: entries.filter(([, entry]) => !entry.checked).map(([id]) => id),
  };
}

/**
 * Entries bound to any spelling of the locked item: its locked (filename-probe)
 * id and its embedded metadata id. Bindings store the embedded id, so a write
 * reached through another spelling on a case-insensitive filesystem (`PM-A` for
 * `pm-a`) still meets its expectation, and a file whose embedded id differs from
 * its name still matches by filename.
 */
function matchingRevisionEntries(pmRoot: string, ids: readonly unknown[]): ItemRevisionScopeEntry[] {
  const resolvedRoot = path.resolve(pmRoot);
  const keys = new Set(ids.filter((id): id is string => typeof id === "string"));
  return [...new Set((revisionScopes.getStore() ?? []).flatMap((scope) =>
    scope.pmRoot === resolvedRoot ? [...keys].flatMap((key) => scope.entries.get(key) ?? []) : []))];
}

/**
 * Whether any active scope declared a revision on this tracker, so writers that
 * must read a document to learn its embedded id can skip that read otherwise.
 */
export function hasActiveItemRevisionScope(pmRoot: string): boolean {
  const resolvedRoot = path.resolve(pmRoot);
  return (revisionScopes.getStore() ?? []).some((scope) => scope.pmRoot === resolvedRoot && scope.entries.size > 0);
}

/** Refuse a locked write whose stored revision is not the one its scope declared. */
function assertItemRevisionExpectations(pmRoot: string, document: ItemDocument, targetId: string): void {
  const entries = matchingRevisionEntries(pmRoot, [targetId, document.metadata.id]);
  if (entries.length === 0) return;
  const current = hashDocument(document);
  for (const entry of entries) {
    entry.checked = true;
    if (entry.expected === current) continue;
    const advanced = entry.expected !== entry.declared;
    throw new PmCliError(
      `Item ${targetId} is no longer at the expected revision ${entry.expected.slice(0, 12)}; refusing to write over a revision this decision did not see.${advanced ? " Earlier writes by this same invocation already committed." : " Nothing was written to this item."}`,
      EXIT_CODE.CONFLICT,
      {
        code: "item_revision_conflict",
        item_id: targetId,
        expected_revision: entry.expected,
        current_revision: current,
        required: `Re-read ${targetId} (pm get ${targetId} --json reports item_hash), decide again against the current revision, then retry with --expect-hash <item_hash>.`,
        why: "The caller declared the revision its decision was based on, and another write changed the item before this locked write.",
        examples: [`pm get ${targetId} --fields item_hash --json`, `pm history ${targetId} --limit 5`],
        nextSteps: [`pm get ${targetId} --json`, `pm history ${targetId} --limit 5`],
      },
    );
  }
}

/**
 * Evaluate matching preconditions only after the item lock has been acquired
 * and its document read. `targetId` names the locked item explicitly, so a
 * deleted item's empty tombstone document is still judged against its own
 * expectations instead of matching nothing.
 */
export function assertItemMutationPreconditions(pmRoot: string, document: ItemDocument, targetId: string = document.metadata.id): void {
  assertItemRevisionExpectations(pmRoot, document, targetId);
  for (const condition of preconditions.getStore() ?? []) {
    if (condition.pmRoot === path.resolve(pmRoot) && condition.id === targetId) {
      condition.validate(document);
    }
  }
}

/** Notify matching scoped guards of their own committed document (a tombstone after delete) before releasing the item lock. */
export function advanceItemMutationPreconditions(pmRoot: string, document: ItemDocument, targetId: string = document.metadata.id): void {
  const entries = matchingRevisionEntries(pmRoot, [targetId, document.metadata.id]);
  if (entries.length > 0) {
    const committed = hashDocument(document);
    for (const entry of entries) entry.expected = committed;
  }
  for (const condition of preconditions.getStore() ?? []) {
    if (condition.pmRoot === path.resolve(pmRoot) && condition.id === targetId) {
      condition.committed?.(document);
    }
  }
}

/** Collect target-scoped immutable attribution (keyed by the locked target id) without attributing another caller's writes. */
export function itemMutationPreconditionHistoryContext(pmRoot: string, targetId: string): Record<string, unknown> {
  return Object.assign({}, ...(preconditions.getStore() ?? [])
    .filter((condition) => condition.pmRoot === path.resolve(pmRoot) && condition.id === targetId)
    .map((condition) => condition.historyContext));
}
