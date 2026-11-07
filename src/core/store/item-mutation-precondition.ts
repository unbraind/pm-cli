/**
 * @module core/store/item-mutation-precondition
 *
 * Carries transaction preconditions into the item store so checks observe the
 * same locked document that will be mutated.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import path from "node:path";
import { hashDocument } from "../history/history.js";
import { sha256Hex } from "../shared/serialization.js";
import { renderPmCommand } from "../shared/command-line.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError, type PmCliErrorContext } from "../shared/errors.js";
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
  /**
   * Whether this scope durably committed a write to the item. Tracked apart from
   * `expected`, which can return to `declared` (a restore then delete reproduces
   * the declared tombstone).
   */
  committed: boolean;
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

/**
 * One revision-scope store per process, shared through a registered symbol: the
 * published SDK entrypoints (`/sdk`, `/sdk/core`, ...) are separate bundle graphs,
 * and a guard opened through one must constrain writes made through another.
 */
const REVISION_SCOPES_KEY = Symbol.for("@unbrained/pm-cli/item-revision-scopes");
const revisionScopeRegistry = globalThis as typeof globalThis & { [REVISION_SCOPES_KEY]?: AsyncLocalStorage<readonly ItemRevisionScope[]> };
const revisionScopes = (revisionScopeRegistry[REVISION_SCOPES_KEY] ??= new AsyncLocalStorage<readonly ItemRevisionScope[]>());

/**
 * Physical tracker identity for revision scopes: a symlinked or relative spelling
 * of the same tracker must meet the same expectations. A path that does not exist
 * keeps its resolved spelling.
 */
function canonicalTrackerRoot(pmRoot: string): string {
  const resolved = path.resolve(pmRoot);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

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
  const resolvedRoot = canonicalTrackerRoot(pmRoot);
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
    scope.entries.set(id, existing ?? { declared: itemHash, expected: itemHash, checked: false, committed: false });
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
  const scopes = revisionScopes.getStore() ?? [];
  // Canonicalize only when a scope is active, so ordinary writes pay nothing.
  if (scopes.length === 0) return [];
  const resolvedRoot = canonicalTrackerRoot(pmRoot);
  const keys = new Set(ids.filter((id): id is string => typeof id === "string"));
  return [...new Set(scopes.flatMap((scope) =>
    scope.pmRoot === resolvedRoot ? [...keys].flatMap((key) => scope.entries.get(key) ?? []) : []))];
}

/**
 * Every revision the active scopes currently expect on this tracker, as
 * `<id>=<hash>` guard values, so a refusal that prescribes a retry carries the
 * same guards (`--expect-hash <id>=<hash>`) the refused operation ran under,
 * including those on items it would write as a side effect (auto-unblocked
 * dependents). Undefined when no single invocation can declare them: nested
 * scopes expect different revisions of the same item, or a write inside the
 * refused operation (a beforeCommand hook) advanced a guard past the revision
 * its caller declared, so replaying the caller's own guard would conflict.
 */
export function activeItemRevisionExpectations(pmRoot: string): string[] | undefined {
  const scopes = revisionScopes.getStore() ?? [];
  if (scopes.length === 0) return [];
  const resolvedRoot = canonicalTrackerRoot(pmRoot);
  const expected = new Map<string, Set<string>>();
  for (const scope of scopes) {
    if (scope.pmRoot !== resolvedRoot) continue;
    for (const [id, entry] of scope.entries) {
      if (entry.expected !== entry.declared) return undefined;
      expected.set(id, (expected.get(id) ?? new Set()).add(entry.expected));
    }
  }
  // Nested scopes that expect different revisions of one item cannot be spelled as one invocation's guards.
  if ([...expected.values()].some((hashes) => hashes.size > 1)) return undefined;
  return [...expected].map(([id, hashes]) => `${id}=${[...hashes][0]!}`);
}

/**
 * Whether any active scope declared a revision on this tracker, so writers that
 * must read a document to learn its embedded id can skip that read otherwise.
 */
export function hasActiveItemRevisionScope(pmRoot: string): boolean {
  const resolvedRoot = canonicalTrackerRoot(pmRoot);
  return (revisionScopes.getStore() ?? []).some((scope) => scope.pmRoot === resolvedRoot && scope.entries.size > 0);
}

/** Refuse a locked write whose stored revision is not the one its scope declared. */
function assertItemRevisionExpectations(pmRoot: string, document: ItemDocument, targetId: string): void {
  const entries = matchingRevisionEntries(pmRoot, [targetId, document.metadata.id]);
  if (entries.length > 0) assertRevisionEntries(entries, targetId, hashDocument(document), false, pmRoot);
}

/**
 * Refuse a guarded write over a live item that cannot be read as a document
 * (restore recovering corrupt bytes). No declared revision describes those bytes,
 * so the guard refuses rather than judging the history reconstruction restore
 * would write from. `current_revision` is the SHA-256 of the unreadable text.
 */
