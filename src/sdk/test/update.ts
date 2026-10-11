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
import { assertLinkedTestContext, STRUCTURED_LINKED_TEST_KEYS } from "./entry.js";
import { parseLinkedTestJsonEntries } from "./parsers.js";
import type { TestCommandOptions } from "./execution.js";

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
  if ([options.run, options.acknowledgeLinkedTests,
    (options.add?.length ?? 0) > 0, (options.addJson?.length ?? 0) > 0,
    (options.remove?.length ?? 0) > 0, (options.removeIndex?.length ?? 0) > 0].some(Boolean)) {
    throw new PmCliError("Edit linked-test metadata separately from additions, removals, execution and trust acknowledgement", EXIT_CODE.USAGE);
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

/** Validate and normalize explicit metadata fields before deriving a patch that retains creation provenance. */
function applyPatch(test: LinkedTest, patch: LinkedTestMetadataPatch): { test: LinkedTest; fields: string[] } {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new PmCliError("Linked-test metadata patch must be a JSON object", EXIT_CODE.USAGE);
  }
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((key) => !STRUCTURED_LINKED_TEST_KEYS.includes(key as typeof STRUCTURED_LINKED_TEST_KEYS[number]) || ["command", "cmd", "timeout"].includes(key))) {
    throw new PmCliError("Patch explicit linked-test metadata fields; command, aliases and provenance cannot be edited", EXIT_CODE.USAGE);
  }
  if (patch.scope === null) throw new PmCliError("scope is required and cannot be cleared", EXIT_CODE.USAGE);
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
