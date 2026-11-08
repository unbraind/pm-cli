/**
 * @module sdk/lifecycle/item-revision
 *
 * Expected-revision preconditions for read-decide-write work (pm-gh1576).
 * Read an item's revision, decide, then run any SDK, CLI or MCP mutation so
 * that it refuses atomically, under the item lock, when another writer changed
 * the item after that read. The check runs inside the locked item store, so it
 * covers every item write the wrapped operation makes, including writes made
 * by extension commands and bulk transactions.
 */
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { hashDocument } from "../../core/history/history.js";
import { readHistoryEntries } from "../../core/history/read.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import {
  bindItemRevisionScope,
  createItemRevisionScope,
  ITEM_REVISION_CONFLICT_CHANGED_REASON,
  ITEM_REVISION_CONFLICT_UNREADABLE_REASON,
  isItemRevisionRefusalFrom,
  isItemRevisionRefusalScoped,
  itemRevisionConflictGuidance,
  markItemRevisionRefusalScoped,
  retainItemRevisionRefusalTracker,
  itemRevisionScopeReceipt,
  runWithItemRevisionScope,
  activeItemRevisionExpectations,
  type ItemRevisionRecoveryInvocation,
  type ItemRevisionScope,
} from "../../core/store/item-mutation-precondition.js";
import { buildItemNotFoundError, locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getHistoryPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError, type PmCliErrorDetails } from "../../core/shared/errors.js";
import type { HistoryEntry, ItemDocument } from "../../types/index.js";
import { PM_EXPECT_HASH_ACTIONS, PM_TOOL_ACTIONS } from "../cli-contracts/enum-contracts.js";
import { resolveHistorySubject } from "../history/subject.js";
import { resolvePhysicalItemId } from "../query/declared-blockers.js";
import { EMPTY_CANONICAL_DOCUMENT } from "../../core/shared/constants.js";
import { isMutationAction } from "../mutation-guard.js";
import { isPmCliExpectedError } from "../errors.js";

export type { ItemRevisionRecoveryInvocation, ItemRevisionScope } from "../../core/store/item-mutation-precondition.js";

/** Refusal code for a locked write that found a revision other than the declared one. */
export const ITEM_REVISION_CONFLICT_CODE = "item_revision_conflict";

/** Most recent history entries a conflict refusal describes. */
export const ITEM_REVISION_CONFLICT_CHANGE_LIMIT = 10;

const ITEM_HASH_PATTERN = /^[0-9a-f]{64}$/u;

/** One item revision a caller decided on. */
export interface ExpectedItemRevision {
  /** Item id; unprefixed ids are normalized with the workspace id prefix. */
  id: string;
  /** The `item_hash` returned by `pm get` or {@link readItemRevision}. */
  itemHash: string;
}

/** Current revision of one item. */
export interface ItemRevision {
  /** Canonical item id. */
  id: string;
  /** SHA-256 of the canonical item document, equal to its latest history `after_hash`. */
  item_hash: string;
}

/** Tracker selection for revision reads and guarded operations. */
export interface ItemRevisionContext {
  /** Tracker root (the SDK equivalent of `--pm-path`). */
  pmRoot?: string;
  /** Working directory used when `pmRoot` is omitted. */
  cwd?: string;
}

/** Result of an operation run under expected revisions. */
export interface ExpectedItemRevisionsOutcome<T> {
  /** Value returned by the guarded operation. */
  result: T;
  /** Canonical ids whose expectation a locked write evaluated. */
  checked: string[];
  /** Canonical ids the operation never wrote, so their expectation was never evaluated. */
  unchecked: string[];
}

/** One parsed `--expect-hash` / `expect_hash` token before id resolution. */
export interface ExpectHashSpec {
  /** Explicit target id, or undefined when the token binds to the command's item. */
  id?: string;
  /** Normalized lowercase revision. */
  itemHash: string;
}

/** One history entry summarized for a revision conflict. */
export interface ItemRevisionChange {
  /** Entry timestamp. */
  ts: string;
  /** History operation. */
  op: string;
  /** Recorded author. */
  author: string;
  /** Top-level metadata fields (or `body`) the entry changed. */
  fields: string[];
}

