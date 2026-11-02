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
import path from "node:path";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { hashDocument } from "../../core/history/history.js";
import { readHistoryEntries } from "../../core/history/read.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import {
  bindItemRevisionScope,
  createItemRevisionScope,
  itemRevisionScopeReceipt,
  runWithItemRevisionScope,
  type ItemRevisionScope,
} from "../../core/store/item-mutation-precondition.js";
import { buildItemNotFoundError, locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError, type PmCliErrorDetails } from "../../core/shared/errors.js";
import type { HistoryEntry } from "../../types/index.js";
import { PM_TOOL_ACTIONS } from "../cli-contracts/enum-contracts.js";
import { isMutationAction } from "../mutation-guard.js";

export type { ItemRevisionScope } from "../../core/store/item-mutation-precondition.js";

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
    return raw.split(",").map((token) => token.trim()).filter((token) => token.length > 0).map((token) => {
      const separator = token.lastIndexOf("=");
      const id = separator === -1 ? undefined : token.slice(0, separator).trim();
      if (id !== undefined && id.length === 0) throw invalidExpectHash(token, "the item id before = is empty");
      const itemHash = normalizeExpectedItemHash(separator === -1 ? token : token.slice(separator + 1));
      return id === undefined ? { itemHash } : { id, itemHash };
    });
  });
}

async function locateRevisionTarget(pmRoot: string, id: string) {
  const settings = await readSettings(pmRoot);
  const typeToFolder = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations()).type_to_folder;
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeToFolder);
  if (!located) throw await buildItemNotFoundError(pmRoot, id, settings.id_prefix, typeToFolder);
  return { located, settings };
}

function resolveRevisionRoot(context: ItemRevisionContext): string {
  return resolvePmRoot(context.cwd ?? process.cwd(), context.pmRoot);
}

/** Read the current revision of one item without writing anything. */
export async function readItemRevision(id: string, context: ItemRevisionContext = {}): Promise<ItemRevision> {
  const pmRoot = resolveRevisionRoot(context);
  const { located, settings } = await locateRevisionTarget(pmRoot, id);
  const { document } = await readLocatedItem(located, { schema: settings.schema });
  return { id: located.id, item_hash: hashDocument(document) };
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
    const { located } = await locateRevisionTarget(pmRoot, target);
    resolved.push({ id: located.id, itemHash: spec.itemHash });
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
    history = await readHistoryEntries(path.join(pmRoot, "history", `${id}.jsonl`), id);
  } catch {
    return undefined;
  }
  let anchor = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]!.after_hash === expectedHash) {
      anchor = index;
      break;
    }
  }
  if (anchor === -1) return { expected_revision_recorded: false, changes_since: [], changes_since_omitted: 0 };
  const later = history.slice(anchor + 1);
  const shown = later.slice(-ITEM_REVISION_CONFLICT_CHANGE_LIMIT);
  return {
    expected_revision_recorded: true,
    changes_since: shown.map((entry) => ({ ts: entry.ts, op: entry.op, author: entry.author, fields: changedTopLevelFields(entry) })),
    changes_since_omitted: later.length - shown.length,
  };
}

/** Whether an error is the locked-write expected-revision refusal. */
export function isItemRevisionConflict(error: unknown): error is PmCliError {
  return error instanceof PmCliError && error.code === ITEM_REVISION_CONFLICT_CODE;
}

/**
 * Attach bounded change evidence to a revision conflict. The evidence is read
 * after the lock is released, so it describes the record as it was then; the
 * refusal's `current_revision` remains the revision the locked write found.
 */
export async function enrichItemRevisionConflict(error: unknown, pmRoot: string): Promise<unknown> {
  if (!isItemRevisionConflict(error) || error.context.details !== undefined) return error;
  const id = error.context.item_id;
  const expected = error.context.expected_revision;
  if (typeof id !== "string" || typeof expected !== "string") return error;
  const changes = await describeItemRevisionChanges(pmRoot, id, expected);
  if (changes === undefined) return error;
  const details: PmCliErrorDetails = {
    expected_revision_recorded: changes.expected_revision_recorded,
    changes_since: changes.changes_since.map((change) => ({ ts: change.ts, op: change.op, author: change.author, fields: [...change.fields] })),
    changes_since_omitted: changes.changes_since_omitted,
  };
  const enriched = new PmCliError(error.message, error.exitCode, { ...error.context, details });
  enriched.stack = error.stack;
  return enriched;
}

/**
 * Run an operation under an already-bound scope and return its receipt,
 * enriching a revision refusal with bounded change evidence.
 */
export async function runWithBoundItemRevisionScope<T>(
  scope: ItemRevisionScope,
  operation: () => Promise<T>,
): Promise<ExpectedItemRevisionsOutcome<T>> {
  try {
    const result = await runWithItemRevisionScope(scope, operation);
    return { result, ...itemRevisionScopeReceipt(scope) };
  } catch (error: unknown) {
    throw scope.pmRoot === undefined ? error : await enrichItemRevisionConflict(error, scope.pmRoot);
  }
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
  const pmRoot = resolveRevisionRoot(context);
  const specs = expectations.map(({ id, itemHash }) => ({ id, itemHash: normalizeExpectedItemHash(itemHash) }));
  const scope = createItemRevisionScope();
  bindItemRevisionScope(scope, pmRoot, await resolveExpectedItemRevisions(pmRoot, specs));
  return runWithBoundItemRevisionScope(scope, operation);
}

export { bindItemRevisionScope, createItemRevisionScope, itemRevisionScopeReceipt, runWithItemRevisionScope };

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
export function assertExpectHashAdmissible(action: string): void {
  if (NATIVE_ACTIONS.has(action) && !isMutationAction(action)) throw expectHashRequiresMutation(action);
}

function expectHashRequiresMutation(action: string): PmCliError {
  return new PmCliError(`--expect-hash guards item writes, and ${action} is not a mutation.`, EXIT_CODE.USAGE, {
    code: "expect_hash_requires_mutation",
    required: "Use --expect-hash (MCP/SDK expectHash) only on a command or action that writes items.",
  });
}

/** Append unchecked-expectation warnings to an action result without changing its shape otherwise. */
function withUncheckedRevisionWarnings<T>(result: T, unchecked: readonly string[]): T {
  if (unchecked.length === 0 || typeof result !== "object" || result === null || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  record.warnings = [...warnings, ...unchecked.map(itemRevisionUncheckedWarning)];
  return result;
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
}): Promise<T> {
  const raw = params.expectHash;
  if (raw !== undefined && typeof raw !== "string" && !(Array.isArray(raw) && raw.every((entry) => typeof entry === "string"))) {
    throw invalidExpectHash(JSON.stringify(raw) ?? String(raw), "expected a string or an array of strings");
  }
  const specs = parseExpectHashSpecs(raw as string | string[] | undefined);
  if (specs.length === 0) return params.run();
  assertExpectHashAdmissible(params.action);
  const scope = createItemRevisionScope();
  bindItemRevisionScope(scope, params.pmRoot, await resolveExpectedItemRevisions(params.pmRoot, specs, params.defaultId));
  const outcome = await runWithBoundItemRevisionScope(scope, params.run);
  return withUncheckedRevisionWarnings(outcome.result, outcome.unchecked);
}
