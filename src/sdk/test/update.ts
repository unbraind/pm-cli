/**
 * @module sdk/test/update
 *
 * Edits one linked-test metadata entry under the item mutation lock, retaining
 * list position and immutable creation provenance.
 */
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { normalizeLinkedTest } from "../../core/item/item-format.js";
import { parseOnlyIndexValue } from "../../core/test/run-selectors.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { stableValueEquals } from "../../core/shared/serialization.js";
import { nowIso } from "../../core/shared/time.js";
import { mutateItemWithHistoryContextResolver } from "../../core/store/item-store.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { LinkedTest } from "../../types/index.js";
import { assertInitializedTracker } from "../environment/tracker-preflight.js";
import { renderPmCommand, resolvePmCommandScopeArgs } from "../command-line.js";
import { assertLinkedTestContext, linkedTestsHaveSameIdentity, STRUCTURED_LINKED_TEST_KEYS } from "./entry.js";
import { parseLinkedTestJsonEntries } from "./parsers.js";
import type { TestCommandOptions } from "./execution.js";

/** Patch keys naming the immutable command identity of an entry. */
const COMMAND_IDENTITY_KEYS = ["command", "cmd"] as const;

/** Metadata keys an in-place edit may change: command identity, its aliases and provenance are excluded. */
export const EDITABLE_LINKED_TEST_KEYS: readonly string[] = Object.freeze(
  STRUCTURED_LINKED_TEST_KEYS.filter((key) => !["command", "cmd", "timeout"].includes(key)),
);

/** Unambiguous selector evaluated against the current locked collection. */
export type LinkedTestUpdateSelector = { index: number } | { command: string } | { path: string };
/** Explicit metadata values; null removes an optional value without replacing other fields. */
export type LinkedTestMetadataPatch = {
  [K in keyof Omit<LinkedTest, "command" | "provenance" | "provenance_invalid" | "updated_by" | "updated_at">]?: K extends "scope" ? LinkedTest[K] : LinkedTest[K] | null;
};
/** One metadata revision with ordinary mutation ownership and history controls. */
export interface UpdateLinkedTestOptions {
  /** Current entry identity or one-based list position. */
  selector: LinkedTestUpdateSelector;
  /** Fields to change; command and provenance cannot be replaced. */
  patch: LinkedTestMetadataPatch;
  /** Explicit author override, otherwise the configured or detected identity. */
  author?: string;
  /** Explanation retained on the single history event. */
  message?: string;
  /** Explicit ownership override. */
  force?: boolean;
}
/** Receipt identifying the edited entry and semantically changed metadata. */
export interface UpdateLinkedTestResult {
  /** Successful mutation or unchanged retry. */
  ok: true;
  /** Owning item ID. */
  id: string;
  /** Current ordered linked-test collection. */
  tests: LinkedTest[];
  /** Whether authoritative state changed. */
  changed: boolean;
  /** Current collection size. */
  count: number;
  /** One-based position of the selected entry. */
  updated_index: number;
  /** Explicit metadata keys whose normalized values changed. */
  updated_fields: string[];
}

/** Resolve transport edit flags without accepting ambiguous selectors or implicit replacement. */
export function parseLinkedTestUpdateOptions(options: { update?: string; updateIndex?: string | number; setJson?: string }): Pick<UpdateLinkedTestOptions, "selector" | "patch"> | undefined {
  if (options.update === undefined && options.updateIndex === undefined && options.setJson === undefined) return undefined;
  if ((options.update === undefined) === (options.updateIndex === undefined) || options.setJson === undefined) {
    throw new PmCliError("Use exactly one --update or --update-index with --set-json", EXIT_CODE.USAGE);
  }
  let patch: LinkedTestMetadataPatch;
  try { patch = JSON.parse(options.setJson) as LinkedTestMetadataPatch; }
  catch { throw new PmCliError("--set-json must contain a JSON object with explicit linked-test metadata fields", EXIT_CODE.USAGE); }
  if (options.updateIndex !== undefined) return { selector: { index: parseOnlyIndexValue(options.updateIndex, "--update-index") }, patch };
  const value = options.update!;
  const prefix = /^(command|path)=/u.exec(value);
  return { selector: prefix?.[1] === "path" ? { path: value.slice(prefix[0].length) } : { command: prefix ? value.slice(prefix[0].length) : value }, patch };
}

/** Keep metadata editing a separate atomic operation from execution or other collection changes. */
export function assertLinkedTestEditUsage(options: TestCommandOptions): void {
  if ([options.list, options.run, options.progress, options.timeout !== undefined,
    options.acknowledgeLinkedTests,
    options.metricBelow !== undefined, options.metricDiff !== undefined,
    (options.add?.length ?? 0) > 0, (options.addJson?.length ?? 0) > 0,
    (options.remove?.length ?? 0) > 0, (options.removeIndex?.length ?? 0) > 0].some(Boolean)) {
    throw new PmCliError("Edit linked-test metadata separately from listing, additions, removals, execution options, metric filters and trust acknowledgement", EXIT_CODE.USAGE);
  }
}