function invalidExpectHash(value: string, reason: string): PmCliError {
  return new PmCliError(`Invalid expected revision ${JSON.stringify(value)}: ${reason}.`, EXIT_CODE.USAGE, {
    code: "expect_hash_invalid",
    value,
    required: "Pass the 64-character item_hash from pm get <id> --json, optionally as <id>=<item_hash>.",
    examples: ["--expect-hash <item_hash>", "--expect-hash pm-a1b2=<item_hash>"],
  });
}

/** Normalize one declared revision, refusing anything that cannot be an item_hash. */
export function normalizeExpectedItemHash(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ITEM_HASH_PATTERN.test(normalized)) {
    throw invalidExpectHash(String(value), "the revision is not a 64-character hexadecimal item_hash");
  }
  return normalized;
}

/**
 * Parse expected-revision tokens. A bare hash binds to the command's item; the
 * `<id>=<hash>` form names its target explicitly, which bulk commands require.
 */
export function parseExpectHashSpecs(values: string | readonly string[] | undefined): ExpectHashSpec[] {
  const tokens = values === undefined ? [] : typeof values === "string" ? [values] : values;
  return tokens.flatMap((raw) => {
    if (typeof raw !== "string") throw invalidExpectHash(String(raw), "expected a string");
    const parts = raw.split(",").map((token) => token.trim()).filter((token) => token.length > 0);
    // A supplied but empty value (for example an unset shell variable) must not silently drop the guard.
    if (parts.length === 0) throw invalidExpectHash(raw, "the value is empty");
    return parts.map((token) => {
      const separator = token.lastIndexOf("=");
      const id = separator === -1 ? undefined : token.slice(0, separator).trim();
      if (id !== undefined && id.length === 0) throw invalidExpectHash(token, "the item id before = is empty");
      const itemHash = normalizeExpectedItemHash(separator === -1 ? token : token.slice(separator + 1));
      return id === undefined ? { itemHash } : { id, itemHash };
    });
  });
}

/**
 * Resolve a revision target. A live item resolves to its file; a deleted item
 * with retained history resolves to its canonical id with no file, whose
 * revision is the empty tombstone its delete recorded.
 */
async function locateRevisionTarget(pmRoot: string, id: string) {
  const settings = await readSettings(pmRoot);
  const typeToFolder = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations()).type_to_folder;
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeToFolder);
  if (located) {
    // Bind to the embedded identity, not the probe spelling: on a case-insensitive filesystem
    // `pm-a` and `PM-A` locate one file, and the locked write matches the embedded id too.
    const { document } = await readLocatedItem(located, { schema: settings.schema });
    // A file whose embedded id differs from its physical filename spelling (even by case on a
    // case-sensitive filesystem) has two identities; a later identity repair would detach a guard
    // bound to either one, so no revision is bound to it. Case-insensitive probe aliases still bind.
    if (document.metadata.id !== await resolvePhysicalItemId(located.itemPath, located.id)) {
      throw new PmCliError(`Item file ${located.id} embeds the id ${document.metadata.id}; no revision can be bound to an item whose identity is in conflict.`, EXIT_CODE.CONFLICT, {
        code: "item_identity_conflict",
        item_id: located.id,
        required: `Repair ${located.id}'s identity first (pm validate reports it; pm restore ${located.id} <version> recovers a recorded state), then read its item_hash again.`,
      });
    }
    return { id: document.metadata.id, document };
  }
  try {
    return { id: (await resolveHistorySubject(pmRoot, id, settings, typeToFolder)).id, document: EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument };
  } catch {
    throw await buildItemNotFoundError(pmRoot, id, settings.id_prefix, typeToFolder);
  }
}

function resolveRevisionRoot(context: ItemRevisionContext): string {
  return resolvePmRoot(context.cwd ?? process.cwd(), context.pmRoot);
}

