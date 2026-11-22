/** @module sdk/runtime/mutation-admission Reject native client mutation typos before dispatch. */
import { readRuntimeFieldOptionValue } from "../../core/schema/runtime-field-values.js";
import { resolveRuntimeFieldRegistry, runtimeFieldOptionTarget } from "../../core/schema/runtime-schema.js";
import { readSettings } from "../../core/store/settings.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { PmCliError } from "../../core/shared/errors.js";
import { levenshteinDistanceWithinLimit } from "../../core/shared/levenshtein.js";
import { CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS, UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS } from "../cli-contracts/commander-mutation-options.js";
import { LIST_COMMANDER_STRING_OPTION_CONTRACTS } from "../cli-contracts/commander-types.js";
import { CREATE_FLAG_CONTRACTS, LIST_FILTER_FLAG_CONTRACTS, UPDATE_FLAG_CONTRACTS } from "../cli-contracts/flag-contracts.js";
import { isMcpMutationTransportInput, isRuntimeRecord, UPDATE_MANY_FLAT_CONTROL_KEYS } from "../runtime-input.js";

/** Refuse a key with a bounded nearest-name hint and an explicit no-write guarantee. */
function refuseKey(action: string, key: string, allowed: Set<string>, misplaced = false): never {
  const suggestion = [...allowed].map((candidate) => ({ candidate, distance: levenshteinDistanceWithinLimit(key, candidate, 3) }))
    .filter((entry): entry is { candidate: string; distance: number } => entry.distance !== null)
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))[0]?.candidate;
  const correction = misplaced ? `Put mutation fields under options (options.${key}).` : suggestion ? `Did you mean "${suggestion}"?` : "Use the declared command options or the field option for registered item fields.";
  throw new PmCliError(`Unknown ${action} ${misplaced ? "argument" : "option"} "${key}". ${correction} No changes were made.`, 2, {
    code: "invalid_argument_value", reason: "unknown_mutation_option", changed: false, field: key,
    required: correction, nextSteps: [correction],
  });
}

const OUTPUT_KEYS = ["outputInclude", "outputLimit", "outputBudget", "outputFormat", "outputSession", "outputCursor"];

/** Every declared option spelling of a native create or update, including its aliases and run controls. */
function declaredMutationOptionKeys(action: "create" | "update"): Set<string> {
  const contracts = action === "create" ? CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS : UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS;
  const flags = action === "create" ? CREATE_FLAG_CONTRACTS : UPDATE_FLAG_CONTRACTS;
  const flagKeys = flags.map(({ flag }) => flag.slice(2).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase()));
  return new Set([...contracts.flatMap((contract) => [contract.target, ...contract.keys]), ...flagKeys, "author", "message", "force", "fullChangedFields", "idOnly", ...OUTPUT_KEYS]);
}

/** Refuse a caller's options value that is present but not a record. */
function assertOptionsRecord(rawOptions: unknown): asserts rawOptions is Record<string, unknown> | undefined {
  if (rawOptions !== undefined && !isRuntimeRecord(rawOptions)) {
    throw new PmCliError("Mutation options must be an object. No changes were made.", 2, { code: "invalid_argument_value", changed: false });
  }
}

type RuntimeFieldAdmissionCommand = "create" | "update" | "update_many" | "list";

/** Whether a key is read as an option of some runtime schema field declared for the command. */
async function runtimeFieldOptionReader(command: RuntimeFieldAdmissionCommand, pmRoot: string | undefined): Promise<{ targets: string[]; reads: (key: string) => boolean }> {
  const registry = resolveRuntimeFieldRegistry((await readSettings(resolvePmRoot(process.cwd(), pmRoot))).schema);
  const fields = registry.command_to_fields.get(command) ?? [];
  return { targets: fields.map((field) => runtimeFieldOptionTarget(field)), reads: (key) => fields.some((field) => readRuntimeFieldOptionValue({ [key]: true }, field) === true) };
}

/** Refuse each undeclared key that is no runtime schema field option of the command, naming it. */
async function refuseUndeclaredKeys(action: string, command: RuntimeFieldAdmissionCommand, keys: Iterable<string>, allowed: Set<string>, pmRoot: string | undefined, refuse: (key: string, allowed: Set<string>) => never = (key, declared) => refuseKey(action, key, declared)): Promise<void> {
  const unknown = [...keys].filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;
  const runtime = await runtimeFieldOptionReader(command, pmRoot);
  for (const target of runtime.targets) allowed.add(target);
  for (const key of unknown) if (!runtime.reads(key)) refuse(key, allowed);
}