/** Select exactly one current entry under the mutation lock, refusing absent or ambiguous matches. */
function selectIndex(tests: LinkedTest[], selector: LinkedTestUpdateSelector): number {
  if (typeof selector !== "object" || selector === null || Array.isArray(selector)) {
    throw new PmCliError("Select one linked test by index, command, or path", EXIT_CODE.USAGE);
  }
  const keys = Object.keys(selector);
  if (keys.length !== 1 || !["index", "command", "path"].includes(keys[0])) {
    throw new PmCliError("Select one linked test by index, command, or path", EXIT_CODE.USAGE);
  }
  if ("index" in selector) {
    const index = parseOnlyIndexValue(selector.index, "--update-index");
    if (index <= tests.length) return index - 1;
  } else {
    const key = "command" in selector ? "command" : "path";
    const value = "command" in selector ? selector.command : selector.path;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new PmCliError("Linked-test selector must be a non-empty command or path", EXIT_CODE.USAGE);
    }
    const matches = tests.flatMap((test, index) => test[key] === value ? [index] : []);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new PmCliError(`Linked-test selector is ambiguous; matching indexes: ${matches.map((index) => index + 1).join(", ")}`, EXIT_CODE.USAGE, { code: "linked_test_update_ambiguous", required: "List linked tests and select one current --update-index." });
    }
  }
  throw new PmCliError("No linked test matched the update selector", EXIT_CODE.NOT_FOUND, { code: "linked_test_update_no_match", required: "List linked tests and select a current command, path, or --update-index." });
}

/** Refuse fields an in-place edit cannot change; an empty patch is refused unless the caller allows it. */
function assertEditablePatchFields(patch: Record<string, unknown>, allowEmpty: boolean): void {
  const keys = Object.keys(patch);
  const unsupported = keys.filter((key) => !EDITABLE_LINKED_TEST_KEYS.includes(key));
  if ((keys.length === 0 && !allowEmpty) || unsupported.length > 0) {
    throw new PmCliError("Patch explicit linked-test metadata fields; command, aliases and provenance cannot be edited", EXIT_CODE.USAGE, {
      code: "linked_test_patch_fields_unsupported",
      changed: false,
      ...(unsupported.length > 0 ? { field: unsupported[0] } : {}),
      required: `Patch at least one editable field: ${EDITABLE_LINKED_TEST_KEYS.join(", ")}.`,
      recovery: { allowed_values: [...EDITABLE_LINKED_TEST_KEYS] },
      ...(unsupported.length > 0 ? { nextSteps: [`Remove unsupported field(s) from --set-json: ${unsupported.join(", ")}.`] } : {}),
    });
  }
  if (patch.scope === null) throw new PmCliError("scope is required and cannot be cleared", EXIT_CODE.USAGE);
}

/** The selected entry's retained metadata with the patch's other editable fields and the replacement command. */
function buildReplacementEntry(test: LinkedTest, patch: Record<string, unknown>, command: string): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const key of EDITABLE_LINKED_TEST_KEYS) {
    const value = Object.hasOwn(patch, key) ? patch[key] : test[key as keyof LinkedTest];
    if (value !== undefined && value !== null) entry[key] = value;
  }
  return { command, ...entry };
}

/**
 * Refuse a command edit with the supported replacement route (pm-1rfy0y): a
 * single `pm test` invocation that removes the selected entry and adds the
 * new command with the entry's other metadata, recording fresh provenance.
 */