/** Read the current revision of one item (the tombstone revision for a deleted item) without writing anything. */
export async function readItemRevision(id: string, context: ItemRevisionContext = {}): Promise<ItemRevision> {
  const target = await locateRevisionTarget(resolveRevisionRoot(context), id);
  return { id: target.id, item_hash: hashDocument(target.document) };
}

/**
 * Resolve parsed tokens to canonical ids. A bare token binds to `defaultId`;
 * without one the caller must name the target explicitly.
 */
export async function resolveExpectedItemRevisions(
  pmRoot: string,
  specs: readonly ExpectHashSpec[],
  defaultId?: string,
): Promise<ExpectedItemRevision[]> {
  const resolved: ExpectedItemRevision[] = [];
  for (const spec of specs) {
    const target = spec.id ?? defaultId;
    if (target === undefined || target.trim().length === 0) {
      throw new PmCliError("A bare expected revision needs an item to bind to.", EXIT_CODE.USAGE, {
        code: "expect_hash_target_required",
        required: "This command has no single item argument; name each target as --expect-hash <id>=<item_hash>.",
        examples: ["--expect-hash pm-a1b2=<item_hash>"],
      });
    }
    resolved.push({ id: (await locateRevisionTarget(pmRoot, target)).id, itemHash: spec.itemHash });
  }
  return resolved;
}

/** Top-level field a canonical patch pointer changes: `/metadata/tags/0` is `tags`, `/body` is `body`. */
function changedTopLevelFields(entry: HistoryEntry): string[] {
  return [...new Set(entry.patch.map((change) => {
    const segments = change.path.split("/");
    return String(segments[1] === "metadata" ? segments[2] : segments[1]);
  }))].sort();
}

/**
 * Describe what changed after the declared revision, from the item's immutable
 * history. Returns undefined when the history cannot be read.
 */
export async function describeItemRevisionChanges(
  pmRoot: string,
  id: string,
  expectedHash: string,
): Promise<{ expected_revision_recorded: boolean; changes_since: ItemRevisionChange[]; changes_since_omitted: number } | undefined> {
  let history: HistoryEntry[];
  try {
    history = await readHistoryEntries(getHistoryPath(pmRoot, id), id);
  } catch {
    return undefined;
  }
  // The latest entry that ends at the expected revision, or (when that entry used another digest,
  // such as a SHA-512 anchor) starts from it: canonical SHA-256 item_hash then matches its before_hash.
  let start = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]!;
    if (entry.after_hash === expectedHash) {
      start = index + 1;
      break;
    }
    if (entry.before_hash === expectedHash) {
      start = index;
      break;
    }
  }
  if (start === -1) return { expected_revision_recorded: false, changes_since: [], changes_since_omitted: 0 };
  const later = history.slice(start);
  const shown = later.slice(-ITEM_REVISION_CONFLICT_CHANGE_LIMIT);
  return {
    expected_revision_recorded: true,
    changes_since: shown.map((entry) => ({ ts: entry.ts, op: entry.op, author: entry.author, fields: changedTopLevelFields(entry) })),
    changes_since_omitted: later.length - shown.length,
  };
}

/** Structured revision fields a bulk row keeps when its item refused an expected revision. */
export interface ItemRevisionConflictRowFields {
  /** Always `item_revision_conflict`. */
  error_code?: typeof ITEM_REVISION_CONFLICT_CODE;
  /** Revision the row's locked write expected. */
  expected_revision?: string;
  /** Revision the row's locked write found. */
  current_revision?: string;
  /** Bounded history evidence of what changed since the expected revision, as single-item refusals report it. */
  details?: PmCliErrorDetails;
}

/**
 * Keep the typed refusal on a bulk row: partial-success commands report a
 * stale row's code, both revisions and the same bounded change evidence a
 * single-item refusal carries, not only its message.
 */
export async function itemRevisionConflictRowFields(error: unknown, pmRoot: string): Promise<ItemRevisionConflictRowFields> {
  if (!isItemRevisionConflict(error)) return {};
  const enriched = await enrichItemRevisionConflict(error, pmRoot) as PmCliError;
  return {
    error_code: ITEM_REVISION_CONFLICT_CODE,
    expected_revision: String(enriched.context.expected_revision),
    current_revision: String(enriched.context.current_revision),
    details: enriched.context.details,
  };
}