/** Validate only native create/update clients; MCP retains its declared transport admission. */
export async function assertNativeMutationOptions(
  action: "create" | "update",
  args: Record<string, unknown>,
  options: Record<string, unknown>,
  pmRoot: string | undefined,
  hoistedKeys: readonly string[],
): Promise<void> {
  if (isMcpMutationTransportInput(args)) return;
  const allowed = declaredMutationOptionKeys(action);
  const topLevel = new Set(["action", "options", "path", "cwd", "author", "force", "noExtensions", "no_extensions", "fullChangedFields", "idOnly", ...OUTPUT_KEYS, ...hoistedKeys, ...(action === "update" ? ["id"] : [])]);
  for (const key of Object.keys(args)) if (!topLevel.has(key)) refuseKey(action, key, allowed, allowed.has(key));
  const rawOptions = args.options;
  assertOptionsRecord(rawOptions);
  await refuseUndeclaredKeys(action, action, new Set([...Object.keys(rawOptions ?? {}), ...Object.keys(options)]), allowed, pmRoot);
}

/** Exact flat selectors a list record replaces; a schema field that merely starts with "filter" is an update field. */
const FLAT_SELECTION_KEYS = new Set([...UPDATE_MANY_FLAT_CONTROL_KEYS].filter((key) => key !== "filterStatus" && (key.startsWith("filter") || key === "ids" || key === "limit" || key === "offset")));

const camelKey = (key: string): string => key.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());

/**
 * List options only a list command applies, each with the bulk spelling that does what it names:
 * an intent becomes a row limit there, and `all` or `status` a status selection. The bulk planner
 * reads rows directly, so each would be carried unread while the write reached other rows.
 */
const LIST_COMMAND_ONLY_KEYS = new Map([
  ["for", "Bound the selection with list.limit."],
  ["tokenBudget", "Bound the selection with list.limit."],
  ["token_budget", "Bound the selection with list.limit."],
  ["all", 'State the status selection as filterStatus: "all" beside the list record.'],
  ["status", "State the status selection as filterStatus beside the list record."],
]);

/** Projection options the bulk planner clears before it reads rows; harmless, unless a runtime field filters under the same name. */
const PLANNER_CLEARED_LIST_KEYS = ["compact", "brief", "fields", "includeBody", "full"];

/** Refuse a cleared projection key that a runtime schema field reads as its list filter: the filter would not be applied. */
async function refuseClearedRuntimeFilters(list: Record<string, unknown>, pmRoot: string | undefined): Promise<void> {
  const cleared = PLANNER_CLEARED_LIST_KEYS.filter((key) => Object.hasOwn(list, key));
  if (cleared.length === 0) return;
  const runtime = await runtimeFieldOptionReader("list", pmRoot);
  for (const key of cleared) {
    if (runtime.reads(key)) refuseUnread(`update-many "list.${key}" is not read beside this selection.`, `list.${key}`, "The bulk selection clears this list option, so the schema field's filter under that name is not applied; select the rows another way.");
  }
}

/** Selectors of the SDK list contract that have no CLI flag. */
const SDK_LIST_SELECTOR_KEYS = ["excludeTerminal", "lifecycleBucket", "dependencyBlocked"];

/**
 * Every key the bulk planner's list read applies from a list record: each declared list flag
 * (a negated flag under its positive key), every alias the list option reader accepts, and the
 * SDK-only selectors; the options only a list command applies are left out.
 */
function listRecordKeys(): Set<string> {
  const flagKeys = LIST_FILTER_FLAG_CONTRACTS.map(({ flag }) => flag.replace(/^--(?:no-)?/u, "").replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase()));
  const keys = new Set([...flagKeys, ...LIST_COMMANDER_STRING_OPTION_CONTRACTS.flatMap((contract) => contract.keys), "filterEstimateMissing", ...SDK_LIST_SELECTOR_KEYS]);
  for (const key of LIST_COMMAND_ONLY_KEYS.keys()) keys.delete(key);
  return keys;
}

/** One refusal shape for a key the bulk path would not read where the caller put it. */
function refuseUnread(message: string, field: string, required: string, reason = "unknown_mutation_option"): never {
  throw new PmCliError(`${message} ${required} No changes were made.`, 2, { code: "invalid_argument_value", reason, changed: false, field, required, nextSteps: [required] });
}

/** Update fields the bulk path applies: a single update's options without its item operand and CLI input sources. */
function updateManyFieldKeys(): Set<string> {
  const fields = declaredMutationOptionKeys("update");
  // A single update's item operand; the bulk path would read no selection from it.
  fields.delete("id");
  // Input-source flags are read by the CLI adapter; the bulk runner would apply nothing from them.
  for (const key of fields) if (/File$|^stdin/u.test(key)) fields.delete(key);
  fields.add("documentAnnotationSnapshot");
  return fields;
}

/**
 * A container that is present but no record would be read as absent: an unfiltered selection, or
 * no nested fields. A null is left to the typed-null rule, which names it.
 */