function assertCommandIdentityUnchanged(params: {
  id: string;
  tests: LinkedTest[];
  index: number;
  patch: unknown;
  global: GlobalOptions;
}): void {
  const { id, tests, index, patch, global } = params;
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return;
  const record = patch as Record<string, unknown>;
  const identityKey = COMMAND_IDENTITY_KEYS.find((key) => Object.hasOwn(record, key));
  if (identityKey === undefined) return;
  const current = tests[index];
  const requested = typeof record[identityKey] === "string" ? (record[identityKey] as string).trim() : "";
  const context = {
    code: "linked_test_command_immutable",
    field: identityKey,
    changed: false as const,
    required: "Replace the entry instead: remove the selected linked test and add the new command in one pm test invocation, which records fresh provenance.",
  };
  if (requested.length === 0 || requested === current.command) {
    throw new PmCliError(
      requested.length === 0
        ? `--set-json cannot set ${identityKey}: a linked test's command is its immutable identity`
        : `--set-json ${identityKey} repeats the selected entry's command; omit it to edit only metadata`,
      EXIT_CODE.USAGE,
      { ...context, nextSteps: [`Patch only editable fields: ${EDITABLE_LINKED_TEST_KEYS.join(", ")}.`] },
    );
  }
  const otherFields = Object.fromEntries(Object.entries(record).filter(([key]) => !COMMAND_IDENTITY_KEYS.includes(key as typeof COMMAND_IDENTITY_KEYS[number])));
  // The retry must apply every requested field: refuse what the edit would refuse instead of dropping it.
  assertEditablePatchFields(otherFields, true);
  const entry = buildReplacementEntry(current, otherFields, requested);
  // Parse exactly as the add path will, so invalid values refuse now rather than in the retry.
  const candidate = parseLinkedTestJsonEntries(JSON.stringify(entry), "--add-json")[0];
  assertLinkedTestContext(candidate);
  const collision = tests.findIndex((test, position) => position !== index && linkedTestsHaveSameIdentity(test, candidate));
  if (collision >= 0) {
    // The add path deduplicates an identical registration, so the retry would delete the selected entry and add nothing.
    throw new PmCliError(
      `--set-json cannot change ${identityKey}: linked test ${collision + 1} already has the requested identity, so a replacement would merge into it`,
      EXIT_CODE.USAGE,
      {
        ...context,
        nextSteps: [
          `Edit linked test ${collision + 1} instead: pm test ${id} --update-index ${collision + 1} --set-json '<editable fields>'.`,
          `Or drop the selected entry: pm test ${id} --remove-index ${index + 1}.`,
        ],
      },
    );
  }
  // Exact command removal survives reordering; a shared or absent command falls back to the locked position.
  const removal = current.command !== undefined && tests.filter((test) => test.command === current.command).length === 1
    ? ["--remove", `command=${current.command}`]
    : ["--remove-index", String(index + 1)];
  const retryArgs = [...resolvePmCommandScopeArgs(global), "test", id, ...removal, "--add-json", JSON.stringify(entry)];
  throw new PmCliError(
    `--set-json cannot change ${identityKey}: a linked test's command is its immutable identity; replace the entry instead`,
    EXIT_CODE.USAGE,
    {
      ...context,
      recovery: { suggested_retry: renderPmCommand(retryArgs), suggested_retry_args: retryArgs },
      nextSteps: [
        "Run the suggested retry: it removes the selected entry and adds the new command in one atomic, history-recorded mutation.",
        `SDK: runTest(${JSON.stringify(id)}, { ${removal[0] === "--remove" ? "remove" : "removeIndex"}: [...], addJson: [...] }) with the same values.`,
      ],
    },
  );
}

/** Validate and normalize explicit metadata fields before deriving a patch that retains creation provenance. */
function applyPatch(test: LinkedTest, patch: LinkedTestMetadataPatch): { test: LinkedTest; fields: string[] } {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new PmCliError("Linked-test metadata patch must be a JSON object", EXIT_CODE.USAGE);
  }
  const keys = Object.keys(patch);
  assertEditablePatchFields(patch as Record<string, unknown>, false);
  const metadata = Object.fromEntries(Object.entries(test).filter(([key]) => (STRUCTURED_LINKED_TEST_KEYS as readonly string[]).includes(key)));
  // A path-only legacy entry needs no new command or fabricated provenance.
  const parsed = normalizeLinkedTest(parseLinkedTestJsonEntries(JSON.stringify({ ...metadata, command: test.command ?? "legacy-path-only", ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === null ? undefined : value])) }), "--set-json")[0]);
  assertLinkedTestContext(parsed);
  const fields = keys.filter((key) => !stableValueEquals(test[key as keyof LinkedTest], parsed[key as keyof LinkedTest]));
  const next = { ...test };
  for (const key of fields) {
    const value = parsed[key as keyof LinkedTest];
    Object.assign(next, { [key]: value });
    if (value === undefined) delete next[key as keyof LinkedTest];
  }
  if (!next.command?.trim() && !next.path?.trim()) {
    throw new PmCliError("Linked-test entry must retain a command or path", EXIT_CODE.USAGE);
  }
  return { test: next, fields };
}

/** Patch one linked-test entry atomically, keeping ordering and original command provenance. */
export async function updateLinkedTest(id: string, options: UpdateLinkedTestOptions, global: GlobalOptions = {}): Promise<UpdateLinkedTestResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await assertInitializedTracker(pmRoot);
  const settings = await readSettings(pmRoot);
  const author = resolveAuthor(options.author, settings.author_default);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  let updatedIndex = 0;
  let updatedFields: string[] = [];
  const result = await mutateItemWithHistoryContextResolver({
    pmRoot, settings, id, author, op: "tests_update", message: options.message, force: options.force,
    skipNoop: true,
    typeToFolder: typeRegistry.type_to_folder,
    resolveHistoryContext: () => ({ linked_test_update: { index: updatedIndex, fields: updatedFields } }),
    mutate(document) {
      const tests = document.metadata.tests ?? [];
      const index = selectIndex(tests, options.selector);
      assertCommandIdentityUnchanged({ id: document.metadata.id, tests, index, patch: options.patch, global });
      const patch = applyPatch(tests[index], options.patch);
      updatedIndex = index + 1;
      updatedFields = patch.fields;
      if (patch.fields.length === 0) return { changedFields: [] };
      document.metadata.tests = tests.map((test, position) => position === index ? { ...patch.test, updated_by: author, updated_at: nowIso() } : test);
      return { changedFields: ["tests"] };
    },
  });
  // A successful selector proves the persisted collection contains an entry.
  const tests = result.item.tests!;
  return { ok: true, id: result.item.id, tests, count: tests.length, changed: result.changedFields.length > 0, updated_index: updatedIndex, updated_fields: updatedFields };
}