/**
 * Whether an error is the locked-write expected-revision refusal. Structural, not
 * `instanceof`: a refusal raised through another published SDK entrypoint's bundle
 * is a different PmCliError class with the same shape.
 */
export function isItemRevisionConflict(error: unknown): error is PmCliError {
  return isPmCliExpectedError(error) && error.context.code === ITEM_REVISION_CONFLICT_CODE;
}

/**
 * Raise the first expected-revision refusal among errors collected by a
 * best-effort batch (validate auto-fix), once every member was attempted.
 */
export function throwFirstItemRevisionConflict(errors: readonly unknown[]): void {
  const conflict = errors.find((error) => isItemRevisionConflict(error));
  if (conflict !== undefined) throw conflict;
}

/** Refusal for a guard on an invocation an extension parser or preflight override rewrote. */
export function expectHashInvocationRewrittenError(): PmCliError {
  return new PmCliError("--expect-hash cannot guard an invocation an extension override rewrote: which item it writes is not provable.", EXIT_CODE.USAGE, {
    code: "expect_hash_invocation_rewritten",
    required: "Run the command without the rewriting extension (--no-extensions), or drop --expect-hash.",
    why: "An extension parser or preflight override changed this invocation's tracker or arguments, and final dispatch, the extension SDK client and the guard do not share one rewritten view.",
  });
}

/**
 * Re-render a revision refusal's read-only recovery (`required`, `examples`,
 * `next_steps`) for the invocation that raised it (pm-gh1677), so replaying
 * them reads the same tracker in the same output mode. Other errors, and an
 * omitted invocation, pass through unchanged.
 */
export function scopeItemRevisionConflict(error: unknown, invocation: ItemRevisionRecoveryInvocation | undefined): unknown {
  // Only the locked-write guard's own guidance is re-rendered; a producer that rewrote the
  // refusal (close's post-close fan-out report) set its reason and already scoped its commands.
  if (invocation === undefined || !isItemRevisionConflict(error) || typeof error.context.item_id !== "string" || isItemRevisionRefusalScoped(error)) return error;
  const unreadable = error.context.reason === ITEM_REVISION_CONFLICT_UNREADABLE_REASON;
  if (!unreadable && error.context.reason !== ITEM_REVISION_CONFLICT_CHANGED_REASON) return error;
  const scoped = markItemRevisionRefusalScoped(retainItemRevisionRefusalTracker(error, new PmCliError(error.message, error.exitCode, { ...error.context, ...itemRevisionConflictGuidance(error.context.item_id, unreadable, invocation) })));
  scoped.stack = error.stack;
  return scoped;
}

/**
 * Attach bounded change evidence to a revision conflict. The evidence is read
 * after the lock is released, so it describes the record as it was then; the
 * refusal's `current_revision` remains the revision the locked write found.
 * With an `invocation`, the recovery commands are also re-rendered for it. A
 * refusal raised by another tracker's guard is returned unchanged.
 */
export async function enrichItemRevisionConflict(error: unknown, pmRoot: string, invocation?: ItemRevisionRecoveryInvocation): Promise<unknown> {
  // A refusal another tracker's guard raised (an inner scope nested in this one) is that
  // scope's to describe: neither its evidence nor its recovery commands belong to this tracker.
  if (!isItemRevisionRefusalFrom(error, pmRoot)) return error;
  const scoped = scopeItemRevisionConflict(error, invocation);
  if (!isItemRevisionConflict(scoped) || scoped.context.details !== undefined) return scoped;
  const id = scoped.context.item_id;
  const expected = scoped.context.expected_revision;
  if (typeof id !== "string" || typeof expected !== "string") return scoped;
  let changes: Awaited<ReturnType<typeof describeItemRevisionChanges>>;
  try {
    changes = await describeItemRevisionChanges(pmRoot, id, expected);
  } catch {
    // Evidence is best-effort: malformed history must never replace the typed refusal.
    return scoped;
  }
  if (changes === undefined) return scoped;
  const details: PmCliErrorDetails = {
    expected_revision_recorded: changes.expected_revision_recorded,
    changes_since: changes.changes_since.map((change) => ({ ts: change.ts, op: change.op, author: change.author, fields: [...change.fields] })),
    changes_since_omitted: changes.changes_since_omitted,
  };
  const enriched = retainItemRevisionRefusalTracker(scoped, new PmCliError(scoped.message, scoped.exitCode, { ...scoped.context, details }));
  enriched.stack = scoped.stack;
  return enriched;
}