function assertBulkContainers(options: Record<string, unknown>): void {
  for (const container of ["list", "update"]) {
    const value = options[container];
    if (value !== undefined && value !== null && !isRuntimeRecord(value)) {
      refuseUnread(`update-many "${container}" must be an object.`, container, `Pass ${container} as an object, or omit it.`, "invalid_mutation_option_value");
    }
  }
}

/**
 * One selection, stated in one place: a list record replaces every flat selector, and `id` is a
 * single update's operand. Any other key must be one
 * the bulk planner's list read applies or a list filter of a runtime schema field; a misspelled
 * selector, or an option only a list command applies, would otherwise be carried unread
 * and widen the write to every row the remaining selectors match.
 */
async function assertListRecord(list: Record<string, unknown>, outerKeys: Set<string>, pmRoot: string | undefined): Promise<void> {
  if (Object.hasOwn(list, "id")) refuseKey("update-many list", "id", new Set(["ids"]));
  // The planner overwrites the list record's status with filterStatus, so no schema field can claim this key.
  if (Object.hasOwn(list, "status")) refuseUnread('update-many "list.status" is not read beside this selection.', "list.status", LIST_COMMAND_ONLY_KEYS.get("status")!);
  const flat = [...outerKeys].find((key) => FLAT_SELECTION_KEYS.has(key));
  if (flat !== undefined) refuseUnread(`update-many "${flat}" is not read beside this selection.`, flat, `Put the selection inside list, or drop the list record; a flat "${flat}" beside it is not read.`);
  await refuseClearedRuntimeFilters(list, pmRoot);
  // A runtime schema field that shares one of the other names is that tracker's list filter and stays accepted.
  await refuseUndeclaredKeys("update-many list", "list", Object.keys(list), listRecordKeys(), pmRoot, (key, allowed) => {
    const required = LIST_COMMAND_ONLY_KEYS.get(key);
    if (required === undefined) refuseKey("update-many list", key, allowed);
    refuseUnread(`update-many "list.${key}" is not read beside this selection.`, `list.${key}`, required);
  });
}

/** Beside a nested update record an outer key selects rows, controls the run or states its attribution. */
function assertOuterKeysBesideNestedUpdate(outerKeys: Set<string>, controls: Set<string>, fields: Set<string>): void {
  for (const key of outerKeys) {
    if (controls.has(key)) continue;
    if (fields.has(key)) refuseUnread(`Unknown update-many option "${key}".`, key, `Put update fields inside update (update.${key}); beside a nested update record an outer key selects rows or controls the run.`);
    refuseKey("update-many", key, controls);
  }
}

/**
 * Refuse an undeclared update-many key by name before any row changes (pm-xp7ldt), as a single
 * update refuses it. The caller's own keys are read before normalization copies them, so a key a
 * copy would lose is still judged. The allowlist is the bulk path's own: `id` selects nothing
 * there (`ids` does) in the flat payload or a nested `list` record, and a nested
 * `update` record carries every field, so beside it an outer key must select rows, control the
 * run or state its attribution. Only a runtime schema field declared for `update_many` is applied
 * by the bulk path, so only those are admitted. MCP retains its declared transport admission.
 */
export async function assertNativeUpdateManyOptions(
  args: Record<string, unknown>,
  options: Record<string, unknown>,
  pmRoot: string | undefined,
): Promise<void> {
  if (isMcpMutationTransportInput(args)) return;
  const rawOptions = args.options;
  assertOptionsRecord(rawOptions);
  const fields = updateManyFieldKeys();
  const controls = new Set([...UPDATE_MANY_FLAT_CONTROL_KEYS, "author", "message", "force", "fullChangedFields", "idOnly", ...OUTPUT_KEYS]);
  const everyOption = new Set([...fields, ...controls]);
  // A top-level force is not read by the bulk handler; it is refused with its options.force placement.
  const topLevel = new Set(["action", "options", "path", "cwd", "author", "noExtensions", "no_extensions", "fullChangedFields", "idOnly", ...OUTPUT_KEYS]);
  for (const key of Object.keys(args)) if (!topLevel.has(key)) refuseKey("update-many", key, everyOption, everyOption.has(key));
  // Only output controls are read under a snake_case spelling; a selection key spelled that way would select nothing.
  const outerKeys = new Set([...Object.keys(rawOptions ?? {}), ...Object.keys(options)].map((key) => (OUTPUT_KEYS.includes(camelKey(key)) ? camelKey(key) : key)));
  assertBulkContainers(options);
  if (isRuntimeRecord(options.list)) await assertListRecord(options.list, outerKeys, pmRoot);
  if (!isRuntimeRecord(options.update)) {
    await refuseUndeclaredKeys("update-many", "update_many", outerKeys, everyOption, pmRoot);
    return;
  }
  assertOuterKeysBesideNestedUpdate(outerKeys, controls, fields);
  await refuseUndeclaredKeys("update-many", "update_many", Object.keys(options.update), fields, pmRoot);
}