export function assertItemRevisionExpectationsOnUnreadable(pmRoot: string, targetId: string, raw: string): void {
  const entries = matchingRevisionEntries(pmRoot, [targetId]);
  if (entries.length > 0) assertRevisionEntries(entries, targetId, sha256Hex(raw), true, pmRoot);
}

/** `reason` of a revision refusal over a document that could be read and changed since the caller's read. */
export const ITEM_REVISION_CONFLICT_CHANGED_REASON = "revision_changed";

/** `reason` of a revision refusal over a live document that cannot be read at all. */
export const ITEM_REVISION_CONFLICT_UNREADABLE_REASON = "document_unreadable";

/**
 * The invocation a revision refusal's read-only recovery commands must replay
 * (pm-gh1677): the store layer never sees global options, so hosts that do
 * re-render the commands with the caller's tracker scope and output mode.
 */
export interface ItemRevisionRecoveryInvocation {
  /** Tracker and extension scope tokens, such as `--pm-path <root>` and `--no-extensions`. */
  scopeArgs?: readonly string[];
  /**
   * Output-encoding tokens the recovery reads carry, such as `--json` or
   * `--output-format toon`; empty for the tracker's default encoding.
   * Defaults to `--json`, the machine-readable form.
   */
  outputArgs?: readonly string[];
}

/** Recovery guidance fields of a revision refusal. */
export type ItemRevisionConflictGuidance = Required<Pick<PmCliErrorContext, "required" | "examples" | "nextSteps">>;

/**
 * Render the read-only recovery of a revision refusal for one invocation. The
 * commands only re-read the item; deciding again and retrying with a fresh
 * `--expect-hash` stays with the caller, so the guard never writes on its own.
 */
export function itemRevisionConflictGuidance(
  targetId: string,
  unreadable: boolean,
  invocation: ItemRevisionRecoveryInvocation = {},
): ItemRevisionConflictGuidance {
  const scope = [...(invocation.scopeArgs ?? [])];
  const output = [...(invocation.outputArgs ?? ["--json"])];
  const read = renderPmCommand([...scope, "get", targetId, ...output]);
  const history = renderPmCommand([...scope, "history", targetId, "--limit", "5", ...output]);
  return {
    required: unreadable
      ? `Recover ${targetId} without --expect-hash (${renderPmCommand([...scope, "restore", targetId, "<version>"])}), since no declared revision describes an unreadable document.`
      : `Re-read ${targetId} (${read} reports item_hash), decide again against the current revision, then retry with --expect-hash <item_hash>.`,
    examples: [renderPmCommand([...scope, "get", targetId, "--fields", "item_hash", ...output]), history],
    nextSteps: [read, history],
  };
}

/**
 * Canonical tracker root of each revision refusal the locked-write guard
 * raised. Shared through the global registry like the scopes themselves, so a
 * guard opened through one published SDK entrypoint recognizes a refusal
 * another entrypoint's bundle raised.
 */
const REFUSAL_TRACKERS_KEY = Symbol.for("@unbrained/pm-cli/item-revision-refusal-trackers");
const refusalTrackerRegistry = globalThis as typeof globalThis & { [REFUSAL_TRACKERS_KEY]?: WeakMap<object, string> };
const refusalTrackers = (refusalTrackerRegistry[REFUSAL_TRACKERS_KEY] ??= new WeakMap<object, string>());

/** Wrappers searched for an originating refusal (composition steps wrap it as `cause`). */
const REFUSAL_CAUSE_DEPTH = 8;

/**
 * The canonical tracker whose locked write raised this revision refusal, or
 * undefined for a refusal the guard did not raise itself. A wrapper that kept
 * the refusal as its `cause` reports the refusal's tracker. Nested scopes use
 * it so only the scope bound to that tracker re-renders the recovery.
 */
export function itemRevisionRefusalTracker(error: unknown): string | undefined {
  for (const link of refusalCauseChain(error)) {
    const tracker = refusalTrackers.get(link);
    if (tracker !== undefined) return tracker;
  }
  return undefined;
}

/**
 * The error and the wrappers it keeps as `cause`, bounded. A `cause` accessor
 * that throws ends the chain: inspecting an unrelated error for a refusal must
 * never replace that error with the accessor's exception.
 */
function* refusalCauseChain(error: unknown): Generator<object> {
  let current = error;
  for (let depth = 0; depth < REFUSAL_CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    yield current;
    try {
      current = (current as { cause?: unknown }).cause;
    } catch {
      return;
    }
  }
}