/**
 * Run an operation under an already-bound scope and return its receipt,
 * enriching a revision refusal with bounded change evidence.
 */
export async function runWithBoundItemRevisionScope<T>(
  scope: ItemRevisionScope,
  operation: () => Promise<T>,
  invocation?: ItemRevisionRecoveryInvocation,
): Promise<ExpectedItemRevisionsOutcome<T>> {
  try {
    const result = await runWithItemRevisionScope(scope, operation);
    return { result, ...itemRevisionScopeReceipt(scope) };
  } catch (error: unknown) {
    throw scope.pmRoot === undefined ? error : await enrichItemRevisionConflict(error, scope.pmRoot, invocation);
  }
}

/**
 * The recovery invocation an SDK caller's tracker selection implies: an
 * explicit `pmRoot` or `cwd` names the tracker on every recovery command,
 * because the caller's process may not run where that tracker is implicit.
 */
function revisionRecoveryInvocation(context: ItemRevisionContext): ItemRevisionRecoveryInvocation | undefined {
  return context.cwd === undefined && context.pmRoot === undefined ? undefined : { scopeArgs: ["--pm-path", resolveRevisionRoot(context)] };
}

/**
 * Run `operation` so every locked write to an expected item first proves the
 * item is still at the declared revision. A mismatch refuses that write with
 * `item_revision_conflict` (exit 4) and leaves the item unchanged. After the
 * operation's own committed write, the expectation advances to that revision,
 * so a multi-write operation does not refuse itself. The receipt lists items
 * the operation never wrote, whose expectation therefore proved nothing.
 */
export async function withExpectedItemRevisions<T>(
  expectations: readonly ExpectedItemRevision[],
  operation: () => Promise<T>,
  context: ItemRevisionContext = {},
): Promise<ExpectedItemRevisionsOutcome<T>> {
  return runWithBoundItemRevisionScope(await bindExpectedItemRevisions(expectations, context), operation, revisionRecoveryInvocation(context));
}

/**
 * Resolve expectations to canonical ids and bind them to a fresh scope, without
 * running anything. Hosts that must resolve targets inside one extension
 * context but run the guarded operation outside it bind first, then call
 * {@link runWithBoundItemRevisionScope}.
 */
export async function bindExpectedItemRevisions(
  expectations: readonly ExpectedItemRevision[],
  context: ItemRevisionContext = {},
): Promise<ItemRevisionScope> {
  const pmRoot = resolveRevisionRoot(context);
  const specs = expectations.map(({ id, itemHash }) => ({ id, itemHash: normalizeExpectedItemHash(itemHash) }));
  const scope = createItemRevisionScope();
  bindItemRevisionScope(scope, pmRoot, await resolveExpectedItemRevisions(pmRoot, specs));
  return scope;
}

export { bindItemRevisionScope, createItemRevisionScope, itemRevisionScopeReceipt, runWithItemRevisionScope };

/**
 * Whether an active revision scope guards writes to this tracker. An enclosing
 * SDK scope (an embedded CLI run) carries revisions the invocation's argv never
 * spelled, so a retry rebuilt from argv alone would drop them (PR #1688 review).
 */
export function isTrackerRevisionGuarded(pmRoot: string): boolean {
  const expectations = activeItemRevisionExpectations(pmRoot);
  return expectations === undefined || expectations.length > 0;
}

/** Warning recorded when an expectation's item was never written by the action. */
export function itemRevisionUncheckedWarning(id: string): string {
  return `expect_hash_unchecked:${id}:no_locked_write_reached_this_item`;
}