/** Mark matching entries checked and refuse the first one the locked revision does not satisfy. */
function assertRevisionEntries(entries: readonly ItemRevisionScopeEntry[], targetId: string, current: string, unreadable: boolean, pmRoot: string): void {
  for (const entry of entries) {
    entry.checked = true;
    if (!unreadable && entry.expected === current) continue;
    throw trackRefusal(pmRoot, new PmCliError(
      `Item ${targetId} is no longer at the expected revision ${entry.expected.slice(0, 12)}${unreadable ? " (its live document cannot be read)" : ""}; refusing to write over a revision this decision did not see.${entry.committed ? " Earlier writes by this same invocation already committed." : " Nothing was written to this item."}`,
      EXIT_CODE.CONFLICT,
      {
        code: "item_revision_conflict",
        item_id: targetId,
        expected_revision: entry.expected,
        current_revision: current,
        reason: unreadable ? ITEM_REVISION_CONFLICT_UNREADABLE_REASON : ITEM_REVISION_CONFLICT_CHANGED_REASON,
        why: "The caller declared the revision its decision was based on, and another write changed the item before this locked write.",
        ...itemRevisionConflictGuidance(targetId, unreadable),
      },
    ));
  }
}

/**
 * Whether a revision refusal was raised by this tracker's guard. A refusal
 * with no recorded tracker (one another producer built) is attributed to the
 * caller's tracker, as before nested scopes were distinguished.
 */
export function isItemRevisionRefusalFrom(error: unknown, pmRoot: string): boolean {
  const tracker = itemRevisionRefusalTracker(error);
  return tracker === undefined || tracker === canonicalTrackerRoot(pmRoot);
}

/**
 * Refusals whose recovery was already rendered for the invocation that ran
 * them. An enclosing scope, even on the same tracker, keeps that rendering, so
 * an inner caller's extension isolation and encoding survive. Shared like the
 * tracker registry.
 */
const SCOPED_REFUSALS_KEY = Symbol.for("@unbrained/pm-cli/item-revision-scoped-refusals");
const scopedRefusalRegistry = globalThis as typeof globalThis & { [SCOPED_REFUSALS_KEY]?: WeakSet<object> };
const scopedRefusals = (scopedRefusalRegistry[SCOPED_REFUSALS_KEY] ??= new WeakSet<object>());

/** Whether this refusal (or a refusal it wraps as `cause`) already carries invocation-scoped recovery. */
export function isItemRevisionRefusalScoped(error: unknown): boolean {
  for (const link of refusalCauseChain(error)) {
    if (scopedRefusals.has(link)) return true;
  }
  return false;
}

/** Record that a refusal's recovery was rendered for its own invocation. */
export function markItemRevisionRefusalScoped(error: PmCliError): PmCliError {
  scopedRefusals.add(error);
  return error;
}

/** Keep a refusal's originating tracker, and whether it was scoped, on an error re-created from it. */
export function retainItemRevisionRefusalTracker(source: unknown, target: PmCliError): PmCliError {
  const tracker = itemRevisionRefusalTracker(source);
  if (tracker !== undefined) refusalTrackers.set(target, tracker);
  if (isItemRevisionRefusalScoped(source)) scopedRefusals.add(target);
  return target;
}

function trackRefusal(pmRoot: string, error: PmCliError): PmCliError {
  refusalTrackers.set(error, canonicalTrackerRoot(pmRoot));
  return error;
}

/**
 * Evaluate matching preconditions only after the item lock has been acquired
 * and its document read. `targetId` names the locked item explicitly, so a
 * deleted item's empty tombstone document is still judged against its own
 * expectations instead of matching nothing.
 */
export function assertItemMutationPreconditions(pmRoot: string, document: ItemDocument, targetId: string = document.metadata.id): void {
  assertItemRevisionExpectations(pmRoot, document, targetId);
  for (const condition of conditionsFor(pmRoot, [targetId, document.metadata.id])) condition.validate(document);
}

/** Scoped transaction guards bound to either identity of the locked item (probe spelling or embedded id). */
function conditionsFor(pmRoot: string, ids: readonly unknown[]): ItemMutationPrecondition[] {
  const resolvedRoot = path.resolve(pmRoot);
  return (preconditions.getStore() ?? []).filter((condition) => condition.pmRoot === resolvedRoot && ids.includes(condition.id));
}

/**
 * Notify matching scoped guards of their own committed document (a tombstone
 * after delete) before releasing the item lock. `aliasIds` carries identities
 * the committed document no longer has, such as a deleted item's embedded id.
 * `revision` overrides the document's hash when the stored state is not that
 * document (a storage override persisted something the store cannot parse).
 */
export function advanceItemMutationPreconditions(pmRoot: string, document: ItemDocument, targetId: string = document.metadata.id, aliasIds: readonly string[] = [], revision?: string): void {
  const entries = matchingRevisionEntries(pmRoot, [targetId, document.metadata.id, ...aliasIds]);
  if (entries.length > 0) {
    const committed = revision ?? hashDocument(document);
    for (const entry of entries) {
      entry.expected = committed;
      entry.committed = true;
    }
  }
  for (const condition of conditionsFor(pmRoot, [targetId, document.metadata.id, ...aliasIds])) condition.committed?.(document);
}

/** Collect target-scoped immutable attribution (keyed by either identity of the locked item) without attributing another caller's writes. */
export function itemMutationPreconditionHistoryContext(pmRoot: string, ids: readonly unknown[]): Record<string, unknown> {
  return Object.assign({}, ...conditionsFor(pmRoot, ids).map((condition) => condition.historyContext));
}