const NATIVE_ACTIONS: ReadonlySet<string> = new Set(PM_TOOL_ACTIONS);

/**
 * Refuse an expected revision on a native action that never writes items.
 * Extension and package actions stay admitted because only their handlers
 * know whether they write; the receipt reports any expectation they never reach.
 */
export function assertExpectHashAdmissible(path: string, options: Record<string, unknown> = {}): void {
  // CLI subcommand paths (`package catalog`) classify as their native action (`package-catalog`).
  const hyphenated = path.trim().replace(/\s+/gu, "-");
  const action = NATIVE_ACTIONS.has(hyphenated) ? hyphenated : path;
  // `deps` is a conditional mutation in the history-scope inventory, but it only reads.
  if (NATIVE_ACTIONS.has(action) && (!isMutationAction(action) || action === "deps") && !PM_EXPECT_HASH_ACTIONS.has(action)) {
    throw expectHashRequiresMutationError(action);
  }
  // A background worker is a separate process the in-process scope cannot reach, so refuse instead of
  // reporting a guard its result recording would never evaluate.
  if ((action === "test" || action === "test-all") && options.background === true) {
    throw new PmCliError(`--expect-hash cannot guard ${action} --background: the worker runs in another process.`, EXIT_CODE.USAGE, {
      code: "expect_hash_background_unsupported",
      required: `Run ${action} in the foreground to guard its result recording, or drop --expect-hash for a background run.`,
    });
  }
}

/** Refusal for a revision guard on a command or action that writes no items. */
export function expectHashRequiresMutationError(action: string): PmCliError {
  return new PmCliError(`--expect-hash guards item writes, and ${action} is not a mutation.`, EXIT_CODE.USAGE, {
    code: "expect_hash_requires_mutation",
    required: "Use --expect-hash (MCP/SDK expectHash) only on a command or action that writes items.",
  });
}

/** Append unchecked-expectation warnings to an action result without changing its shape otherwise. */
function withUncheckedRevisionWarnings<T>(result: T, unchecked: readonly string[]): T {
  if (unchecked.length === 0 || typeof result !== "object" || result === null || Array.isArray(result)) return result;
  // A shallow copy: a frozen or reused action result is never mutated after its write committed.
  const record = result as Record<string, unknown>;
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  return { ...record, warnings: [...warnings, ...unchecked.map(itemRevisionUncheckedWarning)] } as T;
}

/**
 * Generic-dispatch entry for the `expectHash` action parameter used by MCP and
 * `PmClient.run`. Tokens follow the CLI grammar: a bare hash binds to the
 * action's `id`, and `<id>=<hash>` names the target explicitly.
 */
export async function dispatchWithExpectedItemRevisions<T>(params: {
  action: string;
  expectHash: unknown;
  defaultId?: string;
  pmRoot: string;
  run: () => Promise<T>;
  /** Nested action options, consulted for modes the guard cannot cover (background test workers). */
  options?: Record<string, unknown>;
  /** Top-level background flag, consulted like `options.background`. */
  background?: unknown;
  /** Invocation whose tracker scope a revision refusal's recovery commands replay. */
  invocation?: ItemRevisionRecoveryInvocation;
}): Promise<T> {
  const raw = params.expectHash;
  if (raw !== undefined && typeof raw !== "string" && !(Array.isArray(raw) && raw.every((entry) => typeof entry === "string"))) {
    throw invalidExpectHash(JSON.stringify(raw) ?? String(raw), "expected a string or an array of strings");
  }
  const specs = parseExpectHashSpecs(raw as string | string[] | undefined);
  if (specs.length === 0) return params.run();
  assertExpectHashAdmissible(params.action, { background: params.background === true || params.options?.background === true });
  const scope = createItemRevisionScope();
  bindItemRevisionScope(scope, params.pmRoot, await resolveExpectedItemRevisions(params.pmRoot, specs, params.defaultId));
  const outcome = await runWithBoundItemRevisionScope(scope, params.run, params.invocation);
  return withUncheckedRevisionWarnings(outcome.result, outcome.unchecked);
}
